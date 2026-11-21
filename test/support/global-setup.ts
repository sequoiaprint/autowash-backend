import { execFileSync } from 'node:child_process';
import { getTestDatabaseUrl } from './test-db.js';

/** Applies the migrations to autowash_test only, before any test runs. */
export default function setup(): void {
  const url = getTestDatabaseUrl(); // refuses anything but autowash_test
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}
