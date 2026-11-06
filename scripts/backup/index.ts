import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { businessMonth } from '../../packages/shared/src/ledger';
import { decryptArchive, encryptArchive, parseKey, sha256 } from './archive';
import { command, connect, directUrl, snapshotManifest, verifyLedger } from './postgres';
import { objectName, storage } from './storage';

const production = process.env.NODE_ENV === 'production';
const scratch = () => mkdtemp(join(process.env.BACKUP_SCRATCH_DIR || tmpdir(), 'rentledger-'));
const maxAge = 24 * 3_600_000;

async function signal(destination: string | undefined, event: string) {
  if (!destination) { if (production) throw new Error('Monitoring destination is required'); return; }
  if (new URL(destination).protocol !== 'https:' && production) throw new Error('Monitoring requires HTTPS');
  const response = await fetch(destination, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event }), signal: AbortSignal.timeout(15_000), redirect: 'error',
  });
  if (!response.ok) throw new Error('Monitoring endpoint failed');
}

async function backup() {
  if (process.env.BACKUP_ENABLED !== 'true') throw new Error('Backup runner is unconfigured');
  if (production && (!process.env.BACKUP_HEARTBEAT_URL || !process.env.BACKUP_ALERT_URL)) throw new Error('Backup monitoring is unconfigured');
  const store = storage();
  const key = parseKey(process.env.BACKUP_KEY);
  const version = process.env.BACKUP_KEY_VERSION;
  if (!version || !/^[A-Za-z0-9_-]{1,24}$/.test(version)) throw new Error('Set a valid backup key version');
  const url = directUrl(process.env.BACKUP_DIRECT_URL);
  const db = connect(url);
  await db.connect();
  try {
    const { rows: [lock] } = await db.query('SELECT pg_try_advisory_lock(76933788) AS claimed');
    if (!lock.claimed) { console.log('Backup already running'); return; }
    await db.query(`UPDATE "BackupRun" SET status = 'FAILED', reason = 'INTERRUPTED', "finishedAt" = now() WHERE status = 'RUNNING'`);
    const success = store.kind === 'OFFSITE' ? 'SUCCESS' : 'LOCAL_SUCCESS';
    const { rows: [latest] } = await db.query(`SELECT "startedAt" FROM "BackupRun" WHERE status = $1 ORDER BY "startedAt" DESC LIMIT 1`, [success]);
    const { rows: [monthly] } = await db.query(`SELECT 1 AS found FROM "BackupRun" WHERE status = $1 AND "monthlyKey" IS NOT NULL
      AND to_char("startedAt" AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = $2 LIMIT 1`, [success, businessMonth()]);
    if (!process.argv.includes('--force') && monthly && latest && Date.now() - latest.startedAt.getTime() < maxAge - 3_600_000) return;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const id = crypto.randomUUID();
      const now = new Date();
      const stamp = `${now.toISOString().replace(/[:.]/g, '-')}-${id}.rentbk`;
      const dailyKey = `daily/${stamp}`;
      const monthlyKey = monthly ? null : `monthly/${stamp}`;
      const dir = await scratch();
      const archive = join(dir, 'encrypted.rentbk');
      let stage = 'START';
      try {
        await db.query(`INSERT INTO "BackupRun" (id, "startedAt", status, "keyVersion") VALUES ($1, $2, 'RUNNING', $3)`, [id, now, version]);
        stage = 'DUMP';
        await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
          const manifest = await snapshotManifest(db);
          const { rows: [row] } = await db.query('SELECT pg_export_snapshot() AS snapshot');
          const dump = command('pg_dump', url, ['--format=custom', '--no-owner', '--no-privileges', '--lock-wait-timeout=10s', `--snapshot=${row.snapshot}`]);
          try { await Promise.all([encryptArchive(dump.output, archive, key, version, manifest), dump.done]); }
          catch (error) { dump.stop(); await dump.done.catch(() => {}); throw error; }
          await db.query('COMMIT');
        } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
        stage = 'UPLOAD';
        const digest = await sha256(createReadStream(archive));
        const bytes = (await stat(archive)).size;
        await store.upload(dailyKey, archive, digest, version);
        if (monthlyKey) await store.upload(monthlyKey, archive, digest, version);
        stage = 'RECORD';
        await db.query(`UPDATE "BackupRun" SET status = $2, "finishedAt" = now(), "objectKey" = $3,
          "monthlyKey" = $4, bytes = $5, sha256 = $6 WHERE id = $1`, [id, success, dailyKey, monthlyKey, bytes, digest]);
        console.log(JSON.stringify({ event: 'backup.verified', mode: store.kind, dailyKey, monthlyKey, sha256: digest, bytes }));
        if (store.kind === 'OFFSITE') await signal(process.env.BACKUP_HEARTBEAT_URL, 'backup.verified').catch(async () => {
          console.error('Backup heartbeat failed');
          await signal(process.env.BACKUP_ALERT_URL, 'backup.heartbeat_failed');
        }).catch(() => { console.error('Backup alert failed'); });
        return;
      } catch (error) {
        await db.query(`UPDATE "BackupRun" SET status = 'FAILED', "finishedAt" = now(), reason = $2 WHERE id = $1`, [id, stage]).catch(() => {});
        const code = error instanceof Error && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : undefined;
        const kind = error instanceof Error && /^(pg_dump|pg_restore) (exited|could not run)/.test(error.message) ? error.message : error instanceof Error ? error.name : 'Unknown';
        console.error(JSON.stringify({ event: 'backup.failed', stage, attempt, kind, code }));
        if (attempt === 3) throw new Error(`Backup failed at ${stage}`, { cause: error });
      } finally { await rm(dir, { recursive: true, force: true }); }
      await pause(15_000 * 2 ** (attempt - 1));
    }
  } finally { await db.end(); }
}

