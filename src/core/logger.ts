import pino from 'pino';

export function createLogger(level = 'info', pretty = false): pino.Logger {
  return pino({
    level,
    ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
  });
}
