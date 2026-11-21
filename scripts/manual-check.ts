// Runs the built backend (dist/server.js) as a separate process against the fake broker and fake ESP,
// and walks through the manual scenarios. It never connects to the real EMQX.
//
//   npm run build
//   npm run verify:manual
//
// It uses TEST_DATABASE_URL from .env (the autowash_test database), never the autowash database.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createPrismaClient, type PrismaClient } from '../src/core/prisma.js';
import { assertLocalBrokerUrl, MANUAL_BROKER_PORT, TestBroker } from '../test/support/broker.js';
import { FakeEsp } from '../test/support/fake-esp.js';
import { getTestDatabaseUrl } from '../test/support/test-db.js';

const PORT = 4100;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

if (!existsSync('dist/server.js')) throw new Error('Run npm run build first');
const databaseUrl = getTestDatabaseUrl();
const prisma: PrismaClient = createPrismaClient(databaseUrl);
await prisma.washRun.deleteMany();
await prisma.configChangeLog.deleteMany();

const broker = await TestBroker.start(MANUAL_BROKER_PORT);
assertLocalBrokerUrl(broker.url);
const esp = new FakeEsp({ url: broker.url });
await esp.start();

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

interface MachineData {
  brokerConnected: boolean;
  machineOnline: boolean;
  config: unknown;
  status: { state: string; step: string | null; next: string | null; elapsedS: number; remainingS: number };
  total: number;
}
interface ApiResult {
  status: number;
  body: { data: MachineData; error: { code: string } };
}

async function api(method: string, path: string, body?: unknown): Promise<ApiResult> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as ApiResult['body'] };
}

async function until(fn: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
}

const machine = async () => (await api('GET', '/machine/state')).body.data;
const runs = () => prisma.washRun.findMany({ orderBy: { startedAt: 'asc' } });

let backend: ChildProcess | null = null;
let backendLog = '';

async function startBackend(): Promise<void> {
  backend = spawn(process.execPath, ['dist/server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
      CORS_ORIGINS: 'http://localhost:3100',
      DATABASE_URL: databaseUrl,
      MQTT_URL: broker.url, // the fake broker only
      MQTT_CLIENT_ID: 'autowash_backend_manual',
      STATUS_SETTLE_MS: '1500',
      ACK_TIMEOUT_MS: '3000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout?.on('data', (d: Buffer) => (backendLog += d.toString()));
  backend.stderr?.on('data', (d: Buffer) => (backendLog += d.toString()));
  const up = await until(async () => {
    try {
      const m = await machine();
      return m.brokerConnected && m.machineOnline && !!m.config && !!m.status;
    } catch {
      return false;
    }
  });
  check('backend started and sees the machine', up);
  await sleep(1800); // let the first retained status settle
}

async function stopBackend(): Promise<void> {
  const child = backend;
  if (!child) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGINT'); // note: on Windows this ends the process without running handlers
  });
  backend = null;
}

