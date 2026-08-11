import { expect } from 'chai';
import { Characteristic, HAPStatus, HapStatusError, Service, uuid } from 'hap-nodejs';
// homebridge doesn't re-export the runtime PlatformAccessory class from its
// public entrypoint (only its types), so we reach into its lib the same way
// homebridge itself constructs accessories.
import { PlatformAccessory } from 'homebridge/lib/platformAccessory';

import { AirPurifier, AirPurifierDeviceConfig } from '../src/device/AirPurifier';
import { AirPurifierAdapter } from '../src/deviceStatus/airPurifierAdapter';
import { HAClientLike, HAState, HAStateListener } from '../src/haClient';
import { HomeAssistantPlatform } from '../src/platform';

const FAN_ENTITY = 'fan.samsung_air_purifier_a_vtww_tp2_21_common';
const AIR_QUALITY_ENTITY = 'sensor.clean_level';
const PM25_ENTITY = 'sensor.pm2_5';
const PM10_ENTITY = 'sensor.pm10';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** In-memory stand-in for HAClient: no network, but the same watch/callService contract. */
class FakeHAClient implements HAClientLike {
  private readonly states = new Map<string, HAState>();
  private readonly listeners = new Map<string, Set<HAStateListener>>();
  readonly calls: { domain: string; service: string; data: Record<string, unknown> }[] = [];
  failNextCallWith?: Error;

  seed(entityId: string, state: string, attributes: Record<string, unknown> = {}): void {
    this.states.set(entityId, { entity_id: entityId, state, attributes });
  }

  /** Simulates an external Home Assistant push (what a WebSocket event would deliver). */
  push(entityId: string, state: string, attributes: Record<string, unknown> = {}): void {
    const next: HAState = { entity_id: entityId, state, attributes };
    this.states.set(entityId, next);
    this.listeners.get(entityId)?.forEach((listener) => listener(next));
  }

  getState(entityId: string): HAState | undefined {
    return this.states.get(entityId);
  }

  async watch(entityId: string, listener: HAStateListener): Promise<void> {
    let set = this.listeners.get(entityId);
    if (!set) {
      set = new Set();
      this.listeners.set(entityId, set);
    }
    set.add(listener);
    const current = this.states.get(entityId);
    if (current) {
      listener(current);
    }
  }

  unwatch(entityId: string, listener: HAStateListener): void {
    this.listeners.get(entityId)?.delete(listener);
  }

  async callService(
    domain: string,
    service: string,
    data: Record<string, unknown>,
  ): Promise<HAState[]> {
    this.calls.push({ domain, service, data });
    if (this.failNextCallWith) {
      const err = this.failNextCallWith;
      this.failNextCallWith = undefined;
      throw err;
    }

    const entityId = data.entity_id as string;
    const current = this.states.get(entityId) ?? {
      entity_id: entityId,
      state: 'off',
      attributes: {},
    };
    let next = current;
    if (domain === 'fan' && service === 'turn_on') {
      next = { ...current, state: 'on' };
    } else if (domain === 'fan' && service === 'turn_off') {
      next = { ...current, state: 'off' };
    } else if (domain === 'fan' && service === 'set_preset_mode') {
      next = {
        ...current,
        state: 'on',
        attributes: { ...current.attributes, preset_mode: data.preset_mode },
      };
    }
    this.push(entityId, next.state, next.attributes);
    return [next];
  }
}

function fakePlatform(): HomeAssistantPlatform {
  return {
    Service,
    Characteristic,
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      log: () => undefined,
    },
    api: {
      hap: { HapStatusError, HAPStatus, uuid },
    },
  } as unknown as HomeAssistantPlatform;
}

function buildDevice(
  client: FakeHAClient,
  overrides: Partial<AirPurifierDeviceConfig> = {},
): { airPurifier: AirPurifier; accessory: PlatformAccessory } {
  const deviceConfig: AirPurifierDeviceConfig = {
    name: '공기청정기',
    fanEntity: FAN_ENTITY,
    autoPreset: 'smart',
    manualPresets: ['sleep', 'windfree', 'max'],
    airQualityEntity: AIR_QUALITY_ENTITY,
    pm25Entity: PM25_ENTITY,
    pm10Entity: PM10_ENTITY,
    airQualityMapping: [1, 2, 4, 5],
    ...overrides,
  };

  const accessory = new PlatformAccessory(
    deviceConfig.name,
    uuid.generate(deviceConfig.fanEntity),
  );
  const adapter = new AirPurifierAdapter(client, deviceConfig, fakePlatform().log);
  const airPurifier = new AirPurifier(fakePlatform(), accessory, adapter, deviceConfig);
  return { airPurifier, accessory };
}

