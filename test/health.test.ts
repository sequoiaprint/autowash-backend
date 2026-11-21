import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import { createLogger } from '../src/core/logger.js';

const baseEnv = {
  PORT: '4100',
  CORS_ORIGINS: 'http://localhost:3100',
  DATABASE_URL: 'mysql://u:p@localhost:3306/x',
  MQTT_URL: 'mqtt://127.0.0.1:18830',
};
const app = createApp(parseEnv(baseEnv), createLogger('silent'));

describe('GET /api/v1/health', () => {
  it('returns ok', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { status: 'ok' } });
  });

  it('uses the error format for unknown routes', async () => {
    const res = await request(app).get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'NOT_FOUND', message: expect.any(String) },
    });
  });
});

describe('env validation', () => {
  it('requires the core variables', () => {
    expect(() => parseEnv({})).toThrow(/PORT/);
  });
  it('splits CORS_ORIGINS', () => {
    const parsed = parseEnv({ ...baseEnv, CORS_ORIGINS: 'http://a.test:1, http://b.test:2' });
    expect(parsed.CORS_ORIGINS).toEqual(['http://a.test:1', 'http://b.test:2']);
  });
  it('applies the contract defaults', () => {
    const parsed = parseEnv(baseEnv);
    expect(parsed).toMatchObject({
      MQTT_TOPIC_ROOT: 'autowash/ryobi2',
      MQTT_ONLINE_TOPIC: 'relay/status',
      MQTT_CLIENT_ID: 'autowash_backend_01',
      ACK_TIMEOUT_MS: 5000,
      STATUS_SETTLE_MS: 3000,
    });
  });
  it('refuses the ESP client id', () => {
    expect(() => parseEnv({ ...baseEnv, MQTT_CLIENT_ID: 'autowash_esp_210' })).toThrow(/ESP client ID/);
  });
  it('refuses a topic root under relay/', () => {
    expect(() => parseEnv({ ...baseEnv, MQTT_TOPIC_ROOT: 'relay/x' })).toThrow(/relay/);
  });
});
