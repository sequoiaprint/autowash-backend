import type { Server as HttpServer } from 'node:http';
import type { Logger } from 'pino';
import { Server } from 'socket.io';
import type { MachineService } from '../../modules/machine/index.js';

export interface RealtimeOptions {
  httpServer: HttpServer;
  origins: string[];
  machine: MachineService;
  logger: Logger;
}

export interface Realtime {
  io: Server;
  close(): Promise<void>;
}

/**
 * Pushes machine updates to the tablet. Server to client only:
 * machine:snapshot (on connect), machine:status, machine:config, machine:connection.
 */
export function createRealtime({ httpServer, origins, machine, logger }: RealtimeOptions): Realtime {
  const io = new Server(httpServer, { cors: { origin: origins } });

  io.on('connection', (socket) => {
    logger.debug({ id: socket.id }, 'Socket connected');
    socket.emit('machine:snapshot', machine.getSnapshot());
  });

  machine.on('status', (status) => io.emit('machine:status', status));
  machine.on('config', ({ next, changed }) => {
    if (changed) io.emit('machine:config', next);
  });
  machine.on('connection', ({ brokerConnected, machineOnline }) =>
    io.emit('machine:connection', { brokerConnected, machineOnline }),
  );

  return {
    io,
    // io.close() also closes the HTTP server
    close: () =>
      new Promise<void>((resolve) => {
        void io.close(() => resolve());
        httpServer.closeAllConnections();
      }),
  };
}
