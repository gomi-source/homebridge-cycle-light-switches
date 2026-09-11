import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { LightConfig, CycleLightSwitchesPlatform } from './platform.js';

/**
 * The only thing that needs to survive Homebridge restarts. Stored on
 * `accessory.context.state`, which Homebridge persists to its accessory cache on disk,
 * so the rotation position is kept indefinitely (until the light is removed/renamed).
 */
interface PersistedState {
  /**
   * The number of the switch that last fired (1-based). The next light "on" fires
   * `(count % switchCount) + 1`. Also doubles as a monotonically increasing activation
   * count when nothing has jumped the rotation, purely for logging purposes.
   */
  count: number;
  /** Last known on/off value, used to answer HomeKit "get" requests. */
  on: boolean;
}

const SWITCH_SUBTYPE_PREFIX = 'switch-';

/** How long a stateful switch stays "on" after firing before it reverts to "off" on its
 * own, so it behaves as a momentary trigger — a scene or automation can turn it on again
 * (and a manual Home app tap can turn it back on) without needing something else to turn
 * it off first. */
const STATEFUL_SWITCH_RESET_MS = 1000;

/**
 * VirtualLightAccessory
 *
 * Represents one virtual on/off light plus its `switchCount` switches. Every time the
 * light's On characteristic is set to `true` — regardless of whether it was already on,
 * e.g. because an automation re-fired "turn on" — the next switch in the rotation fires.
 * The rotation position is persisted in accessory.context; optionally it can be reset
 * back to the start whenever the light is turned off (`resetCountOnOff`), and the light
 * can optionally turn itself back off as soon as the last switch in the cycle fires
 * (`turnOffOnCycleComplete`).
 *
 * By default the switches are stateless, single-press-only HAP `StatelessProgrammableSwitch`
 * services — HomeKit's closest equivalent to a Matter "Generic Switch" configured for
 * single press. When `statefulSwitches` is enabled for a light, they're exposed instead as
 * ordinary HAP `Switch` services: still momentary (see STATEFUL_SWITCH_RESET_MS above), but
 * now settable, so a scene or automation can turn a *specific* switch on directly. Doing so
 * jumps the rotation to that switch, so the next "on" always fires the one after it,
 * regardless of where the rotation was before.
 */
export class VirtualLightAccessory {
  private readonly light: LightConfig;
  private readonly state: PersistedState;

  private lightService!: Service;
  private switchServices: Service[] = [];
  private readonly statefulResetTimers = new Map<Service, NodeJS.Timeout>();

  constructor(
    private readonly platform: CycleLightSwitchesPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.light = accessory.context.light as LightConfig;

    const existingState = accessory.context.state as Partial<PersistedState> | undefined;
    this.state = {
      count: existingState?.count ?? 0,
      on: existingState?.on ?? false,
    };
    this.accessory.context.state = this.state;

    this.setupAccessoryInformation();
    this.setupLight();
    this.setupSwitches();
  }

  private setupAccessoryInformation() {
    const { Service, Characteristic } = this.platform;
    const switchLabel = this.light.switchCount === 1 ? 'Switch' : 'Switches';

    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Cycle Light Switches')
      .setCharacteristic(Characteristic.Model, `On/Off Light + ${this.light.switchCount} ${switchLabel}`)
      .setCharacteristic(Characteristic.SerialNumber, this.light.name);
  }

  /** Sets up the on/off-only "light" (HAP Lightbulb service exposing only the On characteristic). */
  private setupLight() {
    const { Service, Characteristic } = this.platform;

    this.lightService = this.accessory.getService(Service.Lightbulb)
      || this.accessory.addService(Service.Lightbulb);

    this.lightService.setCharacteristic(Characteristic.Name, this.light.name);

    this.lightService.getCharacteristic(Characteristic.On)
      .onGet(() => this.state.on)
      .onSet(this.handleSetOn.bind(this));

    // Reflect the restored on/off value immediately after a restart.
    this.lightService.updateCharacteristic(Characteristic.On, this.state.on);
  }

