import type { Config, MachineStatus } from '../../infrastructure/mqtt/index.js';

/** Same shape for GET /machine/state and the Socket.IO machine:snapshot event. */
export interface MachineSnapshot {
  brokerConnected: boolean;
  machineOnline: boolean;
  status: MachineStatus | null;
  config: Config | null;
  updatedAt: string | null;
}

export interface ConfigChange {
  /** null for the first config seen after startup. */
  previous: Config | null;
  next: Config;
  /** false when the ESP republished the same settings. */
  changed: boolean;
}