describe('AirPurifier', () => {
  let client: FakeHAClient;

  beforeEach(() => {
    client = new FakeHAClient();
    client.seed(FAN_ENTITY, 'on', { preset_mode: 'sleep' });
    client.seed(AIR_QUALITY_ENTITY, '1');
    client.seed(PM25_ENTITY, '12');
    client.seed(PM10_ENTITY, '20');
  });

  it('exposes an AirPurifier + linked AirQualitySensor service', async () => {
    const { airPurifier } = buildDevice(client);
    await wait(10);

    const services = airPurifier.getServices();
    const purifierService = services.find((s) => s.UUID === Service.AirPurifier.UUID);
    const airQualityService = services.find(
      (s) => s.UUID === Service.AirQualitySensor.UUID,
    );

    expect(purifierService).to.exist;
    expect(airQualityService).to.exist;
    expect(purifierService!.getCharacteristic(Characteristic.RotationSpeed)).to.exist;
    expect(purifierService!.linkedServices).to.include(airQualityService);
  });

  it('maps manual presets to RotationSpeed slider stops and back', async () => {
    const { airPurifier } = buildDevice(client);
    await wait(10);
    const service = airPurifier.getServices().find((s) => s.UUID === Service.AirPurifier.UUID)!;
    const speedChar = service.getCharacteristic(Characteristic.RotationSpeed);

    // 3 manual presets -> minStep rounds to 33, so the stops are 33 / 66 / 99
    // (an integer minStep keeps hap-nodejs's internal value rounding correct;
    // see the comment on AirPurifier's minStep field for why it isn't 33.33).
    client.push(FAN_ENTITY, 'on', { preset_mode: 'sleep' });
    expect(await speedChar.handleGetRequest()).to.equal(33);

    client.push(FAN_ENTITY, 'on', { preset_mode: 'windfree' });
    expect(await speedChar.handleGetRequest()).to.equal(66);

    client.push(FAN_ENTITY, 'on', { preset_mode: 'max' });
    expect(await speedChar.handleGetRequest()).to.equal(99);

    // slider -> preset (drag settles, then debounce fires the command); starting
    // from 'max', dragging to 60 is closest to the 'windfree' stop (66).
    await speedChar.handleSetRequest(60);
    await wait(500);
    const presetCalls = client.calls.filter((c) => c.service === 'set_preset_mode');
    expect(presetCalls[presetCalls.length - 1].data.preset_mode).to.equal('windfree');
  });

  it('rounds slider boundary values to the nearest preset stop', async () => {
    // start from the middle preset so both boundary drags below are real changes
    client.seed(FAN_ENTITY, 'on', { preset_mode: 'windfree' });
    const { airPurifier } = buildDevice(client);
    await wait(10);
    const service = airPurifier.getServices().find((s) => s.UUID === Service.AirPurifier.UUID)!;
    const speedChar = service.getCharacteristic(Characteristic.RotationSpeed);

    await speedChar.handleSetRequest(1);
    await wait(500);
    expect(client.calls[client.calls.length - 1].data.preset_mode).to.equal('sleep');

    await speedChar.handleSetRequest(100);
    await wait(500);
    expect(client.calls[client.calls.length - 1].data.preset_mode).to.equal('max');
  });

  it('debounces rapid slider drags into a single command for the final value', async () => {
    const { airPurifier } = buildDevice(client);
    await wait(10);
    const service = airPurifier.getServices().find((s) => s.UUID === Service.AirPurifier.UUID)!;
    const speedChar = service.getCharacteristic(Characteristic.RotationSpeed);
    const before = client.calls.length;

    await speedChar.handleSetRequest(40);
    await speedChar.handleSetRequest(60);
    await speedChar.handleSetRequest(100);
    // still within the 400ms debounce window - nothing should have fired yet
    await wait(200);
    expect(client.calls.length).to.equal(before);

    await wait(400);
    const presetCalls = client.calls.slice(before).filter((c) => c.service === 'set_preset_mode');
    expect(presetCalls).to.have.length(1);
    expect(presetCalls[0].data.preset_mode).to.equal('max');
  });

  it('switches between auto and manual, remembering the last manual step', async () => {
    const { airPurifier } = buildDevice(client);
    await wait(10);
    const service = airPurifier.getServices().find((s) => s.UUID === Service.AirPurifier.UUID)!;
    const targetChar = service.getCharacteristic(Characteristic.TargetAirPurifierState);
    const speedChar = service.getCharacteristic(Characteristic.RotationSpeed);

    client.push(FAN_ENTITY, 'on', { preset_mode: 'windfree' });
    expect(await targetChar.handleGetRequest()).to.equal(
      Characteristic.TargetAirPurifierState.MANUAL,
    );

    await targetChar.handleSetRequest(Characteristic.TargetAirPurifierState.AUTO);
    expect(client.calls[client.calls.length - 1].data.preset_mode).to.equal('smart');
    expect(await targetChar.handleGetRequest()).to.equal(
      Characteristic.TargetAirPurifierState.AUTO,
    );
    // the slider still shows the last manual step while in auto
    expect(await speedChar.handleGetRequest()).to.equal(66);

    await targetChar.handleSetRequest(Characteristic.TargetAirPurifierState.MANUAL);
    expect(client.calls[client.calls.length - 1].data.preset_mode).to.equal('windfree');
  });

  it('turns the fan on and off', async () => {
    const { airPurifier } = buildDevice(client);
    await wait(10);
    const service = airPurifier.getServices().find((s) => s.UUID === Service.AirPurifier.UUID)!;
    const activeChar = service.getCharacteristic(Characteristic.Active);

    await activeChar.handleSetRequest(Characteristic.Active.INACTIVE);
    expect(client.calls[client.calls.length - 1]).to.include({ domain: 'fan', service: 'turn_off' });

    await activeChar.handleSetRequest(Characteristic.Active.ACTIVE);
    expect(client.calls[client.calls.length - 1]).to.include({ domain: 'fan', service: 'turn_on' });
  });

  it('skips redundant commands when already in the desired state', async () => {
    const { airPurifier } = buildDevice(client);
    await wait(10);
    const service = airPurifier.getServices().find((s) => s.UUID === Service.AirPurifier.UUID)!;
    const activeChar = service.getCharacteristic(Characteristic.Active);
    const speedChar = service.getCharacteristic(Characteristic.RotationSpeed);

    // fan is already 'on' with preset 'sleep' per beforeEach seed
    const before = client.calls.length;
    await activeChar.handleSetRequest(Characteristic.Active.ACTIVE);
    expect(client.calls.length).to.equal(before);

    // Apple Home sends RotationSpeed=0 alongside Active=0 when powering off; must be ignored
    await speedChar.handleSetRequest(0);
    await wait(500);
    expect(client.calls.length).to.equal(before);

    // already on 'sleep' (slider stop 1 of 3) -> no duplicate set_preset_mode call
    await speedChar.handleSetRequest(20);
    await wait(500);
    expect(client.calls.length).to.equal(before);
  });

  it('reflects state pushed from Home Assistant in real time', async () => {
    const { airPurifier } = buildDevice(client);
    await wait(10);
    const service = airPurifier.getServices().find((s) => s.UUID === Service.AirPurifier.UUID)!;
    const activeChar = service.getCharacteristic(Characteristic.Active);

    expect(activeChar.value).to.equal(Characteristic.Active.ACTIVE);
    client.push(FAN_ENTITY, 'off', { preset_mode: 'sleep' });
    expect(activeChar.value).to.equal(Characteristic.Active.INACTIVE);
  });

  it('does not throw when sensors are unknown/unavailable', async () => {
    client.seed(AIR_QUALITY_ENTITY, 'unavailable');
    client.seed(PM25_ENTITY, 'unknown');
    const { airPurifier } = buildDevice(client);
    await wait(10);
    const airQualityService = airPurifier
      .getServices()
      .find((s) => s.UUID === Service.AirQualitySensor.UUID)!;

    const airQuality = await airQualityService
      .getCharacteristic(Characteristic.AirQuality)
      .handleGetRequest();
    expect(airQuality).to.equal(Characteristic.AirQuality.UNKNOWN);

    const pm25 = await airQualityService
      .getCharacteristic(Characteristic.PM2_5Density)
      .handleGetRequest();
    expect(pm25).to.equal(0);
  });

  it('propagates communication failures to HomeKit as a service-communication-failure status', async () => {
    const { airPurifier } = buildDevice(client);
    await wait(10);
    const service = airPurifier.getServices().find((s) => s.UUID === Service.AirPurifier.UUID)!;
    const activeChar = service.getCharacteristic(Characteristic.Active);

    client.failNextCallWith = new Error('network is down');

    let caught: unknown;
    try {
      await activeChar.handleSetRequest(Characteristic.Active.INACTIVE);
    } catch (err) {
      caught = err;
    }
    expect(caught).to.equal(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  });
});
