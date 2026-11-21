import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { MqttClient } from 'mqtt';
import type { Logger } from 'pino';
import { AppError } from '../../core/app-error.js';
import { createMqttClient } from './client.js';
import {
  ackSchema,
  commandPayloadSchema,
  configSchema,
  configSetPayloadSchema,
  statusSchema,
  type Ack,
  type CommandInput,
  type Config,
  type MachineStatus,
} from './contract.js';
import { errorFromAck, machineBusy, machineOffline, machineTimeout } from './errors.js';
import { assertPublishable, subscriptionTopics, type Topics } from './topics.js';

export interface GatewayOptions {
  url: string;
  clientId: string;
  username?: string | undefined;
  password?: string | undefined;
  topics: Topics;
  ackTimeoutMs: number;
  reconnectPeriodMs?: number;
  logger: Logger;
}

export interface ConnectionState {
  brokerConnected: boolean;
  machineOnline: boolean;
}

export interface GatewayEvents {
  connection: [ConnectionState];
  status: [{ status: MachineStatus; retained: boolean }];
  config: [{ config: Config; retained: boolean }];
}

type RequestKind = 'cmd' | 'config';

interface Pending {
  kind: RequestKind;
  resolve: () => void;
  reject: (error: AppError) => void;
  timer: NodeJS.Timeout;
}

/** Request ids are 1-32 chars of A-Z a-z 0-9 - _ . 16 random bytes in base64url is 22 chars. */
export const newRequestId = (): string => randomBytes(16).toString('base64url');

/**
 * The only MQTT connection in the backend. It tracks broker and machine state, publishes commands and
 * config saves, and waits for the matching ack.
 *
 * Safety rules:
 *  - a request is rejected at once when the broker is down or the machine is offline. Nothing is queued.
 *  - the client keeps no outgoing store, so nothing is replayed after a reconnect.
 *  - there is no automatic retry. A missing ack is reported as a timeout.
 */
export class MqttGateway extends EventEmitter<GatewayEvents> {
  private client: MqttClient | null = null;
  private brokerUp = false;
  private machineUp = false;
  private readonly pending = new Map<string, Pending>();
  private configRequestId: string | null = null;

  constructor(private readonly options: GatewayOptions) {
    super();
  }

  get connection(): ConnectionState {
    return { brokerConnected: this.brokerUp, machineOnline: this.machineUp };
  }

  get ready(): boolean {
    return this.brokerUp && this.machineUp;
  }

  isConfigSavePending(): boolean {
    return this.configRequestId !== null;
  }

  start(): void {
    if (this.client) return;
    const { logger } = this.options;
    const client = createMqttClient({
      url: this.options.url,
      clientId: this.options.clientId,
      username: this.options.username,
      password: this.options.password,
      ...(this.options.reconnectPeriodMs !== undefined ? { reconnectPeriodMs: this.options.reconnectPeriodMs } : {}),
    });
    this.client = client;

    client.on('connect', () => {
      logger.info('MQTT connected');
      client.subscribe(subscriptionTopics(this.options.topics), { qos: 1 }, (err, granted) => {
        if (err) {
          logger.error({ err }, 'MQTT subscribe failed');
          return;
        }
        const refused = granted?.filter((g) => g.qos === 128).map((g) => g.topic) ?? [];
        if (refused.length) logger.error({ refused }, 'MQTT subscription refused. Check the EMQX permissions');
      });
      this.setConnection(true, this.machineUp);
    });
    client.on('close', () => {
      this.failAll(machineOffline('The connection to the broker was lost. The outcome is unknown'));
      this.setConnection(false, false);
    });
    client.on('error', (err) => logger.error({ err: err.message }, 'MQTT error'));
    client.on('reconnect', () => logger.debug('MQTT reconnecting'));
    client.on('message', (topic, payload, packet) => this.onMessage(topic, payload.toString('utf8'), packet.retain));
  }

