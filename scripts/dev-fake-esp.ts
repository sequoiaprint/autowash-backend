// Starts the fake MQTT broker and a fake ESP32 for manual testing. Never touches the real EMQX.
//
//   npm run dev:fake-esp                 broker on 127.0.0.1:18830, machine time x10
//   npm run dev:fake-esp -- 60           machine time x60
//
// Then start the backend with:  $env:MQTT_URL='mqtt://127.0.0.1:18830'; npm run dev
import { MANUAL_BROKER_PORT, TestBroker } from '../test/support/broker.js';
import { FakeEsp } from '../test/support/fake-esp.js';

const speed = Number(process.argv[2] ?? 10);
if (!Number.isFinite(speed) || speed <= 0) throw new Error('speed must be a positive number');

const broker = await TestBroker.start(MANUAL_BROKER_PORT);
const esp = new FakeEsp({ url: broker.url });
await esp.start();
esp.startAuto(speed);
console.log(`Fake broker on ${broker.url}, fake ESP online, machine time x${speed}`);
console.log('Press Ctrl+C to stop.');

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await esp.shutdown().catch(() => undefined);
  await broker.stop();
  process.exit(0);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
