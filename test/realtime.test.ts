import type { Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, waitFor, type Harness } from './support/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

function collect(socket: Socket, event: string): unknown[] {
  const received: unknown[] = [];
  socket.on(event, (payload: unknown) => received.push(payload));
  return received;
}

describe('Socket.IO events', () => {
  it('sends machine:snapshot on connect, in the same shape as GET /machine/state', async () => {
    h = await createHarness();
    const socket = h.socket();
    const snapshots = collect(socket, 'machine:snapshot');
    await waitFor(() => snapshots.length === 1, 3000, 'snapshot');
    const api = (await h.api('GET', '/machine/state')).body.data;
    expect(snapshots[0]).toEqual(api);
    expect(Object.keys(snapshots[0] as object).sort()).toEqual(['brokerConnected', 'config', 'machineOnline', 'status', 'updatedAt']);
  });

  it('sends machine:status for every status', async () => {
    h = await createHarness();
    const socket = h.socket();
    const statuses = collect(socket, 'machine:status');
    await waitFor(() => socket.connected, 3000, 'connected');
    await h.api('POST', '/wash-control/start', { wash: 1 });
    await waitFor(() => (statuses.at(-1) as { state?: string } | undefined)?.state === 'running', 3000, 'running status');
    h.esp.advance(3);
    await waitFor(() => (statuses.at(-1) as { elapsedS?: number } | undefined)?.elapsedS === 3, 3000, 'status at 3 s');
    expect(statuses.at(-1)).toMatchObject({ state: 'running', wash: 1, elapsedS: 3 });
  });

  it('sends machine:config after a save', async () => {
    h = await createHarness();
    const socket = h.socket();
    const configs = collect(socket, 'machine:config');
    await waitFor(() => socket.connected, 3000, 'connected');
    const saved = await h.api('PUT', '/wash-config/sequences/4', { steps: [{ t: 'water', m: 6 }] });
    expect(saved.status).toBe(200);
    await waitFor(() => configs.length >= 1, 3000, `config event (got ${configs.length})`);
    expect((configs[0] as { washes: unknown[] }).washes[3]).toEqual([{ t: 'water', m: 6 }]);
  });

  it('sends machine:connection when the machine goes offline and returns', async () => {
    h = await createHarness();
    const socket = h.socket();
    const events = collect(socket, 'machine:connection');
    await waitFor(() => socket.connected, 3000, 'connected');
    await h.esp.goOffline();
    await waitFor(() => events.length === 1, 3000, 'offline event');
    expect(events[0]).toEqual({ brokerConnected: true, machineOnline: false });
    await h.esp.start();
    await waitFor(() => events.length === 2, 3000, 'online event');
    expect(events[1]).toEqual({ brokerConnected: true, machineOnline: true });
  });

  it('sends machine:connection when the broker connection is lost', async () => {
    h = await createHarness();
    const socket = h.socket();
    const events = collect(socket, 'machine:connection');
    await waitFor(() => socket.connected, 3000, 'connected');
    h.broker.dropClient('autowash_backend_test');
    await waitFor(() => events.length >= 1, 3000, 'event');
    expect(events[0]).toEqual({ brokerConnected: false, machineOnline: false });
    await waitFor(() => h!.runtime.machine.isReady(), 5000, 'recovered');
  });

  it('a client that connects mid-wash gets the live state, so a reload restores it', async () => {
    h = await createHarness();
    await h.api('POST', '/wash-control/start', { wash: 1 });
    h.esp.advance(42);
    await waitFor(() => h!.runtime.machine.getStatus()?.elapsedS === 42, 3000, 'status');
    const socket = h.socket();
    const snapshots = collect(socket, 'machine:snapshot');
    await waitFor(() => snapshots.length === 1, 3000, 'snapshot');
    expect(snapshots[0]).toMatchObject({ status: { state: 'running', wash: 1, elapsedS: 42 } });
  });
});