try {
  await startBackend();

  // Save a sequence and the timing
  const steps = [{ t: 'process', m: 2 }, { t: 'break' }, { t: 'water', m: 1 }];
  let r = await api('PUT', '/wash-config/sequences/1', { steps });
  check('save sequence', r.status === 200 && JSON.stringify(esp.config.washes[0]) === JSON.stringify(steps), `HTTP ${r.status}`);
  const timing = { ...esp.config.timing, process: { releaseMs: 150, waitS: 10 }, air: { sec: 10 } };
  r = await api('PUT', '/wash-config/timing', { timing });
  check('save timing', r.status === 200 && esp.config.timing.air.sec === 10, `HTTP ${r.status}`);
  const history = await api('GET', '/wash-config/history');
  check('config change log has both saves', history.body.data.total === 2);

  // Start wash 1 (process 120 s + air 10 + break + water 60 + air 10 + clean 120)
  r = await api('POST', '/wash-control/start', { wash: 1 });
  check('start wash 1', r.status === 200, `HTTP ${r.status}`);
  esp.advance(40);
  await until(async () => (await machine()).status.elapsedS === 40);
  let m = await machine();
  check('status shows running at 40 s', m.status.state === 'running' && m.status.step === 'process' && m.status.elapsedS === 40);
  check('a save is refused while a wash is active', (await api('PUT', '/wash-config/timing', { timing })).status === 409);

  // Pause and resume
  r = await api('POST', '/wash-control/pause');
  check('pause', r.status === 200);
  await until(async () => (await machine()).status.state === 'paused');
  r = await api('POST', '/wash-control/resume');
  check('resume', r.status === 200);
  await until(async () => (await machine()).status.state === 'running');

  // Run to the break (120 + 10 = 130 s)
  esp.advance(90);
  await until(async () => (await machine()).status.state === 'break');
  m = await machine();
  check('wash reaches the break and waits', m.status.state === 'break' && m.status.next === 'water');
  r = await api('POST', '/wash-control/resume');
  check('resume from the break', r.status === 200);
  await until(async () => (await machine()).status.state === 'running');

  // Finish (water 60 + air 10 + clean 120 = 190 s)
  esp.advance(190);
  await until(async () => (await machine()).status.state === 'done');
  m = await machine();
  check('wash finishes (done)', m.status.state === 'done' && m.status.remainingS === 0);
  await sleep(300);
  let all = await runs();
  check('run recorded as COMPLETED with 1 break and 1 pause', all.length === 1 && all[0]!.outcome === 'COMPLETED' && all[0]!.breakCount === 1 && all[0]!.pauseCount === 1, JSON.stringify(all.map((x) => [x.outcome, x.breakCount, x.pauseCount])));

  // Stop during a second wash
  await api('POST', '/wash-control/start', { wash: 2 });
  await until(async () => (await machine()).status.state === 'running');
  esp.advance(15);
  await until(async () => (await machine()).status.elapsedS === 15);
  r = await api('POST', '/wash-control/stop');
  check('stop', r.status === 200);
  await until(async () => (await machine()).status.state === 'stopped');
  await sleep(300);
  all = await runs();
  check('second run recorded as STOPPED', all.length === 2 && all[1]!.outcome === 'STOPPED');

  // Machine offline
  await esp.goOffline();
  check('machine goes offline', await until(async () => (await machine()).machineOnline === false));
  const before = broker.on('autowash/ryobi2/cmd').length;
  r = await api('POST', '/wash-control/start', { wash: 1 });
  check('start is rejected with 503 MACHINE_OFFLINE', r.status === 503 && r.body.error.code === 'MACHINE_OFFLINE');
  check('nothing was published while offline', broker.on('autowash/ryobi2/cmd').length === before);
  await esp.start();
  check('machine returns online', await until(async () => (await machine()).machineOnline === true));

  // Backend restart during a wash
  await api('POST', '/wash-control/start', { wash: 1 });
  await until(async () => (await machine()).status.state === 'running');
  esp.advance(60);
  await until(async () => (await machine()).status.elapsedS === 60);
  await sleep(200);
  const openBefore = (await runs()).find((x) => x.outcome === 'IN_PROGRESS');
  check('a run is open before the restart', !!openBefore);
  await stopBackend();
  esp.advance(20); // the wash goes on while the backend is down
  await startBackend();
  esp.advance(5);
  await sleep(2500);
  all = await runs();
  const open = all.filter((x) => x.outcome === 'IN_PROGRESS');
  check('the same run continues after the restart (no duplicate)', open.length === 1 && open[0]!.id === openBefore?.id, `${open.length} open`);
  check('a status still comes from the machine after the restart', (await machine()).status.elapsedS >= 85);
} catch (err) {
  failures++;
  console.log('FAIL  unexpected error', err);
} finally {
  await stopBackend().catch(() => undefined);
  await esp.shutdown().catch(() => undefined);
  await broker.stop();
  await prisma.$disconnect();
}

console.log(failures === 0 ? '\nAll manual checks passed.' : `\n${failures} check(s) failed.\n--- backend log ---\n${backendLog}`);
process.exit(failures === 0 ? 0 : 1);
