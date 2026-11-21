import { existsSync } from 'node:fs';
import { createPrismaClient, type PrismaClient } from '../../src/core/prisma.js';

function loadDotEnv(): void {
  if (existsSync('.env')) process.loadEnvFile('.env');
}

function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

/**
 * The only database URL tests may use. It must come from TEST_DATABASE_URL and must point at
 * autowash_test. Anything else, including the autowash database, is refused.
 */
export function getTestDatabaseUrl(): string {
  loadDotEnv();
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set. Add it to .env (see .env.example)');
  if (process.env.DATABASE_URL && url === process.env.DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL must not be the same as DATABASE_URL');
  }
  const name = databaseName(url);
  if (name !== 'autowash_test') {
    throw new Error(`Refusing to run tests against database "${name}". Tests may only use autowash_test`);
  }
  return url;
}

export function createTestPrisma(): PrismaClient {
  return createPrismaClient(getTestDatabaseUrl());
}

export async function resetTestDb(prisma: PrismaClient): Promise<void> {
  await prisma.washRun.deleteMany();
  await prisma.configChangeLog.deleteMany();
}
