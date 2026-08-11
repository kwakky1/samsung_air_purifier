import WebSocket from 'ws';
import { Logger } from 'homebridge';

/**
 * A Home Assistant entity state, as returned by the REST and WebSocket APIs.
 */
export interface HAState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
}

export class HAClientError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'HAClientError';
  }
}

export type HAStateListener = (state: HAState) => void;

/**
 * The subset of HAClient that device adapters depend on. Extracted as an interface
 * so tests can substitute a fake client without touching the network.
 */
export interface HAClientLike {
  getState(entityId: string): HAState | undefined;
  watch(entityId: string, listener: HAStateListener): Promise<void>;
  unwatch(entityId: string, listener: HAStateListener): void;
  callService(
    domain: string,
    service: string,
    data: Record<string, unknown>,
  ): Promise<HAState[]>;
}

export interface HAClientOptions {
  url: string;
  token: string;
  log: Logger;
  pollIntervalMs?: number;
  reconnectIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 15000;
const DEFAULT_RECONNECT_INTERVAL_MS = 30000;

/**
 * Talks to a single Home Assistant instance over its local REST + WebSocket APIs.
 * Commands go out over REST; state changes come in over a WebSocket `subscribe_trigger`
 * subscription scoped to only the entities this plugin cares about. If the WebSocket
 * cannot be established (or drops), state is kept fresh by polling REST instead until
 * the socket can be reconnected.
 */
export class HAClient implements HAClientLike {
  private readonly baseUrl: string;
  private readonly wsUrl: string;
  private readonly token: string;
  private readonly log: Logger;
  private readonly pollIntervalMs: number;
  private readonly reconnectIntervalMs: number;

  private readonly cache = new Map<string, HAState>();
  private readonly listeners = new Map<string, Set<HAStateListener>>();

  private ws?: WebSocket;
  private wsConnected = false;
  private wsConnecting = false;
  private nextMessageId = 1;
  private pollTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private startScheduled = false;
  private closed = false;

  constructor(options: HAClientOptions) {
    this.baseUrl = options.url.replace(/\/+$/, '');
    this.wsUrl = `${this.baseUrl.replace(/^http/, 'ws')}/api/websocket`;
    this.token = options.token;
    this.log = options.log;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.reconnectIntervalMs =
      options.reconnectIntervalMs ?? DEFAULT_RECONNECT_INTERVAL_MS;
  }

  /**
   * Returns the last known state for an entity, if any has been fetched or pushed yet.
   */
  getState(entityId: string): HAState | undefined {
    return this.cache.get(entityId);
  }

  /**
   * Registers interest in an entity's state changes. The first call for a given entity
   * primes the cache with a REST fetch; the WebSocket subscription (or polling fallback)
   * is (re)established for the full set of watched entities on the next tick, so that
   * synchronous batches of watch() calls made during accessory setup collapse into a
   * single subscription instead of one per entity.
   */
  async watch(entityId: string, listener: HAStateListener): Promise<void> {
    let set = this.listeners.get(entityId);
    if (!set) {
      set = new Set();
      this.listeners.set(entityId, set);
    }
    set.add(listener);

    if (!this.cache.has(entityId)) {
      await this.refreshEntityState(entityId);
    }

    this.scheduleStart();
  }

  unwatch(entityId: string, listener: HAStateListener): void {
    this.listeners.get(entityId)?.delete(listener);
  }

