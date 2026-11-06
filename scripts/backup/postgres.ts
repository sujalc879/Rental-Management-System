import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { Client } from 'pg';
import type { Manifest } from './archive';

export function directUrl(value: string | undefined) {
  if (!value) throw new Error('A direct PostgreSQL backup or restore URL is required');
  const url = new URL(value);
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

export async function snapshotManifest(db: Client): Promise<Manifest> {
  const { rows: [counts] } = await db.query(`SELECT
    (SELECT count(*)::text FROM "Organization") AS organizations,
    (SELECT count(*)::text FROM "Membership") AS memberships,
    (SELECT count(*)::text FROM "Property") AS properties,
    (SELECT count(*)::text FROM "Room") AS rooms,
    (SELECT count(*)::text FROM "Tenant") AS tenants,
    (SELECT count(*)::text FROM "Lease") AS leases,
    (SELECT count(*)::text FROM "RentCharge") AS charges,
    (SELECT count(*)::text FROM "Payment") AS payments,
    (SELECT count(*)::text FROM "Allocation") AS allocations,
    (SELECT count(*)::text FROM "PaymentReversal") AS reversals,
    (SELECT count(*)::text FROM "NotificationOutbox") AS notifications,
    (SELECT count(*)::text FROM "AuditLog") AS audit`);
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
    EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Allocation_organizationId_leaseId_chargeId_fkey' AND convalidated) AS allocation,
    EXISTS (SELECT 1 FROM "Payment" p WHERE p."amountPaise" < (SELECT COALESCE(sum(a."amountPaise"),0) FROM "Allocation" a WHERE a."paymentId" = p.id)) AS bad_payment,
    EXISTS (SELECT 1 FROM "RentCharge" c WHERE (CASE WHEN c."voidedAt" IS NULL THEN c."amountPaise" ELSE 0 END) < (
      SELECT COALESCE(sum(a."amountPaise"),0) FROM "Allocation" a WHERE a."chargeId" = c.id AND NOT EXISTS (
        SELECT 1 FROM "PaymentReversal" v WHERE (v."organizationId",v."paymentId") = (a."organizationId",a."paymentId")))) AS bad_charge`);
  if (!row.lease || !row.allocation || row.bad_payment || row.bad_charge) throw new Error('Restored ledger integrity checks failed');
}
