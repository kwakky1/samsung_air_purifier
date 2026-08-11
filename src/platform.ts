import {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import {
  AirPurifier,
  AirPurifierDeviceConfig,
  AirQualityMapping,
} from './device/AirPurifier';
import { AirPurifierAdapter } from './deviceStatus/airPurifierAdapter';
import { HAClient } from './haClient';

const DEFAULT_UPDATE_INTERVAL_SECS = 15;
const DEFAULT_AUTO_PRESET = 'smart';
const DEFAULT_MANUAL_PRESETS = ['sleep', 'windfree', 'max'];
const DEFAULT_AIR_QUALITY_MAPPING: AirQualityMapping = [1, 2, 4, 5];

// Home Assistant entity ids are always "<domain>.<object_id>", e.g. "fan.living_room".
const ENTITY_ID_PATTERN = /^[a-z0-9_]+\.[a-z0-9_]+$/;

interface RawAirPurifierDeviceConfig {
  name?: string;
  fanEntity?: string;
  autoPreset?: string;
  manualPresets?: string[];
  airQualityEntity?: string;
  pm25Entity?: string;
  pm10Entity?: string;
  airQualityMapping?: AirQualityMapping;
}

export class HomeAssistantPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic =
    this.api.hap.Characteristic;

  private readonly accessories: PlatformAccessory[] = [];
  private client?: HAClient;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.api.on('didFinishLaunching', () => this.discoverDevices());
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  private discoverDevices(): void {
    const haUrl = this.config.haUrl as string | undefined;
    const haToken = this.config.haToken as string | undefined;

    if (!haUrl?.trim()) {
      this.log.error(
        'Missing "haUrl" in config. Set it to your Home Assistant base URL, e.g. http://homeassistant.local:8123',
      );
      return;
    }
    if (!haToken?.trim()) {
      this.log.error(
        'Missing "haToken" in config. Create a long-lived access token in Home Assistant and set it here.',
      );
      return;
    }

    const rawDevices =
      (this.config.devices as RawAirPurifierDeviceConfig[] | undefined) ?? [];
    if (rawDevices.length === 0) {
      this.log.warn('No devices configured under "devices". Nothing to register.');
    }

    const updateIntervalSecs =
      (this.config.updateInterval as number | undefined) ??
      DEFAULT_UPDATE_INTERVAL_SECS;

    this.client = new HAClient({
      url: haUrl,
      token: haToken,
      log: this.log,
      pollIntervalMs: updateIntervalSecs * 1000,
    });

    const configuredUuids = new Set<string>();

    for (const raw of rawDevices) {
      const deviceConfig = this.resolveDeviceConfig(raw);
      if (!deviceConfig) {
        continue;
      }

      const uuid = this.api.hap.uuid.generate(deviceConfig.fanEntity);
      configuredUuids.add(uuid);
      this.registerAirPurifier(uuid, deviceConfig);
    }

    this.removeStaleAccessories(configuredUuids);
  }

  private resolveDeviceConfig(
    raw: RawAirPurifierDeviceConfig,
  ): AirPurifierDeviceConfig | undefined {
    const deviceName = raw.name ?? raw.fanEntity ?? 'unnamed device';

    if (!raw.fanEntity || !ENTITY_ID_PATTERN.test(raw.fanEntity)) {
      this.log.error(
        `Device "${deviceName}" has an invalid or missing "fanEntity" (expected an entity id like "fan.my_purifier"). Skipping.`,
      );
      return undefined;
    }
    if (!raw.fanEntity.startsWith('fan.')) {
      this.log.warn(
        `Device "${deviceName}" fanEntity "${raw.fanEntity}" does not look like a fan entity (expected "fan.<name>").`,
      );
    }

    return {
      name: deviceName,
      fanEntity: raw.fanEntity,
      autoPreset: raw.autoPreset ?? DEFAULT_AUTO_PRESET,
      manualPresets:
        raw.manualPresets && raw.manualPresets.length > 0
          ? raw.manualPresets
          : DEFAULT_MANUAL_PRESETS,
      airQualityEntity: this.validateOptionalEntity(
        raw.airQualityEntity,
        'airQualityEntity',
        deviceName,
      ),
      pm25Entity: this.validateOptionalEntity(
        raw.pm25Entity,
        'pm25Entity',
        deviceName,
      ),
      pm10Entity: this.validateOptionalEntity(
        raw.pm10Entity,
        'pm10Entity',
        deviceName,
      ),
      airQualityMapping: raw.airQualityMapping ?? DEFAULT_AIR_QUALITY_MAPPING,
    };
  }

  private validateOptionalEntity(
    value: string | undefined,
    key: string,
    deviceName: string,
  ): string | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (!ENTITY_ID_PATTERN.test(value)) {
      this.log.error(
        `Device "${deviceName}" has an invalid "${key}": "${value}". Ignoring this sensor.`,
      );
      return undefined;
    }
    return value;
  }

  private registerAirPurifier(
    uuid: string,
    deviceConfig: AirPurifierDeviceConfig,
  ): void {
    const existing = this.accessories.find(
      (accessory) => accessory.UUID === uuid,
    );
    const accessory =
      existing ?? new this.api.platformAccessory(deviceConfig.name, uuid);

    if (existing) {
      this.log.info('Restoring existing accessory from cache:', deviceConfig.name);
    } else {
      this.log.info('Adding new accessory:', deviceConfig.name);
      this.accessories.push(accessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
        accessory,
      ]);
    }

    // discoverDevices() always creates the client before calling this method.
    const adapter = new AirPurifierAdapter(this.client as HAClient, deviceConfig, this.log);
    new AirPurifier(this, accessory, adapter, deviceConfig);
  }

  private removeStaleAccessories(configuredUuids: Set<string>): void {
    const stale = this.accessories.filter(
      (accessory) => !configuredUuids.has(accessory.UUID),
    );
    if (stale.length === 0) {
      return;
    }

    this.log.info(
      'Removing accessories no longer present in config:',
      stale.map((accessory) => accessory.displayName),
    );
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    for (const accessory of stale) {
      const index = this.accessories.indexOf(accessory);
      if (index !== -1) {
        this.accessories.splice(index, 1);
      }
    }
  }
}
