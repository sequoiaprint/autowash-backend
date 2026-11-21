import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import type {
  Config,
  ConnectionState,
  MachineStatus,
  MqttGateway,
} from '../../infrastructure/mqtt/index.js';
import type { ConfigChange, MachineSnapshot } from './machine.types.js';

export interface MachineEvents {
  /** Every status, for the live display. */
  status: [MachineStatus];
  config: [ConfigChange];
  connection: [ConnectionState];
  /**
   * Statuses that are safe to use for run tracking. While the machine is offline or its state is
   * unknown, retained statuses may be stale, so they are held back. After the machine is confirmed
   * online, the first live status is used, or the newest one received after the settle window.
   */
  trackedStatus: [MachineStatus];
}

export interface MachineServiceOptions {
  settleMs: number;
  logger: Logger;
  now?: () => Date;
}

/** Live cache of the machine: connection, status and stored config. Never a source of truth. */
export class MachineService extends EventEmitter<MachineEvents> {
  private status: MachineStatus | null = null;
  private config: Config | null = null;
  private updatedAt: Date | null = null;

  // Settle state for run tracking
  private settled = false;
  private newest: MachineStatus | null = null;
  private settleTimer: NodeJS.Timeout | null = null;

  private readonly now: () => Date;

  constructor(
    private readonly gateway: MqttGateway,
    private readonly options: MachineServiceOptions,
  ) {
    super();
    this.now = options.now ?? (() => new Date());
    gateway.on('connection', (state) => this.onConnection(state));
    gateway.on('status', ({ status, retained }) => this.onStatus(status, retained));
    gateway.on('config', ({ config }) => this.onConfig(config));
  }

  getSnapshot(): MachineSnapshot {
    const { brokerConnected, machineOnline } = this.gateway.connection;
    return {
      brokerConnected,
      machineOnline,
      status: this.status,
      config: this.config,
      updatedAt: this.updatedAt ? this.updatedAt.toISOString() : null,
    };
  }

  getConfig(): Config | null {
    return this.config;
  }

  getStatus(): MachineStatus | null {
    return this.status;
  }

  /** True when the broker is connected and the machine reports online. */
  isReady(): boolean {
    return this.gateway.ready;
  }

  stop(): void {
    this.clearTimer();
  }

  private touch(): void {
    this.updatedAt = this.now();
  }

  private clearTimer(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }

  private onConnection(state: ConnectionState): void {
    this.touch();
    const wasSettling = this.settled || this.settleTimer !== null;
    if (state.brokerConnected && state.machineOnline) {
      if (!wasSettling) this.beginSettle();
    } else {
      // Offline or unknown: hold back run tracking. An open run stays open.
      this.settled = false;
      this.clearTimer();
    }
    this.emit('connection', state);
  }

  private beginSettle(): void {
    this.settled = false;
    this.clearTimer();
    this.settleTimer = setTimeout(() => this.finishSettle(), this.options.settleMs);
  }

  private finishSettle(): void {
    this.clearTimer();
    this.settled = true;
    const newest = this.newest;
    this.newest = null;
    if (newest) this.emit('trackedStatus', newest);
  }

  private onStatus(status: MachineStatus, retained: boolean): void {
    this.status = status;
    this.touch();
    this.emit('status', status);

    if (!this.gateway.ready) {
      this.newest = status; // held until the machine is confirmed online
    } else if (this.settled) {
      this.emit('trackedStatus', status);
    } else if (!retained) {
      // A live status after the machine came online is fresh: use it now.
      this.newest = status;
      this.finishSettle();
    } else {
      this.newest = status; // possibly stale. Wait for a live one or the end of the settle window.
    }
  }

  private onConfig(next: Config): void {
    const previous = this.config;
    const changed = previous === null || JSON.stringify(previous) !== JSON.stringify(next);
    this.config = next;
    this.touch();
    this.emit('config', { previous, next, changed });
  }
}
