import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { CycleLightSwitchesPlatform } from './platform.js';

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
 * Exactly one switch per light is ever "on" — whichever one the rotation is currently
 * sitting on — and it stays on until the rotation moves elsewhere, rather than pulsing
 * on and off like a momentary trigger. That matters for scenes in particular: a Home
 * scene can only capture and re-apply explicit target states, so a switch that reverted
 * itself a moment later made the scene that had just set it look "off" again, even
 * though the jump it triggered had already taken effect. Turning a switch on directly
 * still jumps the rotation to it (`onTriggered`, below) exactly as before.
 */
export class VirtualSwitchAccessory {
  private service!: Service;

  constructor(
    private readonly platform: CycleLightSwitchesPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly switchNumber: number,
    private readonly switchName: string,
    /** Called when this switch is turned on directly (not by the light's own cycle), so
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

    // The platform sets the correct restored value right after construction (see
    // platform.ts), once every switch for this light exists to compare against.
    this.service.updateCharacteristic(Characteristic.On, false);
  }

  /**
   * Handles a scene, automation, or Home app tap turning this switch on directly.
   * Turning one off directly is accepted as-is and doesn't move the rotation — nothing
   * turns it back on except the light's own cycle reaching it again, or another switch
   * being jumped to directly.
   */
  private async handleSetOn(value: CharacteristicValue) {
    if (value === true) {
      this.onTriggered();
    }
  }

  /** Sets this switch's displayed state directly, without invoking `onSet` — used by the
   * platform to keep exactly one switch per light "on" at a time. */
  setOn(value: boolean) {
    this.service.updateCharacteristic(this.platform.Characteristic.On, value);
  }
}
