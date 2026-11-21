import type { CommandInput, MqttGateway } from '../../infrastructure/mqtt/index.js';

/**
 * Sends wash commands to the ESP. The ESP decides whether a command is allowed, and owns the timer.
 * Commands are never queued: the gateway rejects them at once when the broker or machine is offline.
 * A stop never waits for another request.
 */
export class WashControlService {
  constructor(private readonly gateway: Pick<MqttGateway, 'sendCommand'>) {}

  start(wash: number): Promise<void> {
    return this.send({ action: 'start', wash });
  }

  pause(): Promise<void> {
    return this.send({ action: 'pause' });
  }

  resume(): Promise<void> {
    return this.send({ action: 'resume' });
  }

  stop(): Promise<void> {
    return this.send({ action: 'stop' });
  }

  private send(input: CommandInput): Promise<void> {
    return this.gateway.sendCommand(input);
  }
}