  /**
   * Calls a Home Assistant service over REST and immediately applies any changed
   * states from the response to the local cache, so callers don't have to wait for
   * a WebSocket event to see their own command take effect.
   */
  async callService(
    domain: string,
    service: string,
    data: Record<string, unknown>,
  ): Promise<HAState[]> {
    let response: Response;
    try {
      response = await fetch(
        `${this.baseUrl}/api/services/${domain}/${service}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(data),
        },
      );
    } catch (err) {
      throw new HAClientError(
        `Failed to reach Home Assistant at ${this.baseUrl}`,
        err,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new HAClientError(
        `Home Assistant service call ${domain}.${service} failed with status ${response.status}: ${body}`,
      );
    }

    const changed = (await response.json().catch(() => [])) as HAState[];
    if (Array.isArray(changed)) {
      for (const state of changed) {
        this.applyState(state);
      }
    }
    return changed;
  }

  close(): void {
    this.closed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.ws?.removeAllListeners();
    this.ws?.terminate();
    this.ws = undefined;
  }

  private scheduleStart(): void {
    if (this.startScheduled || this.closed) {
      return;
    }
    this.startScheduled = true;
    setImmediate(() => {
      this.startScheduled = false;
      this.connectWebSocket();
      if (!this.pollTimer) {
        // Poll as a fallback until the WebSocket confirms it's up; connectWebSocket()
        // will clear this once `auth_ok` + subscribe_trigger succeed.
        this.startPolling();
      }
    });
  }

  private async refreshEntityState(entityId: string): Promise<void> {
    try {
      const response = await fetch(
        `${this.baseUrl}/api/states/${entityId}`,
        {
          headers: { Authorization: `Bearer ${this.token}` },
        },
      );
      if (!response.ok) {
        throw new HAClientError(
          `Failed to fetch state for ${entityId}: HTTP ${response.status}`,
        );
      }
      const state = (await response.json()) as HAState;
      this.applyState(state);
    } catch (err) {
      this.log.warn(
        `Could not fetch initial state for ${entityId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  private applyState(state: HAState): void {
    if (!state?.entity_id) {
      return;
    }
    this.cache.set(state.entity_id, state);
    const listeners = this.listeners.get(state.entity_id);
    if (listeners) {
      for (const listener of listeners) {
        listener(state);
      }
    }
  }

  private startPolling(): void {
    if (this.pollTimer || this.closed) {
      return;
    }
    this.pollTimer = setInterval(() => {
      for (const entityId of this.listeners.keys()) {
        this.refreshEntityState(entityId).catch(() => {
          // already logged in refreshEntityState
        });
      }
    }, this.pollIntervalMs);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private connectWebSocket(): void {
    if (this.closed || this.wsConnecting || this.wsConnected) {
      return;
    }
    this.wsConnecting = true;

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.wsUrl);
    } catch (err) {
      this.wsConnecting = false;
      this.log.warn('Failed to open Home Assistant WebSocket:', err);
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.on('message', (data: WebSocket.RawData) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.handleWsMessage(socket, message);
    });

    socket.on('close', () => {
      this.wsConnecting = false;
      const wasConnected = this.wsConnected;
      this.wsConnected = false;
      this.ws = undefined;
      if (wasConnected) {
        this.log.warn(
          'Home Assistant WebSocket disconnected, falling back to polling',
        );
      }
      this.startPolling();
      this.scheduleReconnect();
    });

    socket.on('error', (err: Error) => {
      this.log.debug('Home Assistant WebSocket error:', err.message);
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connectWebSocket();
    }, this.reconnectIntervalMs);
  }

  private handleWsMessage(
    socket: WebSocket,
    message: Record<string, unknown>,
  ): void {
    switch (message.type) {
      case 'auth_required':
        socket.send(JSON.stringify({ type: 'auth', access_token: this.token }));
        break;

      case 'auth_invalid':
        this.log.error(
          'Home Assistant rejected the configured long-lived access token',
        );
        socket.close();
        break;

      case 'auth_ok':
        this.wsConnecting = false;
        this.wsConnected = true;
        this.subscribeToWatchedEntities(socket);
        break;

      case 'event':
        this.handleTriggerEvent(message);
        break;

      case 'result':
        if (message.success === false) {
          this.log.debug('Home Assistant WebSocket command failed:', message.error);
        }
        break;

      default:
        break;
    }
  }

  private subscribeToWatchedEntities(socket: WebSocket): void {
    const entityIds = [...this.listeners.keys()];
    if (entityIds.length === 0) {
      return;
    }
    socket.send(
      JSON.stringify({
        id: this.nextMessageId++,
        type: 'subscribe_trigger',
        trigger: {
          platform: 'state',
          entity_id: entityIds,
        },
      }),
    );
    // Once the subscription covers everything we care about, real-time events
    // make polling redundant.
    this.stopPolling();
  }

  private handleTriggerEvent(message: Record<string, unknown>): void {
    const event = message.event as
      | { variables?: { trigger?: { to_state?: HAState } } }
      | undefined;
    const toState = event?.variables?.trigger?.to_state;
    if (toState) {
      this.applyState(toState);
    }
  }
}
