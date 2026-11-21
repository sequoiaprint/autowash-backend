import { createRuntime } from './bootstrap.js';
import { loadEnv } from './config/env.js';
import { createLogger } from './core/logger.js';

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL, env.NODE_ENV === 'development');
const runtime = createRuntime(env, logger);

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');
  const force = setTimeout(() => {
    logger.error('Forced exit after shutdown timeout');
    process.exit(1);
  }, 10_000);
  force.unref();
  try {
    await runtime.stop();
    logger.info('Shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Error during shutdown');
    process.exit(1);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await runtime.start(env.PORT, '0.0.0.0');
  logger.info({ port: env.PORT, mqtt: env.MQTT_URL }, 'Autowash backend listening');
} catch (err) {
  logger.error({ err }, 'Failed to start');
  await runtime.stop().catch(() => undefined);
  process.exit(1);
}
