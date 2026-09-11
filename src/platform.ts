import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { VirtualLightAccessory } from './virtualLightAccessory.js';
import { VirtualSwitchAccessory } from './switchAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

/**
 * Normalized, validated configuration for a single virtual light.
 */
export interface LightConfig {
  name: string;
  switchCount: number;
  resetCountOnOff: boolean;
  turnOffOnCycleComplete: boolean;
  statefulSwitches: boolean;
  switchNames?: string[];
}

/**
 * CycleLightSwitchesPlatform
 *
 * Reads the `lights` array from the plugin config and maintains one accessory for the
 * light itself, plus, when `statefulSwitches` is enabled for it, one further standalone
 * accessory *per switch*:
 *
 * - Always, a light-only accessory (see `virtualLightAccessory.ts`) exposing an
 *   on/off-only Lightbulb service — nothing else, so it stays a single, direct-tap tile
 *   in the Home app.
 * - When `statefulSwitches` is enabled, one accessory per switch (see
 *   `switchAccessory.ts`), each holding a single Switch service. Two things force this:
 *   an accessory exposing more than one controllable service loses its single-tap tile
 *   in Home and opens a secondary screen instead (so the switches can't share the
 *   light's own accessory), and a `Switch` service has no naming characteristic beyond
 *   its plain `Name` — if several of them shared *one* accessory instead, Home's
 *   automation picker would label all of them with that shared accessory's name,
 *   making them indistinguishable. A standalone accessory per switch sidesteps both:
 *   its accessory name is unambiguously that switch's name everywhere in Home.
 *
 * When `statefulSwitches` is off (the default), the switches are stateless
 * "single press" buttons and stay nested inside the light's own accessory, since
 * StatelessProgrammableSwitch services don't render as controllable tiles in the first
 * place — there's no secondary-screen or naming problem to design around there.
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
        statefulSwitches: Boolean(raw?.statefulSwitches),
        switchNames,
      });
    }

    return lights;
  }

  /**
   * Restores an accessory with the given UUID from the cache, or creates and registers a
   * new one. Either way, refreshes `context.light` and returns the raw PlatformAccessory.
   */
  private getOrCreateAccessory(uuid: string, displayName: string, light: LightConfig, kind: string): PlatformAccessory {
    const existing = this.accessories.get(uuid);

    if (existing) {
      this.log.info(`Restoring existing ${kind} accessory from cache:`, existing.displayName);
      existing.context.light = light;
      existing.displayName = displayName;
      this.api.updatePlatformAccessories([existing]);
      return existing;
    }

    this.log.info(`Adding new ${kind} accessory:`, displayName);
    const accessory = new this.api.platformAccessory(displayName, uuid);
    accessory.context.light = light;
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    return accessory;
  }

  /**
   * Creates/updates one or two accessories per configured light, and removes accessories
   * for lights (or switch banks) that have been deleted or turned off in the config.
   */
  discoverDevices() {
    const lights = this.getLightConfigs();

    if (lights.length === 0) {
      this.log.warn('No lights are configured. Add at least one entry to the "lights" array in this plugin\'s config.');
    }

    for (const light of lights) {
      // UUIDs are derived from the light's name, so renaming a light in the config will
      // create fresh HomeKit accessories (and a fresh switch counter).
      const lightUuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}-light-${light.name}`);
      const lightAccessory = this.getOrCreateAccessory(lightUuid, light.name, light, 'light');
      this.discoveredCacheUUIDs.push(lightUuid);

      const lightHandler = new VirtualLightAccessory(this, lightAccessory);

      if (light.statefulSwitches) {
        const switchCount = Math.max(1, light.switchCount);
        const switchAccessories: VirtualSwitchAccessory[] = [];

        for (let i = 1; i <= switchCount; i++) {
          const switchName = light.switchNames?.[i - 1] || `${light.name} Switch ${i}`;
          const switchUuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}-switch-${light.name}-${i}`);
          const switchAccessory = this.getOrCreateAccessory(switchUuid, switchName, light, `switch ${i}`);
          this.discoveredCacheUUIDs.push(switchUuid);

          switchAccessories.push(new VirtualSwitchAccessory(
            this,
            switchAccessory,
            i,
            switchName,
            () => lightHandler.jumpToSwitch(i),
          ));
        }

        lightHandler.attachSwitchBank({
          fireSwitch: (switchNumber) => switchAccessories[switchNumber - 1].fire(),
        });
      }
    }

    // Remove any cached accessories for lights (or switch banks) no longer in the config.
    for (const [uuid, accessory] of this.accessories) {
      if (!this.discoveredCacheUUIDs.includes(uuid)) {
        this.log.info('Removing accessory no longer present in config:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }
}