  async stop(): Promise<void> {
    this.failAll(machineOffline('The backend is shutting down'));
    const client = this.client;
    this.client = null;
    if (client) {
      // A graceful end needs a working connection. Never let shutdown hang on a dead broker.
      if (!client.connected) {
        await client.endAsync(true);
      } else {
        const graceful = client.endAsync(false);
        const forced = new Promise<void>((resolve) =>
          setTimeout(() => void client.endAsync(true).finally(resolve), 2000).unref(),
        );
        await Promise.race([graceful, forced]);
      }
    }
    this.brokerUp = false;
    this.machineUp = false;
  }

  /** Sends a wash command and resolves when the ESP acks it. */
  sendCommand(input: CommandInput): Promise<void> {
    const parsed = commandPayloadSchema.safeParse({ id: newRequestId(), ...input });
    if (!parsed.success) throw new AppError(500, 'INVALID_PAYLOAD', 'The command payload is invalid');
    return this.request('cmd', this.options.topics.cmd, parsed.data);
  }

  /** Sends the full config and resolves when the ESP acks it. Only one save may be in flight. */
  sendConfig(requestId: string, config: Config): Promise<void> {
    const parsed = configSetPayloadSchema.safeParse({ id: requestId, ...config });
    if (!parsed.success) throw new AppError(500, 'INVALID_PAYLOAD', 'The config payload is invalid');
    if (this.configRequestId) throw machineBusy('Another save is already in progress');
    return this.request('config', this.options.topics.configSet, parsed.data);
  }

  private request(kind: RequestKind, topic: string, payload: { id: string }): Promise<void> {
    const client = this.client;
    if (!client || !this.ready || !client.connected) {
      return Promise.reject(machineOffline());
    }
    assertPublishable(this.options.topics, topic);

    return new Promise<void>((resolve, reject) => {
      const id = payload.id;
      const timer = setTimeout(() => this.settle(id, machineTimeout()), this.options.ackTimeoutMs);
      this.pending.set(id, { kind, resolve, reject, timer });
      if (kind === 'config') this.configRequestId = id;

      client.publish(topic, JSON.stringify(payload), { qos: 1, retain: false }, (err) => {
        if (err) this.settle(id, machineOffline('The message could not be sent'));
      });
    });
  }

  private settle(id: string, error?: AppError): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    if (entry.kind === 'config') this.configRequestId = null;
    if (error) entry.reject(error);
    else entry.resolve();
  }

  private failAll(error: AppError): void {
    for (const id of [...this.pending.keys()]) this.settle(id, error);
  }

  private setConnection(brokerConnected: boolean, machineOnline: boolean): void {
    if (this.brokerUp === brokerConnected && this.machineUp === machineOnline) return;
    this.brokerUp = brokerConnected;
    this.machineUp = machineOnline;
    this.emit('connection', this.connection);
  }

  private onMessage(topic: string, text: string, retained: boolean): void {
    const { topics, logger } = this.options;
    logger.trace({ topic, retained }, 'MQTT message');
    if (topic === topics.online) {
      const value = text.trim();
      if (value === 'online' || value === 'offline') this.setConnection(this.brokerUp, value === 'online');
      else logger.warn('Ignored unexpected online message');
      return;
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      logger.warn({ topic }, 'Ignored message that is not JSON');
      return;
    }

    if (topic === topics.status) {
      const status = statusSchema.safeParse(json);
      if (status.success) this.emit('status', { status: status.data, retained });
      else logger.warn({ topic, issues: status.error.issues.length }, 'Ignored invalid status');
    } else if (topic === topics.configState) {
      const config = configSchema.safeParse(json);
      if (config.success) this.emit('config', { config: config.data, retained });
      else logger.warn({ topic, issues: config.error.issues.length }, 'Ignored invalid config state');
    } else if (topic === topics.cmdAck || topic === topics.configAck) {
      const ack = ackSchema.safeParse(json);
      if (ack.success) this.onAck(topic === topics.cmdAck ? 'cmd' : 'config', ack.data);
      else logger.warn({ topic }, 'Ignored invalid ack');
    }
  }

  private onAck(kind: RequestKind, ack: Ack): void {
    const entry = this.pending.get(ack.id);
    if (!entry || entry.kind !== kind) return; // not ours, or already settled
    this.settle(ack.id, ack.ok ? undefined : errorFromAck(ack.error));
  }
}
