import { describe, expect, it } from 'vitest';
import {
  buildTopics,
  commandPayloadSchema,
  configSchema,
  configSetPayloadSchema,
  newRequestId,
  NoReplayStore,
  requestIdSchema,
  sequenceSchema,
  statusSchema,
  timingSchema,
} from '../src/infrastructure/mqtt/index.js';
import { assertPublishable } from '../src/infrastructure/mqtt/topics.js';
import { defaultConfig } from './support/fake-engine.js';

describe('request ids', () => {
  it('generates ids the firmware accepts', () => {
    for (let i = 0; i < 200; i++) expect(requestIdSchema.safeParse(newRequestId()).success).toBe(true);
    expect(new Set(Array.from({ length: 200 }, newRequestId)).size).toBe(200);
  });
  it('rejects bad ids', () => {
    for (const id of ['', 'a'.repeat(33), 'has space', 'semi;colon', 'ü']) {
      expect(requestIdSchema.safeParse(id).success).toBe(false);
    }
    expect(requestIdSchema.safeParse('a'.repeat(32)).success).toBe(true);
  });
});

describe('sequence limits', () => {
  const step = { t: 'process', m: 5 } as const;
  it('accepts 1 to 24 steps', () => {
    expect(sequenceSchema.safeParse([step]).success).toBe(true);
    expect(sequenceSchema.safeParse(Array(24).fill(step)).success).toBe(true);
  });
  it('rejects 0 and 25 steps', () => {
    expect(sequenceSchema.safeParse([]).success).toBe(false);
    expect(sequenceSchema.safeParse(Array(25).fill(step)).success).toBe(false);
  });
  it('limits minutes to 1-99 integers', () => {
    for (const m of [0, 100, 1.5, -1]) expect(sequenceSchema.safeParse([{ t: 'water', m }]).success).toBe(false);
    for (const m of [1, 99]) expect(sequenceSchema.safeParse([{ t: 'water', m }]).success).toBe(true);
  });
  it('only allows process, water, uv and break', () => {
    for (const t of ['air', 'clean', 'bogus']) expect(sequenceSchema.safeParse([{ t, m: 1 }]).success).toBe(false);
    expect(sequenceSchema.safeParse([{ t: 'break' }]).success).toBe(true);
  });
  it('omits m on break', () => {
    expect(sequenceSchema.safeParse([{ t: 'break', m: 3 }]).success).toBe(false);
    expect(sequenceSchema.safeParse([{ t: 'process' }]).success).toBe(false);
  });
});

describe('timing limits', () => {
  const ok = defaultConfig().timing;
  const patch = (path: string[], value: number) => {
    const copy = structuredClone(ok) as unknown as Record<string, Record<string, number>>;
    copy[path[0]!]![path[1]!] = value;
    return copy;
  };
  it('accepts the defaults and the limits', () => {
    expect(timingSchema.safeParse(ok).success).toBe(true);
    expect(timingSchema.safeParse(patch(['process', 'releaseMs'], 10)).success).toBe(true);
    expect(timingSchema.safeParse(patch(['process', 'releaseMs'], 5000)).success).toBe(true);
    expect(timingSchema.safeParse(patch(['uv', 'waitS'], 600)).success).toBe(true);
    expect(timingSchema.safeParse(patch(['clean', 'durMin'], 30)).success).toBe(true);
    expect(timingSchema.safeParse(patch(['air', 'sec'], 5)).success).toBe(true);
    expect(timingSchema.safeParse(patch(['air', 'sec'], 120)).success).toBe(true);
  });
  it.each([
    [['process', 'releaseMs'], 9],
    [['process', 'releaseMs'], 5001],
    [['water', 'waitS'], 0],
    [['water', 'waitS'], 601],
    [['clean', 'durMin'], 0],
    [['clean', 'durMin'], 31],
    [['air', 'sec'], 4],
    [['air', 'sec'], 121],
    [['uv', 'releaseMs'], 10.5],
  ])('rejects %j = %s', (path, value) => {
    expect(timingSchema.safeParse(patch(path as string[], value as number)).success).toBe(false);
  });
  it('needs every group', () => {
    const { air: _air, ...rest } = ok;
    expect(timingSchema.safeParse(rest).success).toBe(false);
  });
});

