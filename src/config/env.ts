import { existsSync } from 'node:fs';
import { z } from 'zod';

/** The real ESP32 uses this client ID. The backend must never connect with it. */
export const ESP_CLIENT_ID = 'autowash_esp_210';

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535),
  CORS_ORIGINS: z
    .string()
    .min(1)
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.url()).min(1)),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1),
  MQTT_URL: z.string().regex(/^mqtts?:\/\//, 'must start with mqtt:// or mqtts://'),
  MQTT_USERNAME: z.string().optional(),
  MQTT_PASSWORD: z.string().optional(),
  MQTT_CLIENT_ID: z
    .string()
    .min(1)
    .default('autowash_backend_01')
    .refine((id) => id !== ESP_CLIENT_ID, `must not be the ESP client ID (${ESP_CLIENT_ID})`),
  MQTT_TOPIC_ROOT: z
    .string()
    .min(1)
    .default('autowash/ryobi2')
    .refine((root) => !root.startsWith('relay'), 'must not be under relay/'),
  MQTT_ONLINE_TOPIC: z.string().min(1).default('relay/status'),
  ACK_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  STATUS_SETTLE_MS: z.coerce.number().int().min(0).default(3000),
});

export type Env = z.infer<typeof schema>;

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${details}`);
  }
  return result.data;
}

/** Loads .env (if present) into process.env without overriding real variables, then validates. */
export function loadEnv(): Env {
  if (existsSync('.env')) process.loadEnvFile('.env');
  return parseEnv(process.env);
}
