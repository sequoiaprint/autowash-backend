import { AppError } from '../../core/app-error.js';
import type { AckError } from './contract.js';

export const machineOffline = (message = 'The machine is offline, so nothing was sent'): AppError =>
  new AppError(503, 'MACHINE_OFFLINE', message);

export const machineTimeout = (): AppError =>
  new AppError(504, 'MACHINE_TIMEOUT', 'The machine did not answer in time. Check its status before trying again');

export const machineBusy = (message = 'The machine is busy'): AppError =>
  new AppError(409, 'MACHINE_BUSY', message);

/** Maps an error code from the ESP ack to the HTTP error returned to the client. */
export function errorFromAck(error: AckError | undefined): AppError {
  switch (error) {
    case 'busy':
      return machineBusy('A wash is running, so the machine did not apply this');
    case 'not_running':
      return new AppError(409, 'INVALID_MACHINE_STATE', 'The wash is not running');
    case 'not_paused':
      return new AppError(409, 'INVALID_MACHINE_STATE', 'The wash is not paused');
    case 'storage':
      return new AppError(500, 'MACHINE_STORAGE_ERROR', 'The machine could not store the settings');
    case 'invalid':
    case 'bad_command':
    default:
      return new AppError(422, 'MACHINE_REJECTED', 'The machine rejected the request');
  }
}