describe('payloads', () => {
  it('builds a config payload with all 4 washes and all timings', () => {
    const payload = { id: 'abc123', ...defaultConfig() };
    expect(configSetPayloadSchema.safeParse(payload).success).toBe(true);
    expect(configSetPayloadSchema.safeParse({ ...payload, washes: payload.washes.slice(0, 3) }).success).toBe(false);
  });
  it('accepts config/state without an id', () => {
    expect(configSchema.safeParse(defaultConfig()).success).toBe(true);
  });
  it('validates commands', () => {
    expect(commandPayloadSchema.safeParse({ id: 'a1', action: 'start', wash: 1 }).success).toBe(true);
    expect(commandPayloadSchema.safeParse({ id: 'a1', action: 'start' }).success).toBe(false);
    expect(commandPayloadSchema.safeParse({ id: 'a1', action: 'start', wash: 5 }).success).toBe(false);
    expect(commandPayloadSchema.safeParse({ id: 'a1', action: 'pause', wash: 1 }).success).toBe(false);
    expect(commandPayloadSchema.safeParse({ id: 'bad id', action: 'stop' }).success).toBe(false);
    expect(commandPayloadSchema.safeParse({ id: 'a1', action: 'explode' }).success).toBe(false);
  });
  it('parses the status example from the contract', () => {
    const status = {
      state: 'running', wash: 1, elapsedS: 192, totalS: 900, remainingS: 708, stepIndex: 0, stepNo: 1,
      stepTotal: 5, step: 'process', stepRemainingS: 108, pulse: 7, pulseTotal: 10, valve: 'wait',
      nextReleaseS: 19, next: 'air', pauseReason: 'none',
    };
    expect(statusSchema.safeParse(status).success).toBe(true);
    expect(statusSchema.safeParse({ ...status, step: null, next: null }).success).toBe(true);
    expect(statusSchema.safeParse({ ...status, state: 'flying' }).success).toBe(false);
  });
});

describe('topics', () => {
  const topics = buildTopics('autowash/ryobi2', 'relay/status');
  it('uses the contract topics', () => {
    expect(topics).toEqual({
      online: 'relay/status',
      status: 'autowash/ryobi2/status',
      configState: 'autowash/ryobi2/config/state',
      configAck: 'autowash/ryobi2/config/ack',
      cmdAck: 'autowash/ryobi2/cmd/ack',
      configSet: 'autowash/ryobi2/config/set',
      cmd: 'autowash/ryobi2/cmd',
    });
  });
  it('only allows publishing to cmd and config/set, never relay/*', () => {
    expect(() => assertPublishable(topics, topics.cmd)).not.toThrow();
    expect(() => assertPublishable(topics, topics.configSet)).not.toThrow();
    for (const bad of ['relay/status', 'relay/anything', topics.status, topics.cmdAck, 'other']) {
      expect(() => assertPublishable(topics, bad)).toThrow(/Refusing/);
    }
  });
});

describe('NoReplayStore', () => {
  it('finds a packet again for its ack, but replays nothing', async () => {
    const store = new NoReplayStore();
    let found: unknown;
    store.put({ cmd: 'publish', messageId: 7, topic: 't', payload: 'x', qos: 1, dup: false, retain: false }, () => undefined);
    store.get({ messageId: 7 }, (_err, packet) => (found = packet));
    expect(found).toBeTruthy();
    store.put({ cmd: 'publish', messageId: 1, topic: 't', payload: 'x', qos: 1, dup: false, retain: false }, () => undefined);
    const chunks: unknown[] = [];
    await new Promise<void>((resolve) => {
      const stream = store.createStream();
      stream.on('data', (c: unknown) => chunks.push(c));
      stream.on('end', () => resolve());
      stream.resume();
    });
    expect(chunks).toEqual([]);
  });
});
