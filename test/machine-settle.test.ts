// Stale retained status rules: while the machine is offline or unknown, no status is used for run tracking.
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../src/core/logger.js';
import type { MachineStatus, MqttGateway } from '../src/infrastructure/mqtt/index.js';
import { MachineService } from '../src/modules/machine/index.js';
import { sleep } from './support/harness.js';
import { done, idle, running } from './support/status.js';

class StubGateway extends EventEmitter {
  brokerConnected = false;
  machineOnline = false;
  get connection() {
    return { brokerConnected: this.brokerConnected, machineOnline: this.machineOnline };
  }
  get ready() {
    return this.brokerConnected && this.machineOnline;
  }
  setConnection(brokerConnected: boolean, machineOnline: boolean) {
    this.brokerConnected = brokerConnected;
    this.machineOnline = machineOnline;
    this.emit('connection', this.connection);
  }
  status(status: MachineStatus, retained: boolean) {
    this.emit('status', { status, retained });
  }
}

const SETTLE_MS = 80;
let gateway: StubGateway;
let machine: MachineService;
let tracked: MachineStatus[];

beforeEach(() => {
  gateway = new StubGateway();
  machine = new MachineService(gateway as unknown as MqttGateway, { settleMs: SETTLE_MS, logger: createLogger('silent') });
  tracked = [];
  machine.on('trackedStatus', (s) => tracked.push(s));
});
afterEach(() => machine.stop());

describe('stale retained status', () => {
  it('is never tracked while the machine state is unknown', async () => {
    gateway.setConnection(true, false); // broker up, no online message yet
    gateway.status(running(100), true);
    await sleep(SETTLE_MS * 2);
    expect(tracked).toEqual([]);
  });

  it('is never tracked while the machine is offline', async () => {
    gateway.setConnection(true, false);
    gateway.status(running(100), true);
    gateway.status(running(101), false);
    await sleep(SETTLE_MS * 2);
    expect(tracked).toEqual([]);
  });

  it('still updates the live cache while held back', () => {
    gateway.setConnection(true, false);
    gateway.status(running(100), true);
    expect(machine.getStatus()?.elapsedS).toBe(100);
  });
});

describe('after the machine is confirmed online', () => {
  it('uses the newest retained status after the settle window', async () => {
    gateway.setConnection(true, false);
    gateway.status(running(100), true); // arrived before the online message
    gateway.setConnection(true, true);
    gateway.status(running(105), true); // retained, possibly stale: wait
    await sleep(SETTLE_MS / 4);
    expect(tracked).toEqual([]);
    await sleep(SETTLE_MS * 2);
    expect(tracked).toEqual([running(105)]);
  });

  it('uses a fresh live status at once', async () => {
    gateway.setConnection(true, true);
    gateway.status(running(100), true);
    gateway.status(running(103), false); // live: fresh
    expect(tracked).toEqual([running(103)]);
    await sleep(SETTLE_MS * 2);
    expect(tracked).toHaveLength(1); // the timer does not repeat it
  });

  it('tracks every status once settled', async () => {
    gateway.setConnection(true, true);
    gateway.status(running(1), false);
    gateway.status(running(2), true);
    gateway.status(running(3), false);
    expect(tracked.map((s) => s.elapsedS)).toEqual([1, 2, 3]);
  });

  it('emits nothing if no status arrives', async () => {
    gateway.setConnection(true, true);
    await sleep(SETTLE_MS * 2);
    expect(tracked).toEqual([]);
  });
});

describe('machine goes offline and returns', () => {
  it('holds back statuses while offline, then settles again', async () => {
    gateway.setConnection(true, true);
    gateway.status(running(10), false);
    expect(tracked).toHaveLength(1);

    gateway.setConnection(true, false); // offline
    gateway.status(running(11), true); // stale retained
    await sleep(SETTLE_MS * 2);
    expect(tracked).toHaveLength(1);

    gateway.setConnection(true, true); // back
    await sleep(SETTLE_MS * 2);
    expect(tracked.map((s) => s.elapsedS)).toEqual([10, 11]); // newest received is used after the window
  });

  it('uses an idle status that arrives live after the machine returns', async () => {
    gateway.setConnection(true, true);
    gateway.status(running(10), false);
    gateway.setConnection(false, false); // broker lost
    gateway.setConnection(true, true);
    gateway.status(idle(), false);
    expect(tracked.at(-1)?.state).toBe('idle');
  });

  it('a retained done status after a broker restart waits for the window', async () => {
    gateway.setConnection(true, true);
    gateway.setConnection(false, false);
    gateway.setConnection(true, false);
    gateway.status(done(), true);
    await sleep(SETTLE_MS * 2);
    expect(tracked).toEqual([]);
    gateway.setConnection(true, true);
    await sleep(SETTLE_MS * 2);
    expect(tracked).toEqual([done()]);
  });
});
