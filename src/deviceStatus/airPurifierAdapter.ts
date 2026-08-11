import { Logger } from 'homebridge';
import { HAClientLike, HAState } from '../haClient';

export interface AirPurifierEntityConfig {
  fanEntity: string;
  airQualityEntity?: string;
  pm25Entity?: string;
  pm10Entity?: string;
}

export interface AirPurifierStatusInfo {
  active: boolean;
  /** Raw Home Assistant preset_mode of the fan, e.g. 'smart' | 'sleep' | 'windfree' | 'max'. */
  presetMode?: string;
  /** Raw clean-air-level sensor value (1-4), undefined if the sensor is unavailable. */
  airQuality?: number;
  pm25?: number;
  pm10?: number;
}

/**
 * Bridges a Samsung air purifier's Home Assistant entities (a `fan` plus a few
 * `sensor`s) to the shape the HomeKit accessory needs, using a shared HAClient
 * for both commands and live state.
 */
export class AirPurifierAdapter {
  constructor(
    private readonly client: HAClientLike,
    private readonly config: AirPurifierEntityConfig,
    private readonly log: Logger,
  ) {}

  /**
   * Registers interest in every entity this device uses (priming the cache with
   * their current state) and invokes `listener` with a fresh status snapshot
   * whenever any of them change in Home Assistant — both for that initial
   * snapshot and for every later push over the WebSocket (or the polling
   * fallback).
   */
  async start(listener: (status: AirPurifierStatusInfo) => void): Promise<void> {
    const entityIds = this.entityIds();
    this.log.debug('Watching entities', entityIds);
    await Promise.all(
      entityIds.map((entityId) =>
        this.client.watch(entityId, () => listener(this.getStatus())),
      ),
    );
  }

  getStatus(): AirPurifierStatusInfo {
    const fanState = this.client.getState(this.config.fanEntity);
    return {
      active: fanState?.state === 'on',
      presetMode: AirPurifierAdapter.readString(
        fanState?.attributes?.['preset_mode'],
      ),
      airQuality: this.readSensorValue(this.config.airQualityEntity),
      pm25: this.readSensorValue(this.config.pm25Entity),
      pm10: this.readSensorValue(this.config.pm10Entity),
    };
  }

  async turnOn(): Promise<void> {
    await this.client.callService('fan', 'turn_on', {
      entity_id: this.config.fanEntity,
    });
  }

  async turnOff(): Promise<void> {
    await this.client.callService('fan', 'turn_off', {
      entity_id: this.config.fanEntity,
    });
  }

  async setPresetMode(presetMode: string): Promise<void> {
    await this.client.callService('fan', 'set_preset_mode', {
      entity_id: this.config.fanEntity,
      preset_mode: presetMode,
    });
  }

  private entityIds(): string[] {
    return [
      this.config.fanEntity,
      this.config.airQualityEntity,
      this.config.pm25Entity,
      this.config.pm10Entity,
    ].filter((entityId): entityId is string => !!entityId);
  }

  private readSensorValue(entityId?: string): number | undefined {
    if (!entityId) {
      return undefined;
    }
    const state = this.client.getState(entityId);
    return AirPurifierAdapter.parseNumericState(state);
  }

  private static parseNumericState(state?: HAState): number | undefined {
    if (!state || state.state === 'unknown' || state.state === 'unavailable') {
      return undefined;
    }
    const value = Number.parseFloat(state.state);
    return Number.isFinite(value) ? value : undefined;
  }

  private static readString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }
}
