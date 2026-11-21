import { createServer, type Server } from 'node:net';
import { Aedes, type Client } from 'aedes';

export const LOCAL_HOST = '127.0.0.1';
/** The port used for manual checks. Tests use random free ports. */
export const MANUAL_BROKER_PORT = 18830;
const REAL_EMQX_PORT = 1883;

/** Refuses anything that is not a loopback fake broker, so a test can never reach the real EMQX. */
export function assertLocalBrokerUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.hostname !== LOCAL_HOST || Number(parsed.port) === REAL_EMQX_PORT || !parsed.port) {
    throw new Error(`Refusing to use ${url}: only the fake broker on ${LOCAL_HOST} (not port ${REAL_EMQX_PORT}) is allowed`);
  }
}

export interface PublishedMessage {
  topic: string;
  payload: string;
  clientId: string | null;
  retain: boolean;
}

/** In-memory MQTT broker on 127.0.0.1. Records every publish. */
export class TestBroker {
  readonly published: PublishedMessage[] = [];
  private readonly clients = new Map<string, Client>();
  private constructor(
    private aedes: Aedes,
    private server: Server,
    readonly port: number,
  ) {}

  get url(): string {
    return `mqtt://${LOCAL_HOST}:${this.port}`;
  }

  static async start(port = 0): Promise<TestBroker> {
    const aedes = await Aedes.createBroker();
    const server = createServer(aedes.handle);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, LOCAL_HOST, () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No broker address');
    const broker = new TestBroker(aedes, server, address.port);
    assertLocalBrokerUrl(broker.url);
    aedes.on('client', (client) => broker.clients.set(client.id, client));
    aedes.on('clientDisconnect', (client) => broker.clients.delete(client.id));
    aedes.on('publish', (packet, client) => {
      if (packet.topic.startsWith('$SYS')) return;
      broker.published.push({
        topic: packet.topic,
        payload: packet.payload.toString(),
        clientId: client?.id ?? null,
        retain: packet.retain,
      });
    });
    return broker;
  }

  /** Messages received on a topic, optionally parsed as JSON. */
  on(topic: string): PublishedMessage[] {
    return this.published.filter((m) => m.topic === topic);
  }

  /** Cuts a client's network connection without a DISCONNECT, as a network failure would. */
  dropClient(clientId: string): void {
    this.clients.get(clientId)?.conn.destroy();
  }

  private stopped = false;

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await new Promise<void>((resolve) => this.aedes.close(() => resolve()));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
