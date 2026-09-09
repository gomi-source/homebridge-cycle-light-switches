import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { LightConfig, VirtualLightSwitchesPlatform } from './platform.js';

/**
 * The only thing that needs to survive Homebridge restarts. Stored on
 * `accessory.context.state`, which Homebridge persists to its accessory cache on disk,
 * so the rotation position is kept indefinitely (until the light is removed/renamed).
 */
interface PersistedState {
  /** Total number of times the light has been turned on since the counter last reset. */
  count: number;
  /** Last known on/off value, used to answer HomeKit "get" requests. */
  on: boolean;
}

const SWITCH_SUBTYPE_PREFIX = 'switch-';

/**
 * VirtualLightAccessory
 *
 * Represents one virtual on/off light plus its `switchCount` stateless single-press
 * switches. Every time the light's On characteristic is set to `true` — regardless of
 * whether it was already on, e.g. because an automation re-fired "turn on" — the next
 * switch in the rotation fires a single-press event. The rotation position is a
 * monotonically increasing counter persisted in accessory.context; optionally it can be
 * reset back to the start whenever the light is turned off (`resetCountOnOff`), and the
 * light can optionally turn itself back off as soon as the last switch in the cycle fires
 * (`turnOffOnCycleComplete`).
 */
export class VirtualLightAccessory {
  private readonly light: LightConfig;
  private readonly state: PersistedState;

  private lightService!: Service;
  private switchServices: Service[] = [];

  constructor(
    private readonly platform: VirtualLightSwitchesPlatform,
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
      .setCharacteristic(Characteristic.Manufacturer, 'Virtual Light Switches')
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
   * Sets up `switchCount` stateless, single-press-only switches (HAP
   * StatelessProgrammableSwitch, restricted to the SINGLE_PRESS event — HomeKit's closest
   * equivalent to a Matter "Generic Switch" configured for single press).
   *
   * When more than one switch is configured, they're grouped under a Service Label, which
   * is the standard HomeKit pattern for exposing several buttons on one accessory.
   */
  private setupSwitches() {
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
      // Only one switch: no grouping needed. Remove a label left over from a config change.
      const existingLabel = this.accessory.getService(Service.ServiceLabel);
      if (existingLabel) {
        this.accessory.removeService(existingLabel);
      }
    }

    this.switchServices = [];

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

      this.switchServices.push(service);
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
      const targetSwitch = this.switchServices[switchIndex];
      const isLastInCycle = switchIndex === this.switchServices.length - 1;

      this.platform.log.info(
        `${this.light.name}: turned on (activation #${this.state.count}) → firing switch ${switchIndex + 1} of ${this.switchServices.length}`,
      );

      targetSwitch.updateCharacteristic(
        this.platform.Characteristic.ProgrammableSwitchEvent,
        this.platform.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
      );

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

  private persistState() {
    this.accessory.context.state = this.state;
    this.platform.api.updatePlatformAccessories([this.accessory]);
  }
}