  /**
   * Sets up `switchCount` switches, either stateless (default) or stateful
   * (`statefulSwitches`) — see the class doc comment above for the difference.
   *
   * Stateless switches are grouped under a Service Label when there's more than one,
   * which is the standard HomeKit pattern for exposing several buttons on one accessory
   * (stateful switches don't need this — each is independently named and controllable).
   */
  private setupSwitches() {
    const { Service, Characteristic } = this.platform;
    const count = Math.max(1, this.light.switchCount);
    const stateful = this.light.statefulSwitches;

    const wantedType = stateful ? Service.Switch : Service.StatelessProgrammableSwitch;
    const staleType = stateful ? Service.StatelessProgrammableSwitch : Service.Switch;

    // Drop any switches left over from a previous `statefulSwitches` setting for this light.
    for (const service of this.accessory.services) {
      if (service.UUID === staleType.UUID && (service.subtype ?? '').startsWith(SWITCH_SUBTYPE_PREFIX)) {
        this.clearStatefulResetTimer(service);
        this.accessory.removeService(service);
      }
    }

    // Service Label only applies to grouped stateless switches.
    let labelService: Service | undefined;
    const existingLabel = this.accessory.getService(Service.ServiceLabel);
    if (!stateful && count > 1) {
      labelService = existingLabel || this.accessory.addService(Service.ServiceLabel);
      labelService.setCharacteristic(
        Characteristic.ServiceLabelNamespace,
        Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS,
      );
    } else if (existingLabel) {
      this.accessory.removeService(existingLabel);
    }

    this.switchServices = [];

    for (let i = 1; i <= count; i++) {
      const subtype = `${SWITCH_SUBTYPE_PREFIX}${i}`;
      const name = this.light.switchNames?.[i - 1] || `${this.light.name} Switch ${i}`;

      const service = this.accessory.getServiceById(wantedType, subtype)
        || this.accessory.addService(wantedType, name, subtype);

      service.setCharacteristic(Characteristic.Name, name);

      if (stateful) {
        // Settable: a scene, automation, or Home app tap can turn a specific switch on
        // directly, which jumps the rotation to it (see handleSetSwitchOn).
        service.getCharacteristic(Characteristic.On)
          .onSet(this.handleSetSwitchOn.bind(this, i));
        // Always start "off" — if Homebridge restarted mid-reset, don't strand it "on".
        service.updateCharacteristic(Characteristic.On, false);
      } else {
        service.setCharacteristic(Characteristic.ServiceLabelIndex, i);
        // Restrict to single-press only, since that's all this plugin ever fires.
        service.getCharacteristic(Characteristic.ProgrammableSwitchEvent)
          .setProps({ validValues: [Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS] });
        labelService?.addLinkedService(service);
      }

      this.switchServices.push(service);
    }

    // Clean up leftover switch services from a previously larger switchCount.
    for (const service of this.accessory.services) {
      if (service.UUID !== wantedType.UUID) {
        continue;
      }
      const index = Number((service.subtype ?? '').replace(SWITCH_SUBTYPE_PREFIX, ''));
      if (!Number.isFinite(index) || index < 1 || index > count) {
        this.clearStatefulResetTimer(service);
        this.accessory.removeService(service);
      }
    }
  }

