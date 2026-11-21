import { createServer, type Server } from 'node:http';
import type { Logger } from 'pino';
import { createApp } from './app.js';
import type { Env } from './config/env.js';
import { createPrismaClient, type PrismaClient } from './core/prisma.js';
import { buildTopics, MqttGateway } from './infrastructure/mqtt/index.js';
import { createRealtime, type Realtime } from './infrastructure/realtime/index.js';
import { MachineService } from './modules/machine/index.js';
import { WashConfigRepository, WashConfigService } from './modules/wash-config/index.js';
import { WashControlService } from './modules/wash-control/index.js';
import { WashRunRepository, WashRunsService, WashRunTracker } from './modules/wash-runs/index.js';

export type RuntimeEnv = Pick<
  Env,
  | 'CORS_ORIGINS'
  | 'DATABASE_URL'
  | 'MQTT_URL'
  | 'MQTT_USERNAME'
  | 'MQTT_PASSWORD'
  | 'MQTT_CLIENT_ID'
  | 'MQTT_TOPIC_ROOT'
  | 'MQTT_ONLINE_TOPIC'
  | 'ACK_TIMEOUT_MS'
  | 'STATUS_SETTLE_MS'
>;

export interface RuntimeOptions {
  /** Use an existing Prisma client (tests). It is not disconnected on stop. */
  prisma?: PrismaClient;
  reconnectPeriodMs?: number;
}

export interface Runtime {
  server: Server;
  gateway: MqttGateway;
  machine: MachineService;
  tracker: WashRunTracker;
  realtime: Realtime;
  /** Starts the run tracker, the MQTT connection and the HTTP server. */
  start(port: number, host: string): Promise<void>;
  /** Stops everything in order. Safe to call twice. */
  stop(): Promise<void>;
}

export function createRuntime(env: RuntimeEnv, logger: Logger, options: RuntimeOptions = {}): Runtime {
  const ownsPrisma = !options.prisma;
  const prisma = options.prisma ?? createPrismaClient(env.DATABASE_URL);

  const gateway = new MqttGateway({
    url: env.MQTT_URL,
    clientId: env.MQTT_CLIENT_ID,
    username: env.MQTT_USERNAME,
    password: env.MQTT_PASSWORD,
    topics: buildTopics(env.MQTT_TOPIC_ROOT, env.MQTT_ONLINE_TOPIC),
    ackTimeoutMs: env.ACK_TIMEOUT_MS,
    ...(options.reconnectPeriodMs !== undefined ? { reconnectPeriodMs: options.reconnectPeriodMs } : {}),
    logger: logger.child({ part: 'mqtt' }),
  });
  const machine = new MachineService(gateway, { settleMs: env.STATUS_SETTLE_MS, logger: logger.child({ part: 'machine' }) });

  const runStore = new WashRunRepository(prisma);
  const tracker = new WashRunTracker({ machine, store: runStore, logger: logger.child({ part: 'runs' }) });
  const washConfig = new WashConfigService({
    machine,
    gateway,
    repository: new WashConfigRepository(prisma),
    logger: logger.child({ part: 'config' }),
  });
  const washControl = new WashControlService(gateway);
  const washRuns = new WashRunsService(runStore);

  const app = createApp(env, logger, { machine, washConfig, washControl, washRuns });
  const server = createServer(app);
  const realtime = createRealtime({ httpServer: server, origins: env.CORS_ORIGINS, machine, logger });

  let stopped = false;
  return {
    server,
    gateway,
    machine,
    tracker,
    realtime,
    async start(port, host) {
      await tracker.start();
      washConfig.start();
      gateway.start();
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await gateway.stop(); // no more MQTT input or output
      machine.stop();
      await realtime.close(); // closes sockets and the HTTP server
      await tracker.stop(); // saves the latest elapsed time
      if (ownsPrisma) await prisma.$disconnect();
    },
  };
}
