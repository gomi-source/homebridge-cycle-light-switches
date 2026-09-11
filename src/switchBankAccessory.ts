import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { LightConfig, CycleLightSwitchesPlatform } from './platform.js';

export const SWITCH_SUBTYPE_PREFIX = 'switch-';

/** See STATEFUL_SWITCH_RESET_MS in virtualLightAccessory.ts for the rationale. */
const STATEFUL_SWITCH_RESET_MS = 1000;

/**
 * VirtualSwitchBankAccessory
 *
 * The companion accessory for a light with `statefulSwitches` enabled: holds all of that
 * light's switches as ordinary, settable HAP `Switch` services, one accessory per light
 * (not per switch), so the Home app groups them together under a single entry that opens
 * to show each one. Kept separate from the light's own accessory specifically so the
 * light stays a single-tap tile — see the comment on CycleLightSwitchesPlatform.
 *
 * Firing a switch — whether because the light's cycle naturally reached it (`fireSwitch`,
 * called from VirtualLightAccessory) or because it was triggered directly here — turns it
 * on, then back off again after STATEFUL_SWITCH_RESET_MS, so it always behaves as a
 * momentary trigger rather than a toggle that's left on.
 */
export class VirtualSwitchBankAccessory {
  private switchServices: Service[] = [];
  private readonly resetTimers = new Map<Service, NodeJS.Timeout>();

  constructor(
    private readonly platform: CycleLightSwitchesPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly light: LightConfig,
    /** Called when a switch is triggered directly (not by the light's own cycle), with
     * its 1-based number, so the light can jump its rotation to it. */
    private readonly onSwitchTriggered: (switchNumber: number) => void,
  ) {
    this.setupAccessoryInformation();
    this.setupSwitches();
  }

  private setupAccessoryInformation() {
    const { Service, Characteristic } = this.platform;
    const count = Math.max(1, this.light.switchCount);
    const switchLabel = count === 1 ? 'Switch' : 'Switches';

    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Cycle Light Switches')
      .setCharacteristic(Characteristic.Model, `${count} Stateful ${switchLabel}`)
      .setCharacteristic(Characteristic.SerialNumber, `${this.light.name}-switches`);
  }

  private setupSwitches() {
    const { Service, Characteristic } = this.platform;
    const count = Math.max(1, this.light.switchCount);

    this.switchServices = [];

    for (let i = 1; i <= count; i++) {
      const subtype = `${SWITCH_SUBTYPE_PREFIX}${i}`;
      const name = this.light.switchNames?.[i - 1] || `${this.light.name} Switch ${i}`;

      const service = this.accessory.getServiceById(Service.Switch, subtype)
        || this.accessory.addService(Service.Switch, name, subtype);

      service.setCharacteristic(Characteristic.Name, name);

      service.getCharacteristic(Characteristic.On)
        .onSet(this.handleSetOn.bind(this, i));

      // Always start "off" — if Homebridge restarted mid-reset, don't strand it "on".
      service.updateCharacteristic(Characteristic.On, false);

      this.switchServices.push(service);
    }

    // Clean up leftover switch services from a previously larger switchCount.
    for (const service of this.accessory.services) {
      if (service.UUID !== Service.Switch.UUID) {
        continue;
      }
      const index = Number((service.subtype ?? '').replace(SWITCH_SUBTYPE_PREFIX, ''));
      if (!Number.isFinite(index) || index < 1 || index > count) {
        this.clearResetTimer(service);
        this.accessory.removeService(service);
      }
    }
  }

  /** Handles a scene, automation, or Home app tap turning one specific switch on directly. */
  private async handleSetOn(switchNumber: number, value: CharacteristicValue) {
    if (value !== true) {
      // Ignore explicit "off" writes; our own auto-reset already turns it back off via
      // updateCharacteristic, which never re-enters this handler.
      return;
    }

    this.onSwitchTriggered(switchNumber);
    this.scheduleReset(this.switchServices[switchNumber - 1]);
  }

  /** Fires switch `switchNumber` (1-based) because the light's own cycle reached it. */
  fireSwitch(switchNumber: number) {
    const service = this.switchServices[switchNumber - 1];
    service.updateCharacteristic(this.platform.Characteristic.On, true);
    this.scheduleReset(service);
  }

  private scheduleReset(service: Service) {
    this.clearResetTimer(service);

    const timer = setTimeout(() => {
      this.resetTimers.delete(service);
      service.updateCharacteristic(this.platform.Characteristic.On, false);
    }, STATEFUL_SWITCH_RESET_MS);

    this.resetTimers.set(service, timer);
  }

  private clearResetTimer(service: Service) {
    const timer = this.resetTimers.get(service);
    if (timer) {
      clearTimeout(timer);
      this.resetTimers.delete(service);
    }
  }
}