  /**
   * Handles "set" requests for the light's On characteristic — from the Home app, Siri,
   * or an automation. Turning the light on (from any starting state) advances the
   * rotation and fires exactly one switch; turning it off never fires a switch, and only
   * resets the rotation if `resetCountOnOff` is enabled.
   *
   * If `turnOffOnCycleComplete` is enabled and the switch that just fired was the last one
   * in the rotation, the light is immediately switched back off on its own (as if a
   * momentary trigger), applying the same `resetCountOnOff` behavior that a user-initiated
   * off would.
   */
  private async handleSetOn(value: CharacteristicValue) {
    const turningOn = value === true;

    if (turningOn) {
      this.state.count += 1;
      const switchIndex = (this.state.count - 1) % this.switchServices.length;
      const isLastInCycle = switchIndex === this.switchServices.length - 1;

      this.platform.log.info(
        `${this.light.name}: turned on (activation #${this.state.count}) → firing switch ${switchIndex + 1} of ${this.switchServices.length}`,
      );

      this.fireSwitch(switchIndex);

      this.state.on = true;

      if (isLastInCycle && this.light.turnOffOnCycleComplete) {
        this.platform.log.info(`${this.light.name}: cycle complete → turning light back off`);
        this.state.on = false;

        if (this.light.resetCountOnOff) {
          this.state.count = 0;
        }

        // Push the auto-off to HomeKit. This does not re-enter handleSetOn/onSet — it only
        // notifies controllers, the same as any accessory reporting its own state change.
        this.lightService.updateCharacteristic(this.platform.Characteristic.On, false);
      }
    } else {
      this.platform.log.debug(`${this.light.name}: turned off`);
      this.state.on = false;

      if (this.light.resetCountOnOff) {
        this.state.count = 0;
      }
    }

    this.persistState();
  }

  /**
   * Handles a scene, automation, or Home app tap turning one specific stateful switch on
   * directly (only wired up when `statefulSwitches` is enabled). This jumps the rotation
   * to that switch — regardless of where it was before — so the *next* time the light is
   * turned on, it fires the switch that follows this one.
   */
  private async handleSetSwitchOn(switchNumber: number, value: CharacteristicValue) {
    if (value !== true) {
      // Ignore explicit "off" writes; our own auto-reset (see scheduleStatefulSwitchReset)
      // already turns it back off, and that uses updateCharacteristic, not a "set" — so it
      // never reaches here.
      return;
    }

    const switchCount = this.switchServices.length;
    const nextSwitch = (switchNumber % switchCount) + 1;

    this.platform.log.info(
      `${this.light.name}: switch ${switchNumber} triggered directly → next "on" will fire switch ${nextSwitch} of ${switchCount}`,
    );

    this.state.count = switchNumber;
    this.persistState();

    this.scheduleStatefulSwitchReset(this.switchServices[switchNumber - 1]);
  }

  /** Fires switch `switchIndex` (0-based): a single-press event, or a momentary on/off
   * pulse, depending on `statefulSwitches`. */
  private fireSwitch(switchIndex: number) {
    const service = this.switchServices[switchIndex];

    if (this.light.statefulSwitches) {
      service.updateCharacteristic(this.platform.Characteristic.On, true);
      this.scheduleStatefulSwitchReset(service);
    } else {
      service.updateCharacteristic(
        this.platform.Characteristic.ProgrammableSwitchEvent,
        this.platform.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
      );
    }
  }

  /** Turns a stateful switch back off after STATEFUL_SWITCH_RESET_MS, so it behaves as a
   * momentary trigger rather than a toggle that stays on. Restarts the timer if the same
   * switch fires again before the previous one elapsed. */
  private scheduleStatefulSwitchReset(service: Service) {
    this.clearStatefulResetTimer(service);

    const timer = setTimeout(() => {
      this.statefulResetTimers.delete(service);
      service.updateCharacteristic(this.platform.Characteristic.On, false);
    }, STATEFUL_SWITCH_RESET_MS);

    this.statefulResetTimers.set(service, timer);
  }

  private clearStatefulResetTimer(service: Service) {
    const timer = this.statefulResetTimers.get(service);
    if (timer) {
      clearTimeout(timer);
      this.statefulResetTimers.delete(service);
    }
  }

  private persistState() {
    this.accessory.context.state = this.state;
    this.platform.api.updatePlatformAccessories([this.accessory]);
  }
}
