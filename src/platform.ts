import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { VirtualLightAccessory } from './virtualLightAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

/**
 * Normalized, validated configuration for a single virtual light.
 */
export interface LightConfig {
  name: string;
  switchCount: number;
  resetCountOnOff: boolean;
  turnOffOnCycleComplete: boolean;
  switchNames?: string[];
}

/**
 * CycleLightSwitchesPlatform
 *
 * Reads the `lights` array from the plugin config and maintains one accessory per light.
 * Each accessory exposes an on/off-only Lightbulb service plus `switchCount` stateless,
 * single-press "Generic Switch" services. See `virtualLightAccessory.ts` for the
 * round-robin firing logic.
 */
export class CycleLightSwitchesPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // Tracks cached accessories restored from disk at startup, keyed by UUID.
  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  public readonly discoveredCacheUUIDs: string[] = [];

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.debug('Finished initializing platform:', this.config.name);

    // Dynamic Platform plugins should only register accessories after Homebridge has
    // restored all cached accessories from disk, which is signalled by this event.
    this.api.on('didFinishLaunching', () => {
      this.log.debug('Executed didFinishLaunching callback');

      // Per the Homebridge Verified plugin requirements ("The plugin must successfully
      // install and not start unless it is configured" -
      // https://github.com/homebridge/plugins/wiki/Verified-Plugins): if the user hasn't
      // configured any lights yet, and there's nothing previously registered that needs
      // cleaning up, don't do anything at all rather than running discovery for its own
      // sake.
      if (!this.hasLightsConfigured() && this.accessories.size === 0) {
        this.log.info(
          'No lights are configured yet. Add at least one entry to the "lights" array in '
          + 'this plugin\'s settings to use it. Nothing will happen until then.',
        );
        return;
      }

      this.discoverDevices();
    });
  }

  /**
   * Invoked when Homebridge restores a cached accessory from disk at startup.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  /** Whether the config has at least one entry in its `lights` array. */
  private hasLightsConfigured(): boolean {
    return Array.isArray(this.config.lights) && this.config.lights.length > 0;
  }

  /**
   * Reads, validates and normalizes the `lights` array from the user's config.
   */
  private getLightConfigs(): LightConfig[] {
    const rawLights = Array.isArray(this.config.lights) ? this.config.lights : [];
    const seenNames = new Set<string>();
    const lights: LightConfig[] = [];

    for (const raw of rawLights as Record<string, unknown>[]) {
      const name = typeof raw?.name === 'string' ? raw.name.trim() : '';

      if (!name) {
        this.log.warn('Ignoring a light entry in the config with a missing or empty "name".');
        continue;
      }

      if (seenNames.has(name)) {
        this.log.warn(`Ignoring duplicate light "${name}" in the config; light names must be unique.`);
        continue;
      }
      seenNames.add(name);

      let switchCount = Number(raw?.switchCount);
      if (!Number.isFinite(switchCount) || switchCount < 1) {
        this.log.warn(`Light "${name}" has an invalid "switchCount"; defaulting to 1.`);
        switchCount = 1;
      }
      switchCount = Math.floor(switchCount);

      const switchNames = Array.isArray(raw?.switchNames)
        ? (raw.switchNames as unknown[]).filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
        : undefined;

      lights.push({
        name,
        switchCount,
        resetCountOnOff: Boolean(raw?.resetCountOnOff),
        turnOffOnCycleComplete: Boolean(raw?.turnOffOnCycleComplete),
        switchNames,
      });
    }

    return lights;
  }

  /**
   * Creates/updates one accessory per configured light, and removes accessories for
   * lights that have been deleted from the config.
   */
  discoverDevices() {
    const lights = this.getLightConfigs();

    if (lights.length === 0) {
      this.log.warn('No lights are configured. Add at least one entry to the "lights" array in this plugin\'s config.');
    }

    for (const light of lights) {
      // The UUID is derived from the light's name, so renaming a light in the config
      // will create a new HomeKit accessory (and a fresh switch counter).
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}-light-${light.name}`);
      const existingAccessory = this.accessories.get(uuid);

      if (existingAccessory) {
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);

        // Refresh the config-derived fields, but leave `context.state` (the persisted
        // switch counter) untouched — that's handled inside VirtualLightAccessory.
        existingAccessory.context.light = light;
        existingAccessory.displayName = light.name;
        this.api.updatePlatformAccessories([existingAccessory]);

        new VirtualLightAccessory(this, existingAccessory);
      } else {
        this.log.info('Adding new accessory:', light.name);

        const accessory = new this.api.platformAccessory(light.name, uuid);
        accessory.context.light = light;

        new VirtualLightAccessory(this, accessory);

        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

      this.discoveredCacheUUIDs.push(uuid);
    }

    // Remove any cached accessories for lights that are no longer in the config.
    for (const [uuid, accessory] of this.accessories) {
      if (!this.discoveredCacheUUIDs.includes(uuid)) {
        this.log.info('Removing accessory no longer present in config:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }
}
