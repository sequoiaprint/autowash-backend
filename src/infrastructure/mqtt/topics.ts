import { AppError } from '../../core/app-error.js';

export interface Topics {
  /** Retained "online" / "offline" from the ESP. Subscribe only. */
  online: string;
  status: string;
  configState: string;
  configAck: string;
  cmdAck: string;
  /** The only two topics the backend may publish to. */
  configSet: string;
  cmd: string;
}

export function buildTopics(root: string, onlineTopic: string): Topics {
  const base = root.replace(/\/+$/, '');
  return {
    online: onlineTopic,
    status: `${base}/status`,
    configState: `${base}/config/state`,
    configAck: `${base}/config/ack`,
    cmdAck: `${base}/cmd/ack`,
    configSet: `${base}/config/set`,
    cmd: `${base}/cmd`,
  };
}

export function subscriptionTopics(topics: Topics): string[] {
  return [topics.online, topics.status, topics.configState, topics.configAck, topics.cmdAck];
}

/** Last line of defence: never publish anywhere except cmd and config/set, and never to relay/*. */
export function assertPublishable(topics: Topics, topic: string): void {
  if (topic.startsWith('relay/') || (topic !== topics.cmd && topic !== topics.configSet)) {
    throw new AppError(500, 'FORBIDDEN_TOPIC', `Refusing to publish to ${topic}`);
  }
}
