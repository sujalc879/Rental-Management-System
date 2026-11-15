import { Client } from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { snapshotManifest, verifyLedger } from '../scripts/backup/postgres';
import { testDatabase } from './local-db';

const checked = testDatabase();
const db = new Client({ connectionString: process.env.TEST_DATABASE_URL, connectionTimeoutMillis: 5000 });
beforeAll(async () => { await db.connect(); });
afterAll(async () => { await db.end(); await checked.$disconnect(); });

test('authenticates counts for all application tables and can verify legacy manifest subsets', async () => {
  const manifest = await snapshotManifest(db);
  expect(Object.keys(manifest.counts)).toHaveLength(25);
  expect(manifest.counts).toHaveProperty('users');
  expect(manifest.counts).toHaveProperty('accounts');
  expect(manifest.counts).toHaveProperty('creditApplications');
  expect(manifest.counts).toHaveProperty('workerHeartbeats');
  const legacy = await snapshotManifest(db, ['organizations', 'payments', 'allocations']);
  expect(legacy.counts).toEqual({ organizations: manifest.counts.organizations, payments: manifest.counts.payments, allocations: manifest.counts.allocations });
  await expect(snapshotManifest(db, ['__proto__'])).rejects.toThrow('Unsupported backup manifest table');
  await expect(snapshotManifest(db, ['Payment"; DROP TABLE "User'])).rejects.toThrow('Unsupported backup manifest table');
});

test('restore validation rejects a database with financial immutability disabled', async () => {
  await verifyLedger(db);
  await db.query('BEGIN');
  try {
    await db.query('ALTER TABLE "Payment" DISABLE TRIGGER payment_immutable');
    await expect(verifyLedger(db)).rejects.toThrow('ledger integrity');
  } finally { await db.query('ROLLBACK'); }
  await verifyLedger(db);
});
