import { randomBytes } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';

const database = process.env.TEST_DATABASE_URL;
if (!database) throw new Error('Set TEST_DATABASE_URL to a migrated disposable local database');
const port = process.env.E2E_PORT || '4173';
if (!/^\d{1,5}$/.test(port) || Number(port) < 1024 || Number(port) > 65535) throw new Error('E2E_PORT must be a non-privileged TCP port');
const origin = `http://127.0.0.1:${port}`;
const bun = process.env.BUN_EXECUTABLE || 'bun';

export default defineConfig({
  testDir: 'tests/e2e', workers: 1, timeout: 120_000, expect: { timeout: 15_000 },
  use: { ...devices['Pixel 7'], baseURL: origin, trace: 'retain-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : undefined,
  },
  webServer: {
    command: `"${bun}" apps/api/src/server.ts`, url: `${origin}/ready`, timeout: 60_000, stdout: 'pipe', stderr: 'pipe',
    env: { NODE_ENV: 'test', API_PORT: port, APP_ORIGIN: origin, DATABASE_URL: process.env.TEST_API_DATABASE_URL || database,
      BETTER_AUTH_SECRET: randomBytes(32).toString('hex'), WHATSAPP_MODE: 'mock', BACKUP_ENABLED: 'false',
    },
  },
});
