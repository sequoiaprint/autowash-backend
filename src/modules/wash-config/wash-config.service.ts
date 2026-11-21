import type { Logger } from 'pino';
import { AppError } from '../../core/app-error.js';
import type { Page } from '../../core/pagination.js';
import {
  configSchema,
  isActiveState,
  machineBusy,
  machineOffline,
  newRequestId,
  type Config,
  type MqttGateway,
  type Sequence,
  type Timing,
} from '../../infrastructure/mqtt/index.js';
import type { ConfigChange, MachineService } from '../machine/index.js';
import type { WashConfigRepository } from './wash-config.repository.js';
import type { ConfigChangeLog, ConfigChangeType, NewConfigChangeLog } from './wash-config.types.js';

interface SaveRequest {
  changeType: ConfigChangeType;
  washNumber: number | null;
  /** The raw request, kept for the log when the full config could not be built. */
  raw: unknown;
  build: (current: Config) => Config;
}

export interface WashConfigDeps {
  machine: MachineService;
  gateway: Pick<MqttGateway, 'sendConfig' | 'isConfigSavePending'>;
  repository: WashConfigRepository;
  logger: Logger;
}

export class WashConfigService {
  constructor(private readonly deps: WashConfigDeps) {}

  /** Starts logging settings that were changed outside this API. */
  start(): void {
    this.deps.machine.on('config', (change) => this.onConfigChange(change));
  }

  saveSequence(washNumber: number, steps: Sequence): Promise<Config> {
    return this.save({
      changeType: 'SEQUENCE',
      washNumber,
      raw: { washNumber, steps },
      build: (current) => {
        const washes = [...current.washes] as Config['washes'];
        washes[washNumber - 1] = steps;
        return { washes, timing: current.timing };
      },
    });
  }

  saveTiming(timing: Timing): Promise<Config> {
    return this.save({
      changeType: 'TIMING',
      washNumber: null,
      raw: { timing },
      build: (current) => ({ washes: current.washes, timing }),
    });
  }

  history(page: number, limit: number): Promise<Page<ConfigChangeLog>> {
    return this.deps.repository.list(page, limit);
  }

  /** Merges the change into the latest config, sends the full payload and returns after the ESP acks. */
  private async save(request: SaveRequest): Promise<Config> {
    const { machine, gateway } = this.deps;
    const previous = machine.getConfig();
    let requested: Config | null = null;
    let requestId: string | null = null;
    try {
      if (!machine.isReady()) throw machineOffline();
      if (!previous) throw new AppError(503, 'CONFIG_UNKNOWN', 'The machine settings are not known yet');
      const status = machine.getStatus();
      if (status && isActiveState(status.state)) throw machineBusy('A wash is active, so settings cannot be changed');

      requested = configSchema.parse(request.build(previous));
      requestId = newRequestId();
      await gateway.sendConfig(requestId, requested);
    } catch (err) {
      const error = err instanceof AppError ? err : new AppError(500, 'INTERNAL_ERROR', 'Something went wrong');
      await this.log({
        requestId,
        changeType: request.changeType,
        washNumber: request.washNumber,
        previousConfig: previous,
        requestedConfig: requested ?? request.raw,
        result: error.code === 'MACHINE_TIMEOUT' ? 'TIMED_OUT' : 'REJECTED',
        errorCode: error.code,
      });
      throw err;
    }
    await this.log({
      requestId,
      changeType: request.changeType,
      washNumber: request.washNumber,
      previousConfig: previous,
      requestedConfig: requested,
      result: 'APPLIED',
      errorCode: null,
    });
    return requested;
  }

  private onConfigChange({ previous, next, changed }: ConfigChange): void {
    // The first config after startup is not a change. Our own saves are logged by save().
    if (!previous || !changed || this.deps.gateway.isConfigSavePending()) return;
    void this.log({
      requestId: null,
      changeType: 'EXTERNAL',
      washNumber: changedWash(previous, next),
      previousConfig: previous,
      requestedConfig: next,
      result: 'DETECTED',
      errorCode: null,
    });
  }

  private async log(entry: NewConfigChangeLog): Promise<void> {
    try {
      await this.deps.repository.create(entry);
    } catch (err) {
      this.deps.logger.error({ err }, 'Could not write the config change log');
    }
  }
}

/** The wash number when exactly one wash changed and the timing did not, otherwise null. */
function changedWash(previous: Config, next: Config): number | null {
  if (JSON.stringify(previous.timing) !== JSON.stringify(next.timing)) return null;
  const changed = previous.washes
    .map((steps, i) => (JSON.stringify(steps) === JSON.stringify(next.washes[i]) ? 0 : i + 1))
    .filter((n) => n > 0);
  return changed.length === 1 ? (changed[0] ?? null) : null;
}
