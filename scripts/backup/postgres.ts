import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { Client } from 'pg';
import type { Manifest } from './archive';
import { databaseUrl } from '../../packages/db/src/connection';

export function directUrl(value: string | undefined) {
  if (!value) throw new Error('A direct PostgreSQL backup or restore URL is required');
  const url = databaseUrl(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.hostname.includes('-pooler') || !url.pathname.slice(1)) throw new Error('Use a direct PostgreSQL connection');
  if (process.env.NODE_ENV === 'production' && !['require', 'verify-ca', 'verify-full'].includes(url.searchParams.get('sslmode') ?? '')) throw new Error('Production PostgreSQL connections must require TLS');
  return url;
}

export function command(program: 'pg_dump' | 'pg_restore', url: URL, args: string[]) {
  const executable = process.env.PG_BIN_DIR ? join(process.env.PG_BIN_DIR, `${program}${process.platform === 'win32' ? '.exe' : ''}`) : program;
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP,
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGHOST: url.hostname, PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
    PGSSLMODE: url.searchParams.get('sslmode') ?? 'prefer', PGCHANNELBINDING: url.searchParams.get('channel_binding') ?? 'prefer',
    PGCONNECT_TIMEOUT: '5', PGSSLROOTCERT: url.searchParams.get('sslrootcert') ?? process.env.PGSSLROOTCERT,
  };
  const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal: AbortSignal.timeout(45 * 60_000) });
  child.stderr.resume();
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', () => reject(new Error(`${program} could not run`)));
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${program} exited with code ${code}`)));
  });
  return { output: child.stdout, done, stop: () => child.kill() };
}

export function connect(url: URL) { return new Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000 }); }

const manifestTables: Record<string, string> = {
  organizations: 'Organization', memberships: 'Membership', properties: 'Property', rooms: 'Room', tenants: 'Tenant',
  leases: 'Lease', charges: 'RentCharge', payments: 'Payment', allocations: 'Allocation', reversals: 'PaymentReversal',
  notifications: 'NotificationOutbox', audit: 'AuditLog', users: 'User', accounts: 'Account', sessions: 'Session',
  verifications: 'Verification', twoFactors: 'TwoFactor', rateLimits: 'RateLimit', leaseTerms: 'LeaseTerm',
  creditApplications: 'CreditApplication', senders: 'WhatsAppSender', webhookEvents: 'WebhookEvent',
  billingJobs: 'BillingJob', backupRuns: 'BackupRun', workerHeartbeats: 'WorkerHeartbeat',
};

export async function snapshotManifest(db: Client, keys = Object.keys(manifestTables)): Promise<Manifest> {
  if (!keys.length || keys.some(key => !Object.hasOwn(manifestTables, key))) throw new Error('Unsupported backup manifest table');
  // Both identifiers come from the fixed allowlist, including when verifying older archives.
  const columns = keys.map(key => `(SELECT count(*)::text FROM "${manifestTables[key]}") AS "${key}"`);
  const { rows: [counts] } = await db.query(`SELECT ${columns.join(', ')}`);
  const { rows: [sample] } = await db.query(`SELECT md5(COALESCE(string_agg(data, '|' ORDER BY org, data), '')) AS digest FROM (
    SELECT o.id AS org, x.data FROM "Organization" o CROSS JOIN LATERAL (
      SELECT concat_ws(':', p.id, p."leaseId", p."amountPaise", p.mode, a.id, a."chargeId", a."amountPaise") AS data
      FROM "Payment" p LEFT JOIN "Allocation" a ON (a."organizationId", a."leaseId", a."paymentId") = (p."organizationId", p."leaseId", p.id)
      WHERE p."organizationId" = o.id ORDER BY p.id, a.id LIMIT 20
    ) x
  ) samples`);
  return { counts, samples: sample.digest };
}

export async function verifyLedger(db: Client) {
  const { rows: [row] } = await db.query(`SELECT
    EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lease_no_room_overlap' AND convalidated) AS lease,
    (SELECT count(*) = 6 FROM pg_constraint WHERE conname = ANY(ARRAY[
      'Allocation_organizationId_leaseId_chargeId_fkey', 'Allocation_organizationId_leaseId_paymentId_fkey',
      'Payment_organizationId_leaseId_fkey', 'Lease_organizationId_roomId_fkey',
      'Lease_organizationId_tenantId_fkey', 'NotificationOutbox_organizationId_paymentId_fkey'
    ]) AND convalidated) AS allocation,
    (SELECT count(*) = 8 FROM pg_trigger WHERE tgname = ANY(ARRAY[
      'allocation_preserves_balance', 'payment_immutable', 'allocation_immutable', 'reversal_immutable',
      'credit_immutable', 'term_immutable', 'audit_immutable', 'charge_immutable'
    ]) AND tgenabled IN ('O', 'A')) AS history,
    EXISTS (SELECT 1 FROM "Payment" p WHERE p."amountPaise" < (SELECT COALESCE(sum(a."amountPaise"),0) FROM "Allocation" a WHERE a."paymentId" = p.id)) AS bad_payment,
    EXISTS (SELECT 1 FROM "RentCharge" c WHERE (CASE WHEN c."voidedAt" IS NULL THEN c."amountPaise" ELSE 0 END) < (
      SELECT COALESCE(sum(a."amountPaise"),0) FROM "Allocation" a WHERE a."chargeId" = c.id AND NOT EXISTS (
        SELECT 1 FROM "PaymentReversal" v WHERE (v."organizationId",v."paymentId") = (a."organizationId",a."paymentId")))) AS bad_charge`);
  if (!row.lease || !row.allocation || !row.history || row.bad_payment || row.bad_charge) throw new Error('Restored ledger integrity checks failed');
}

// Caller owns the transaction and must verify the restored snapshot first.
export async function quarantineRestoredReceipts(db: Client) {
  const { rows } = await db.query(`WITH held AS (
    UPDATE "NotificationOutbox" SET status = 'UNCERTAIN', reason = 'RESTORE_RECONCILIATION_REQUIRED',
      retryable = false, "claimUntil" = NULL, "updatedAt" = now()
    WHERE status IN ('PENDING', 'SENDING', 'ACCEPTED', 'SENT', 'FAILED')
    RETURNING id, "organizationId"
  ) INSERT INTO "AuditLog" (id, "organizationId", "actorId", action, "entityId", details)
    SELECT gen_random_uuid(), "organizationId", NULL, 'notification.recovery_hold', id,
      '{"status":"UNCERTAIN","reason":"RESTORE_RECONCILIATION_REQUIRED"}'::jsonb FROM held RETURNING id`);
  return rows.length;
}

export async function invalidateRestoredSessions(db: Client) {
  const { rows: [row] } = await db.query(`WITH expired_sessions AS (DELETE FROM "Session" RETURNING id),
    expired_tokens AS (DELETE FROM "Verification" RETURNING id),
    logged AS (INSERT INTO "AuditLog" (id, "organizationId", "actorId", action, "entityId", details)
      SELECT gen_random_uuid(), id, NULL, 'account.recovery_sessions_revoked', id, '{"reason":"DATABASE_RECOVERY"}'::jsonb
      FROM "Organization" WHERE EXISTS (SELECT 1 FROM expired_sessions) OR EXISTS (SELECT 1 FROM expired_tokens) RETURNING id)
    SELECT (SELECT count(*)::text FROM expired_sessions) AS "expiredSessions",
      (SELECT count(*)::text FROM expired_tokens) AS "expiredTokens"`);
  return row as { expiredSessions: string; expiredTokens: string };
}
