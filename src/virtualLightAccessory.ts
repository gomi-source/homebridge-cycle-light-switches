import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { LightConfig, CycleLightSwitchesPlatform } from './platform.js';

/** Distinguishes each stateless switch service's subtype on the light's own accessory
 * (stateful switches don't need this — they're one-per-accessory, no subtype needed). */
const SWITCH_SUBTYPE_PREFIX = 'switch-';

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

/** Something that can physically fire one of the light's switches. Implemented either
 * inline (stateless switches, on this same accessory) or by a set of standalone
 * VirtualSwitchAccessory instances, one per switch (stateful switches — see platform.ts
 * for why each gets its own accessory). */
interface SwitchBank {
  fireSwitch(switchNumber: number): void;
}

/**
 * VirtualLightAccessory
 *
 * Represents one virtual on/off light (a HAP Lightbulb service exposing only the On
 * characteristic — nothing else lives on this accessory, so it stays a single, direct-tap
 * tile in the Home app; see platform.ts for why). Every time its On characteristic is set
 * to `true` — regardless of whether it was already on, e.g. because an automation
 * re-fired "turn on" — the next switch in the rotation fires. The rotation position is
 * persisted in accessory.context; optionally it can be reset back to the start whenever
 * the light is turned off (`resetCountOnOff`), and the light can optionally turn itself
 * back off as soon as the last switch in the cycle fires (`turnOffOnCycleComplete`).
 *
 * By default the switches are stateless, single-press-only HAP `StatelessProgrammableSwitch`
 * services living right here on this same accessory (grouped under a ServiceLabel when
 * there's more than one) — HomeKit's closest equivalent to a Matter "Generic Switch"
 * configured for single press. When `statefulSwitches` is enabled, each switch instead
 * moves to its own standalone VirtualSwitchAccessory (attached via `attachSwitchBank`),
 * exposed as an ordinary settable HAP `Switch` service: still momentary, but now a scene
 * or automation can turn a *specific* switch on directly, which jumps the rotation to it
 * via `jumpToSwitch` — the next "on" always fires the one after it, regardless of where
 * the rotation was before.
 */
export class VirtualLightAccessory {
  private readonly light: LightConfig;
  private readonly state: PersistedState;

  private lightService!: Service;

  // Stateless mode only: the switch services live on this accessory.
  private inlineSwitchServices: Service[] = [];

  // Stateful mode only: switches live on a separate accessory, reached through this.
  private switchBank?: SwitchBank;

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

    if (this.light.statefulSwitches) {
      // Switches live on a separate accessory now; strip out any left behind on this one
      // from before `statefulSwitches` was enabled (or from the single-accessory design
      // used before this accessory split existed).
      this.removeInlineSwitchServices();
    } else {
      this.setupInlineSwitches();
    }
  }

  /** Wires up the companion switch-bank accessory for a `statefulSwitches` light. Called
   * by the platform right after constructing both accessories. */
  attachSwitchBank(bank: SwitchBank) {
    this.switchBank = bank;
  }

  private setupAccessoryInformation() {
    const { Service, Characteristic } = this.platform;

    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Cycle Light Switches')
      .setCharacteristic(Characteristic.Model, 'On/Off Light')
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
   * Sets up `switchCount` stateless, single-press-only switches on this same accessory.
   * Grouped under a Service Label when there's more than one, which is the standard
   * HomeKit pattern for exposing several buttons on one accessory.
   */
  private setupInlineSwitches() {
    const { Service, Characteristic } = this.platform;
    const count = Math.max(1, this.light.switchCount);

    let labelService: Service | undefined;
    if (count > 1) {
      labelService = this.accessory.getService(Service.ServiceLabel)
        || this.accessory.addService(Service.ServiceLabel);
      labelService.setCharacteristic(
        Characteristic.ServiceLabelNamespace,
        Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS,
      );
    } else {
      const existingLabel = this.accessory.getService(Service.ServiceLabel);
      if (existingLabel) {
        this.accessory.removeService(existingLabel);
      }
    }

    this.inlineSwitchServices = [];

    for (let i = 1; i <= count; i++) {
      const subtype = `${SWITCH_SUBTYPE_PREFIX}${i}`;
      const name = this.light.switchNames?.[i - 1] || `${this.light.name} Switch ${i}`;

      const service = this.accessory.getServiceById(Service.StatelessProgrammableSwitch, subtype)
        || this.accessory.addService(Service.StatelessProgrammableSwitch, name, subtype);

      service.setCharacteristic(Characteristic.Name, name);
      service.setCharacteristic(Characteristic.ServiceLabelIndex, i);

      // Restrict to single-press only, since that's all this plugin ever fires.
      service.getCharacteristic(Characteristic.ProgrammableSwitchEvent)
        .setProps({ validValues: [Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS] });

      labelService?.addLinkedService(service);

      this.inlineSwitchServices.push(service);
    }

    // Clean up leftover switch services from a previously larger switchCount.
    for (const service of this.accessory.services) {
      if (service.UUID !== Service.StatelessProgrammableSwitch.UUID) {
        continue;
      }
      const index = Number((service.subtype ?? '').replace(SWITCH_SUBTYPE_PREFIX, ''));
      if (!Number.isFinite(index) || index < 1 || index > count) {
        this.accessory.removeService(service);
      }
    }
  }

  /** Removes any switch-related services from this accessory (stateful mode: they belong
   * on the separate switch-bank accessory instead). */
  private removeInlineSwitchServices() {
    const { Service } = this.platform;

    for (const service of this.accessory.services) {
      const isSwitchService = service.UUID === Service.StatelessProgrammableSwitch.UUID
        || service.UUID === Service.Switch.UUID
        || service.UUID === Service.ServiceLabel.UUID;
      if (isSwitchService) {
        this.accessory.removeService(service);
      }
    }

    this.inlineSwitchServices = [];
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
    const switchCount = Math.max(1, this.light.switchCount);

    if (turningOn) {
      this.state.count += 1;
      const switchIndex = (this.state.count - 1) % switchCount;
      const switchNumber = switchIndex + 1;
      const isLastInCycle = switchIndex === switchCount - 1;

      this.platform.log.info(
        `${this.light.name}: turned on (activation #${this.state.count}) → firing switch ${switchNumber} of ${switchCount}`,
      );

      this.fireSwitch(switchNumber);

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
   * Called by the switch-bank accessory (stateful mode only) when a scene, automation, or
   * Home app tap turns one specific switch on directly. Jumps the rotation to that
   * switch — regardless of where it was before — so the *next* time the light is turned
   * on, it fires the switch that follows this one.
   */
  jumpToSwitch(switchNumber: number) {
    const switchCount = Math.max(1, this.light.switchCount);
    const nextSwitch = (switchNumber % switchCount) + 1;

    this.platform.log.info(
      `${this.light.name}: switch ${switchNumber} triggered directly → next "on" will fire switch ${nextSwitch} of ${switchCount}`,
    );

    this.state.count = switchNumber;
    this.persistState();
  }

  /** Fires switch `switchNumber` (1-based): via the external switch bank (stateful mode),
   * or a single-press event on this accessory's own switch service (stateless mode). */
  private fireSwitch(switchNumber: number) {
    if (this.switchBank) {
      this.switchBank.fireSwitch(switchNumber);
      return;
    }

    const service = this.inlineSwitchServices[switchNumber - 1];
    service.updateCharacteristic(
      this.platform.Characteristic.ProgrammableSwitchEvent,
      this.platform.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
    );
  }

  private persistState() {
    this.accessory.context.state = this.state;
    this.platform.api.updatePlatformAccessories([this.accessory]);
  }
}
