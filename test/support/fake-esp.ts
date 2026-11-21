// A fake ESP32 that speaks the same MQTT contract as the real machine.
// It only ever talks to the broker it is given, which must be the local fake broker.
import mqtt, { type MqttClient } from 'mqtt';
import {
  ACK_ERRORS,
  configSchema,
  requestIdSchema,
  type AckError,
  type Config,
} from '../../src/infrastructure/mqtt/contract.js';
import { assertLocalBrokerUrl } from './broker.js';
import { defaultConfig, FakeEngine } from './fake-engine.js';

export interface FakeEspOptions {
  url: string;
  topicRoot?: string;
  onlineTopic?: string;
  clientId?: string;
}

export interface ReceivedMessage {
  topic: 'cmd' | 'config/set';
  body: Record<string, unknown>;
}

export class FakeEsp {
  config: Config = defaultConfig();
  readonly engine = new FakeEngine();
  /** Every cmd and config/set message received, in order. */
  readonly received: ReceivedMessage[] = [];
  /** The ESP processes requests but never acks them: all of them, or only commands or config saves. */
  silent: boolean | 'cmd' | 'config' = false;
  /** Command actions (for example "start", "pause") that are carried out but never acked. */
  mutedActions: string[] = [];
  /** When true the ESP does not publish config/state on connect, so the backend does not know the config. */
  withholdConfig = false;
  /** When set, the next request is refused with this error and nothing is applied. */
  failNextWith: AckError | null = null;

  readonly clientId: string;
  private client: MqttClient | null = null;
  private readonly root: string;
  private readonly onlineTopic: string;
  private autoTimer: NodeJS.Timeout | null = null;
  private lastCmd = { id: '', error: null as AckError | null };
  private lastCfg = { id: '', error: null as AckError | null };
  private lastPublished = '';

  constructor(private readonly options: FakeEspOptions) {
    assertLocalBrokerUrl(options.url);
    this.root = options.topicRoot ?? 'autowash/ryobi2';
    this.onlineTopic = options.onlineTopic ?? 'relay/status';
    this.clientId = options.clientId ?? 'autowash_esp_210';
  }

  get connected(): boolean {
    return this.client?.connected ?? false;
  }

  /** Connects like the firmware does: online first, then stored config, then status. */
  async start(): Promise<void> {
    if (this.client) return;
    const client = mqtt.connect(this.options.url, {
      clientId: this.clientId,
      clean: true,
      reconnectPeriod: 0,
      will: { topic: this.onlineTopic, payload: Buffer.from('offline'), qos: 1, retain: true },
    });
    this.client = client;
    await new Promise<void>((resolve, reject) => {
      client.once('connect', () => resolve());
      client.once('error', reject);
    });
    client.on('message', (topic, payload) => this.onMessage(topic, payload.toString('utf8')));
    await client.subscribeAsync([`${this.root}/cmd`, `${this.root}/config/set`], { qos: 1 });
    await client.publishAsync(this.onlineTopic, 'online', { qos: 1, retain: true });
    if (!this.withholdConfig) this.publishConfig();
    this.publishStatus();
  }

  /** Publishes the current status now, even if nothing changed. */
  publishStatusNow(): void {
    this.publishStatus();
  }

  /** Publishes the stored config now, as if it had been changed on the machine itself. */
  publishConfigNow(): void {
    this.publishConfig();
  }

  /** Network failure: no DISCONNECT, so the broker publishes the last will ("offline"). */
  async goOffline(): Promise<void> {
    this.stopAuto();
    const client = this.client;
    this.client = null;
    if (client) await client.endAsync(true);
  }

  /** Reboot: valves close, the wash is not resumed, stored settings are kept. */
  async restart(): Promise<void> {
    await this.goOffline();
    this.engine.reboot();
    await this.start();
  }

  /** Clean shutdown that announces "offline" itself. */
  async shutdown(): Promise<void> {
    this.stopAuto();
    const client = this.client;
    this.client = null;
    if (!client) return;
    if (!client.connected) {
      await client.endAsync(true);
      return;
    }
    await client.publishAsync(this.onlineTopic, 'offline', { qos: 1, retain: true });
    await client.endAsync(false);
  }

  /** Moves machine time forward one second at a time, publishing status like the firmware. */
  advance(seconds: number): void {
    for (let i = 0; i < seconds; i++) {
      const before = this.engine.state;
      this.engine.tick(1000);
      if (this.engine.state === 'running' || this.engine.state !== before) this.publishStatus();
    }
  }

  /** Real-time simulation for manual checks. speed 10 means ten machine seconds per real second. */
  startAuto(speed: number): void {
    this.stopAuto();
    this.autoTimer = setInterval(() => this.advance(1), 1000 / speed);
  }

  stopAuto(): void {
    if (this.autoTimer) clearInterval(this.autoTimer);
    this.autoTimer = null;
  }