async function restore() {
  const [key, digest] = process.argv.slice(3);
  if (!key || !objectName.test(key) || !digest || !/^[a-f\d]{64}$/.test(digest)) throw new Error('Provide an archive object key and trusted SHA-256');
  const target = directUrl(process.env.RESTORE_DATABASE_URL);
  const source = directUrl(process.env.BACKUP_DIRECT_URL);
  const name = decodeURIComponent(target.pathname.slice(1));
  if (!/^rental_restore_[a-z0-9_]+$/.test(name) || name === decodeURIComponent(source.pathname.slice(1)) || process.env.RESTORE_CONFIRM_DATABASE !== name) {
    throw new Error('Restore requires an explicitly confirmed, isolated rental_restore_* database');
  }
  if (production && target.hostname === source.hostname) throw new Error('Use a separate PostgreSQL endpoint for a production restore');
  const dir = await scratch();
  const db = connect(target);
  try {
    await db.connect();
    const { rows: [row] } = await db.query(`SELECT current_database() AS name, pg_try_advisory_lock(76933789) AS locked,
      EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname !~ '^(pg_|information_schema$)' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')) AS populated`);
    if (row.name !== name || !row.locked || row.populated) throw new Error('Restore target is not empty or is already in use');
    const archive = join(dir, 'encrypted.rentbk');
    const dump = join(dir, 'verified.dump');
    await storage().download(key, archive);
    if (await sha256(createReadStream(archive)) !== digest) throw new Error('Archive checksum did not match');
    const manifest = await decryptArchive(archive, dump, version => parseKey(
      version === process.env.BACKUP_KEY_VERSION ? process.env.BACKUP_KEY : process.env[`BACKUP_KEY_${version}`],
    ));
    const restore = command('pg_restore', target, ['--dbname', name, '--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges', dump]);
    restore.output.resume();
    await restore.done;
    await verifyLedger(db);
    const actual = await snapshotManifest(db);
    if (JSON.stringify(actual) !== JSON.stringify(manifest)) throw new Error('Restored data does not match the authenticated manifest');
    console.log(JSON.stringify({ event: 'restore.verified', counts: actual.counts }));
  } finally { await db.end().catch(() => {}); await rm(dir, { recursive: true, force: true }); }
}

async function monitor() {
  const db = connect(directUrl(process.env.BACKUP_DIRECT_URL));
  try {
    await db.connect();
    const { rows: [row] } = await db.query(`SELECT EXISTS (SELECT 1 FROM "BackupRun" WHERE status = 'SUCCESS' AND "startedAt" > now() - interval '25 hours') AS healthy`);
    if (!row.healthy) throw new Error('Verified off-site backup is overdue');
  } finally { await db.end().catch(() => {}); }
}

const task = process.argv[2] ?? 'run';
try {
  if (task === 'run') await backup();
  else if (task === 'restore') await restore();
  else if (task === 'monitor') await monitor();
  else throw new Error('Choose run, monitor, or restore');
} catch (error) {
  const known = error instanceof Error && /^(Backup failed at|Verified off-site backup is overdue|Archive checksum|Restore requires|Restore target|Restored|pg_restore exited)/.test(error.message);
  console.error(JSON.stringify({ event: `backup.${task}.error`, reason: known ? (error as Error).message : 'Check configuration, connectivity, and operator prerequisites' }));
  if (task === 'run' || task === 'monitor') await signal(process.env.BACKUP_ALERT_URL, `backup.${task}.failed`).catch(() => { console.error('Backup alert failed'); });
  process.exitCode = 1;
}
