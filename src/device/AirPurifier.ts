import {
  AccessoryPlugin,
  CharacteristicValue,
  PlatformAccessory,
  Service,
} from 'homebridge';
import { HomeAssistantPlatform } from '../platform';
import {
  AirPurifierAdapter,
  AirPurifierStatusInfo,
} from '../deviceStatus/airPurifierAdapter';
import { isDefined } from '../utils';

const ROTATION_DEBOUNCE_MS = 400;

/** clean_level (1 = best .. 4 = worst) -> HomeKit AirQuality (1 = EXCELLENT .. 5 = POOR). */
export type AirQualityMapping = [number, number, number, number];

export interface AirPurifierDeviceConfig {
  name: string;
  fanEntity: string;
  autoPreset: string;
  /** Manual presets ordered weak -> strong; mapped onto the RotationSpeed slider in that order. */
  manualPresets: string[];
  airQualityEntity?: string;
  pm25Entity?: string;
  pm10Entity?: string;
  airQualityMapping: AirQualityMapping;
}

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class AirPurifier implements AccessoryPlugin {
  private readonly airPurifierService: Service;
  private readonly airQualitySensorService: Service;
  private readonly accessoryInformationService?: Service;

  private deviceStatus: AirPurifierStatusInfo = {
    active: false,
    presetMode: undefined,
    airQuality: undefined,
    pm25: undefined,
    pm10: undefined,
  };

  /** Index into deviceConfig.manualPresets last known to be selected; used while in auto mode. */
  private lastManualPresetIndex = 0;
  private readonly minStep: number;

  private rotationDebounceTimer?: NodeJS.Timeout;
  private pendingRotationSpeed?: number;

  constructor(
    private readonly platform: HomeAssistantPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly deviceAdapter: AirPurifierAdapter,
    private readonly deviceConfig: AirPurifierDeviceConfig,
  ) {
    // hap-nodejs rounds reported/pushed values to the nearest multiple of the
    // characteristic's minStep via `Math.round(v) - (Math.round(v) % minStep)`,
    // which silently corrupts values for a non-integer minStep > 1 (e.g. a 3-way
    // split's 33.33 gets mangled to 0). Rounding to an integer keeps every stop
    // (and the internal preset<->percent mapping, which shares this value)
    // immune to that bug; it only costs the top stop landing a little under
    // 100% when the preset count doesn't divide 100 evenly.
    this.minStep = Math.round(100 / this.deviceConfig.manualPresets.length);

    const {
      Service: { AirPurifier: AirPurifierService, AirQualitySensor },
      Characteristic,
    } = this.platform;

    this.accessoryInformationService = this.accessory.getService(
      this.platform.Service.AccessoryInformation,
    );
    this.accessoryInformationService
      ?.setCharacteristic(Characteristic.Manufacturer, 'Samsung')
      .setCharacteristic(Characteristic.Model, 'Air Purifier (via Home Assistant)')
      .setCharacteristic(Characteristic.SerialNumber, this.deviceConfig.fanEntity)
      .setCharacteristic(Characteristic.Name, this.deviceConfig.name);

    this.airPurifierService =
      this.accessory.getService(AirPurifierService) ||
      this.accessory.addService(AirPurifierService);
    this.airPurifierService.setCharacteristic(
      Characteristic.Name,
      this.deviceConfig.name,
    );

    this.airQualitySensorService =
      this.accessory.getService(AirQualitySensor) ||
      this.accessory.addService(AirQualitySensor);

    this.airPurifierService.addLinkedService(this.airQualitySensorService);

    this.airPurifierService
      .getCharacteristic(Characteristic.Active)
      .onGet(this.getActive.bind(this))
      .onSet(this.setActive.bind(this));

    this.airPurifierService
      .getCharacteristic(Characteristic.CurrentAirPurifierState)
      .onGet(this.getCurrentAirPurifierState.bind(this));

    this.airPurifierService
      .getCharacteristic(Characteristic.TargetAirPurifierState)
      .onGet(this.getTargetAirPurifierState.bind(this))
      .onSet(this.setTargetAirPurifierState.bind(this));

    this.airPurifierService
      .getCharacteristic(Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: this.minStep })
      .onGet(this.getRotationSpeed.bind(this))
      .onSet(this.setRotationSpeed.bind(this));

    this.airQualitySensorService
      .getCharacteristic(Characteristic.AirQuality)
      .onGet(this.getAirQuality.bind(this));

    this.airQualitySensorService
      .getCharacteristic(Characteristic.PM2_5Density)
      .onGet(this.getPm25Density.bind(this));

    this.airQualitySensorService
      .getCharacteristic(Characteristic.PM10Density)
      .onGet(this.getPm10Density.bind(this));

    this.deviceAdapter
      .start((status) => this.applyStatus(status))
      .catch((err) =>
        this.platform.log.error(
          `Failed to start watching ${this.deviceConfig.fanEntity}:`,
          AirPurifier.errorMessage(err),
        ),
      );
  }

  private applyStatus(status: AirPurifierStatusInfo): void {
    this.deviceStatus.active = status.active;
    if (status.presetMode !== undefined) {
      this.deviceStatus.presetMode = status.presetMode;
      const index = this.manualPresetIndex(status.presetMode);
      if (index !== undefined) {
        this.lastManualPresetIndex = index;
      }
    }
    if (status.airQuality !== undefined) {
      this.deviceStatus.airQuality = status.airQuality;
    }
    if (status.pm25 !== undefined) {
      this.deviceStatus.pm25 = status.pm25;
    }
    if (status.pm10 !== undefined) {
      this.deviceStatus.pm10 = status.pm10;
    }
    this.pushCharacteristics();
  }

  private pushCharacteristics(): void {
    const { Characteristic } = this.platform;
    this.airPurifierService.updateCharacteristic(
      Characteristic.Active,
      this.getActive(),
    );
    this.airPurifierService.updateCharacteristic(
      Characteristic.CurrentAirPurifierState,
      this.getCurrentAirPurifierState(),
    );
    this.airPurifierService.updateCharacteristic(
      Characteristic.TargetAirPurifierState,
      this.getTargetAirPurifierState(),
    );
    this.airPurifierService.updateCharacteristic(
      Characteristic.RotationSpeed,
      this.getRotationSpeed(),
    );
    this.airQualitySensorService.updateCharacteristic(
      Characteristic.AirQuality,
      this.getAirQuality(),
    );
    this.airQualitySensorService.updateCharacteristic(
      Characteristic.PM2_5Density,
      this.getPm25Density(),
    );
    this.airQualitySensorService.updateCharacteristic(
      Characteristic.PM10Density,
      this.getPm10Density(),
    );
  }

  private getActive(): CharacteristicValue {
    const { Active } = this.platform.Characteristic;
    return this.deviceStatus.active ? Active.ACTIVE : Active.INACTIVE;
  }

  private async setActive(newState: CharacteristicValue): Promise<void> {
    const { Active } = this.platform.Characteristic;
    const wantActive = newState === Active.ACTIVE;
    if (wantActive === this.deviceStatus.active) {
      return;
    }

    try {
      if (wantActive) {
        await this.deviceAdapter.turnOn();
      } else {
        await this.deviceAdapter.turnOff();
      }
      this.deviceStatus.active = wantActive;
    } catch (err) {
      this.platform.log.error(
        'Cannot set air purifier active state:',
        AirPurifier.errorMessage(err),
      );
      throw this.toHapStatusError();
    }
  }

  private getCurrentAirPurifierState(): CharacteristicValue {
    const { CurrentAirPurifierState } = this.platform.Characteristic;
    return this.deviceStatus.active
      ? CurrentAirPurifierState.PURIFYING_AIR
      : CurrentAirPurifierState.INACTIVE;
  }

  private getTargetAirPurifierState(): CharacteristicValue {
    const { TargetAirPurifierState } = this.platform.Characteristic;
    return this.isAutoMode()
      ? TargetAirPurifierState.AUTO
      : TargetAirPurifierState.MANUAL;
  }

  private async setTargetAirPurifierState(
    value: CharacteristicValue,
  ): Promise<void> {
    const { TargetAirPurifierState } = this.platform.Characteristic;
    const wantAuto = value === TargetAirPurifierState.AUTO;
    if (wantAuto === this.isAutoMode()) {
      return;
    }

    const targetPreset = wantAuto
      ? this.deviceConfig.autoPreset
      : this.deviceConfig.manualPresets[this.lastManualPresetIndex];

    try {
      await this.deviceAdapter.setPresetMode(targetPreset);
      this.deviceStatus.presetMode = targetPreset;
    } catch (err) {
      this.platform.log.error(
        'Cannot set air purifier mode:',
        AirPurifier.errorMessage(err),
      );
      throw this.toHapStatusError();
    }
  }

  private getRotationSpeed(): CharacteristicValue {
    const index =
      this.manualPresetIndex(this.deviceStatus.presetMode) ??
      this.lastManualPresetIndex;
    return this.speedForPresetIndex(index);
  }

  private setRotationSpeed(value: CharacteristicValue): void {
    const percent = value as number;
    if (percent <= 0) {
      // Apple Home sends Active=0 together with RotationSpeed=0 when turning the
      // tile off; the Active handler already covers that, so ignore this to avoid
      // firing a redundant (and meaningless) preset command.
      return;
    }

    this.pendingRotationSpeed = percent;
    if (this.rotationDebounceTimer) {
      clearTimeout(this.rotationDebounceTimer);
    }
    this.rotationDebounceTimer = setTimeout(() => {
      this.rotationDebounceTimer = undefined;
      const pending = this.pendingRotationSpeed;
      this.pendingRotationSpeed = undefined;
      if (pending !== undefined) {
        this.applyRotationSpeed(pending).catch((err) =>
          this.platform.log.error(
            'Cannot set air purifier preset:',
            AirPurifier.errorMessage(err),
          ),
        );
      }
    }, ROTATION_DEBOUNCE_MS);
  }

  private async applyRotationSpeed(percent: number): Promise<void> {
    const index = this.presetIndexForSpeed(percent);
    const preset = this.deviceConfig.manualPresets[index];
    if (preset === this.deviceStatus.presetMode) {
      return;
    }

    await this.deviceAdapter.setPresetMode(preset);
    this.deviceStatus.presetMode = preset;
    this.lastManualPresetIndex = index;
  }

  private getAirQuality(): CharacteristicValue {
    const { AirQuality } = this.platform.Characteristic;
    const raw = this.deviceStatus.airQuality;
    if (raw === undefined) {
      return AirQuality.UNKNOWN;
    }
    const clamped = Math.min(4, Math.max(1, Math.round(raw)));
    return this.deviceConfig.airQualityMapping[clamped - 1];
  }

  private getPm25Density(): CharacteristicValue {
    return this.deviceStatus.pm25 ?? 0;
  }

  private getPm10Density(): CharacteristicValue {
    return this.deviceStatus.pm10 ?? 0;
  }

  private isAutoMode(): boolean {
    return this.deviceStatus.presetMode === this.deviceConfig.autoPreset;
  }

  private manualPresetIndex(presetMode?: string): number | undefined {
    if (presetMode === undefined) {
      return undefined;
    }
    const index = this.deviceConfig.manualPresets.indexOf(presetMode);
    return index === -1 ? undefined : index;
  }

  private speedForPresetIndex(index: number): number {
    return (index + 1) * this.minStep;
  }

  private presetIndexForSpeed(percent: number): number {
    const count = this.deviceConfig.manualPresets.length;
    const index = Math.round(percent / this.minStep) - 1;
    return Math.min(count - 1, Math.max(0, index));
  }

  private toHapStatusError(): Error {
    const hap = this.platform.api.hap;
    return new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  private static errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  getServices(): Service[] {
    return [
      this.airPurifierService,
      this.airQualitySensorService,
      this.accessoryInformationService,
    ].filter(isDefined);
  }
}
