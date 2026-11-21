import type { AddressInfo } from 'node:net';
import { io as connectSocket, type Socket } from 'socket.io-client';
import { createRuntime, type Runtime, type RuntimeEnv } from '../../src/bootstrap.js';
import type { PrismaClient } from '../../src/core/prisma.js';
import { createLogger } from '../../src/core/logger.js';
import { assertLocalBrokerUrl, TestBroker } from './broker.js';
import { FakeEsp } from './fake-esp.js';
import { createTestPrisma, getTestDatabaseUrl, resetTestDb } from './test-db.js';

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface HarnessOptions {
  settleMs?: number;
  ackTimeoutMs?: number;
  /** Start the fake ESP before the backend. Default true. */
  espOnline?: boolean;
  /** Keep the data from an earlier harness (used for restart tests). */
  keepData?: boolean;
  broker?: TestBroker;
  esp?: FakeEsp;
  prisma?: PrismaClient;
}

export interface ApiResult {
  status: number;
  body: { success: boolean; data?: unknown; error?: { code: string; message: string } };
}

export class Harness {
  baseUrl = '';
  runtime!: Runtime;
  private sockets: Socket[] = [];

  constructor(
    readonly broker: TestBroker,
    readonly esp: FakeEsp,
    readonly prisma: PrismaClient,
    private readonly env: RuntimeEnv,
    private readonly ownsBroker: boolean,
    private readonly ownsPrisma: boolean,
  ) {}

  /** Starts the backend on a random port against the fake broker. */
  async startBackend(): Promise<void> {
    assertLocalBrokerUrl(this.env.MQTT_URL);
    this.runtime = createRuntime(this.env, createLogger(process.env.TEST_LOG_LEVEL ?? 'silent'), { prisma: this.prisma, reconnectPeriodMs: 50 });
    await this.runtime.start(0, '127.0.0.1');
    this.baseUrl = `http://127.0.0.1:${(this.runtime.server.address() as AddressInfo).port}`;
  }

  async stopBackend(): Promise<void> {
    for (const socket of this.sockets) socket.disconnect();
    this.sockets = [];
    await this.runtime.stop();
  }

  /** Waits until the backend knows the machine is online with a config and a status. */
  async untilReady(): Promise<void> {
    await waitFor(() => {
      const s = this.runtime.machine.getSnapshot();
      return s.brokerConnected && s.machineOnline && s.config !== null && s.status !== null;
    }, 5000, 'backend ready');
    // let the first retained status settle, so a wash started now is seen as a live start
    await sleep(this.env.STATUS_SETTLE_MS + 120);
    await this.runtime.tracker.idle();
  }

  async api(method: string, path: string, body?: unknown): Promise<ApiResult> {
    const response = await fetch(`${this.baseUrl}/api/v1${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: (await response.json()) as ApiResult['body'] };
  }

  socket(): Socket {
    const socket = connectSocket(this.baseUrl, { transports: ['websocket'], forceNew: true });
    this.sockets.push(socket);
    return socket;
  }

  /** Waits for the open run in the database to match, after the tracker has caught up. */
  async tracked(): Promise<void> {
    await sleep(60);
    await this.runtime.tracker.idle();
  }

  async stop(): Promise<void> {
    await this.stopBackend().catch(() => undefined);
    await this.esp.shutdown().catch(() => undefined);
    if (this.ownsBroker) await this.broker.stop();
    if (this.ownsPrisma) await this.prisma.$disconnect();
  }
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const databaseUrl = getTestDatabaseUrl();
  const prisma = options.prisma ?? createTestPrisma();
  if (!options.keepData) await resetTestDb(prisma);
  const broker = options.broker ?? (await TestBroker.start());
  const esp = options.esp ?? new FakeEsp({ url: broker.url });
  if (options.espOnline !== false) await esp.start();

  const env: RuntimeEnv = {
    CORS_ORIGINS: ['http://localhost:3100'],
    DATABASE_URL: databaseUrl,
    MQTT_URL: broker.url,
    MQTT_USERNAME: undefined,
    MQTT_PASSWORD: undefined,
    MQTT_CLIENT_ID: 'autowash_backend_test',
    MQTT_TOPIC_ROOT: 'autowash/ryobi2',
    MQTT_ONLINE_TOPIC: 'relay/status',
    ACK_TIMEOUT_MS: options.ackTimeoutMs ?? 800,
    STATUS_SETTLE_MS: options.settleMs ?? 300,
  };
  const harness = new Harness(broker, esp, prisma, env, !options.broker, !options.prisma);
  await harness.startBackend();
  if (options.espOnline !== false) await harness.untilReady();
  return harness;
}
