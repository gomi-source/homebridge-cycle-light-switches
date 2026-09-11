import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { CycleLightSwitchesPlatform } from './platform.js';

/** See STATEFUL_SWITCH_RESET_MS in virtualLightAccessory.ts for the rationale. */
const STATEFUL_SWITCH_RESET_MS = 1000;

/**
 * VirtualSwitchAccessory
 *
 * One stateful switch, one standalone accessory (used only when a light has
 * `statefulSwitches` enabled — see platform.ts). Each switch gets its own accessory,
 * deliberately not sharing one with its siblings: a `Switch` service has no naming
 * characteristic beyond its plain `Name`, and once several of them share an accessory,
 * the Home app's automation picker falls back to labelling all of them with the shared
 * accessory's name — there's nothing left to tell them apart with. A standalone,
 * single-service accessory has no such ambiguity: its accessory name *is* the switch's
 * name everywhere in Home (room tiles, automation pickers, Siri).
 *
 * Firing it — whether because the light's own cycle reached it (`fire`, called from
 * VirtualLightAccessory) or because it was triggered directly here — turns it on, then
 * back off again after STATEFUL_SWITCH_RESET_MS, so it always behaves as a momentary
 * trigger rather than a toggle that's left on.
 */
export class VirtualSwitchAccessory {
  private service!: Service;
  private resetTimer?: NodeJS.Timeout;

  constructor(
    private readonly platform: CycleLightSwitchesPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly switchNumber: number,
    private readonly switchName: string,
    /** Called when this switch is triggered directly (not by the light's own cycle), so
     * the light can jump its rotation to it. */
    private readonly onTriggered: () => void,
  ) {
    this.setupAccessoryInformation();
    this.setupSwitch();
  }

  private setupAccessoryInformation() {
    const { Service, Characteristic } = this.platform;

    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Cycle Light Switches')
      .setCharacteristic(Characteristic.Model, 'Stateful Switch')
      .setCharacteristic(Characteristic.SerialNumber, `${this.switchName}-${this.switchNumber}`);
  }

  private setupSwitch() {
    const { Service, Characteristic } = this.platform;

    this.service = this.accessory.getService(Service.Switch)
      || this.accessory.addService(Service.Switch);

    this.service.setCharacteristic(Characteristic.Name, this.switchName);

    this.service.getCharacteristic(Characteristic.On)
      .onSet(this.handleSetOn.bind(this));

    // Always start "off" — if Homebridge restarted mid-reset, don't strand it "on".
    this.service.updateCharacteristic(Characteristic.On, false);
  }

  /** Handles a scene, automation, or Home app tap turning this switch on directly. */
  private async handleSetOn(value: CharacteristicValue) {
    if (value !== true) {
      // Ignore explicit "off" writes; our own auto-reset already turns it back off via
      // updateCharacteristic, which never re-enters this handler.
      return;
    }

    this.onTriggered();
    this.scheduleReset();
  }

  /** Fires this switch because the light's own cycle reached it. */
  fire() {
    this.service.updateCharacteristic(this.platform.Characteristic.On, true);
    this.scheduleReset();
  }

  private scheduleReset() {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
    }

    this.resetTimer = setTimeout(() => {
      this.resetTimer = undefined;
      this.service.updateCharacteristic(this.platform.Characteristic.On, false);
    }, STATEFUL_SWITCH_RESET_MS);
  }
}
