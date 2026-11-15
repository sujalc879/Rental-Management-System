import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { directUrl } from './backup/postgres';

// Never load a source from DATABASE_URL: this command is exclusively for disposable test data.
const source = directUrl(process.env.TEST_DATABASE_URL);
if (!['127.0.0.1', 'localhost', 'db'].includes(source.hostname) || !/^\/rental_test(?:_[a-z0-9_]+)?$/.test(source.pathname)) {
  throw new Error('Recovery verification requires a disposable local rental_test database');
}
const backupSource = directUrl(process.env.TEST_BACKUP_DATABASE_URL || source.href);
if (backupSource.hostname !== source.hostname || backupSource.port !== source.port || backupSource.pathname !== source.pathname) {
  throw new Error('The test backup role must connect to the same isolated test database');
}
const dir = await mkdtemp(join(tmpdir(), 'rental-recovery-'));
const target = new URL(source);
const targetName = `rental_restore_${randomBytes(8).toString('hex')}`;
target.pathname = `/${targetName}`;
const db = new Client({ connectionString: source.href, connectionTimeoutMillis: 5000 });
const started = performance.now();
const env = { ...process.env, NODE_ENV: 'test', BACKUP_ENABLED: 'true', BACKUP_DIRECT_URL: backupSource.href,
  BACKUP_LOCAL_DIR: join(dir, 'store'), BACKUP_KEY_VERSION: 'rehearsal', BACKUP_KEY: randomBytes(32).toString('hex'),
  BACKUP_HEARTBEAT_URL: '', BACKUP_ALERT_URL: '', RESTORE_DATABASE_URL: target.href, RESTORE_CONFIRM_DATABASE: targetName,
};
async function run(...args: string[]) {
  const child = Bun.spawn([process.execPath, 'scripts/backup/index.ts', ...args], { env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) {
    console.error(stderr.trim());
    throw new Error(`Recovery verification step ${args[0]} failed`);
  }
  return stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
try {
  await db.connect();
  // Name is generated internally from hex bytes; the configured source is never overwritten.
  await db.query(`CREATE DATABASE "${targetName}"`);
  const backup = (await run('run', '--force')).find(event => event.event === 'backup.verified');
  if (!backup?.dailyKey || !backup?.monthlyKey || backup.mode !== 'LOCAL_DEVELOPMENT') throw new Error('Both independent recovery objects are required');
  const restored = (await run('restore', backup.monthlyKey, backup.sha256)).find(event => event.event === 'restore.verified');
  if (!restored?.counts) throw new Error('Restore verification result missing');
  console.log(JSON.stringify({ event: 'recovery.rehearsal.verified', database: targetName, storage: 'LOCAL_DEVELOPMENT',
    dailyAndMonthlyVerified: true, counts: restored.counts, quarantinedReceipts: restored.quarantinedReceipts,
    expiredSessions: restored.expiredSessions, expiredTokens: restored.expiredTokens,
    elapsedSeconds: Math.round((performance.now() - started) / 100) / 10,
  }));
} finally {
  await db.end().catch(() => {});
  await rm(dir, { recursive: true, force: true });
}