  /** The ESP loses the connection for 10 seconds during a wash: it pauses itself with reason "link". */
  linkLossPause(): void {
    if (this.engine.pause('link')) this.publishStatus();
  }

  // The in-memory broker (aedes) can lose the live delivery of a retained message when the same client
  // publishes again straight away. EMQX does not. Publishing one message at a time with a short gap
  // keeps the fake broker honest without changing what the machine says. Statuses that have not been
  // sent yet are replaced by the newest one, so a long advance() does not build a backlog.
  private outbox: { suffix: string; payload: string; retain: boolean; key?: string }[] = [];
  private pumping = false;

  /** A status with the same key (same state and wash) replaces one that is still waiting to be sent. */
  private publish(suffix: string, payload: string, retain: boolean, key?: string): void {
    const queued = key ? this.outbox.find((m) => m.key === key) : undefined;
    if (queued) queued.payload = payload;
    else this.outbox.push({ suffix, payload, retain, ...(key ? { key } : {}) });
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (let next = this.outbox.shift(); next; next = this.outbox.shift()) {
        const client = this.client;
        if (!client?.connected) continue;
        await client.publishAsync(`${this.root}/${next.suffix}`, next.payload, { qos: 0, retain: next.retain }).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 8));
      }
    } finally {
      this.pumping = false;
    }
  }

  private publishStatus(): void {
    const snapshot = this.engine.snapshot();
    const payload = JSON.stringify(snapshot);
    this.lastPublished = payload;
    // only a status that follows another of the same kind at the tail of the queue is replaced
    const last = this.outbox[this.outbox.length - 1];
    const key = `status:${snapshot.state}:${snapshot.wash}:${snapshot.pauseReason}`;
    if (last && last.suffix === 'status' && last.key === key) last.payload = payload;
    else this.publish('status', payload, true, key);
  }

  private publishConfig(): void {
    this.publish('config/state', JSON.stringify(this.config), true);
  }

  private ack(suffix: 'cmd/ack' | 'config/ack', id: string, error: AckError | null): void {
    if (this.silent === true || this.silent === (suffix === 'cmd/ack' ? 'cmd' : 'config')) return;
    this.publish(suffix, JSON.stringify(error ? { id, ok: false, error } : { id, ok: true }), false);
  }

  private onMessage(topic: string, text: string): void {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    if (topic === `${this.root}/cmd`) {
      this.received.push({ topic: 'cmd', body });
      this.handleCommand(body);
    } else if (topic === `${this.root}/config/set`) {
      this.received.push({ topic: 'config/set', body });
      this.handleConfig(body);
    }
  }

  private handleCommand(body: Record<string, unknown>): void {
    const id = requestIdSchema.safeParse(body.id);
    if (!id.success) return; // the firmware does not ack a command without a valid id
    if (id.data === this.lastCmd.id) {
      this.ack('cmd/ack', id.data, this.lastCmd.error);
      return;
    }
    let error: AckError | null = this.failNextWith;
    this.failNextWith = null;
    if (!error) {
      switch (body.action) {
        case 'start':
          if (typeof body.wash !== 'number' || body.wash < 1 || body.wash > 4) error = 'bad_command';
          else if (!this.engine.start(body.wash, this.config)) error = 'busy';
          break;
        case 'pause':
          if (!this.engine.pause('operator')) error = 'not_running';
          break;
        case 'resume':
          if (!this.engine.resume()) error = 'not_paused';
          break;
        case 'stop':
          if (!this.engine.stop()) error = 'not_running';
          break;
        default:
          error = 'bad_command';
      }
    }
    this.lastCmd = { id: id.data, error };
    if (!this.mutedActions.includes(String(body.action))) this.ack('cmd/ack', id.data, error);
    this.publishStatus();
  }

  private handleConfig(body: Record<string, unknown>): void {
    const id = requestIdSchema.safeParse(body.id);
    const idText = id.success ? id.data : '';
    if (idText && idText === this.lastCfg.id) {
      this.ack('config/ack', idText, this.lastCfg.error);
      return;
    }
    const parsed = configSchema.safeParse({ washes: body.washes, timing: body.timing });
    let error: AckError | null = this.failNextWith;
    this.failNextWith = null;
    if (!error) {
      if (!parsed.success) error = 'invalid';
      else if (this.engine.isActive) error = 'busy';
    }
    if (!error && parsed.success) this.config = parsed.data;
    if (idText) this.lastCfg = { id: idText, error };
    if (!error) this.publishConfig(); // stored copy goes out before the ack
    this.ack('config/ack', idText, error);
  }

  /** For tests: the ack error names the firmware can send. */
  static readonly ackErrors = ACK_ERRORS;
  get lastStatusPayload(): string {
    return this.lastPublished;
  }
}
