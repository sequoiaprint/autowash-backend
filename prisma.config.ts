import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Prisma 7 does not read .env by itself. Real environment variables win over .env.
if (existsSync('.env')) process.loadEnvFile('.env');

// Migrations use SHADOW_DATABASE_URL as the shadow database.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: process.env.DATABASE_URL ?? 'mysql://USER:PASSWORD@localhost:3306/autowash',
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
