import mqtt, { Store, type IClientOptions, type MqttClient } from 'mqtt';

/**
 * An outgoing store that never replays anything.
 *
 * mqtt.js keeps unacknowledged QoS 1 messages in its store and re-sends them after a reconnect.
 * A wash command must never be sent late, so this store behaves like the normal one while the
 * connection is up (the packet must be found again when the broker's PUBACK arrives) but, whenever
 * the client asks for the messages to replay after a reconnect, it throws them away and returns none.
 */
export class NoReplayStore extends Store {
  override createStream(): ReturnType<Store['createStream']> {
    (this as unknown as { _inflights?: Map<number, unknown> })._inflights?.clear();
    return new Store().createStream(); // always empty
  }
}

export interface MqttClientSettings {
  url: string;
  clientId: string;
  username?: string | undefined;
  password?: string | undefined;
  reconnectPeriodMs?: number;
}

export function buildClientOptions(settings: MqttClientSettings): IClientOptions {
  return {
    clientId: settings.clientId,
    ...(settings.username ? { username: settings.username } : {}),
    ...(settings.password ? { password: settings.password } : {}),
    protocolVersion: 4,
    clean: true, // clean session: the broker keeps nothing for us between connections
    keepalive: 15,
    connectTimeout: 5000,
    reconnectPeriod: settings.reconnectPeriodMs ?? 2000,
    resubscribe: false, // the gateway subscribes explicitly on every connect
    queueQoSZero: false,
    outgoingStore: new NoReplayStore(),
  };
}

export function createMqttClient(settings: MqttClientSettings): MqttClient {
  return mqtt.connect(settings.url, buildClientOptions(settings));
}
