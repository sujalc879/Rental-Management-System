import { createHmac, randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createApp } from '../apps/api/src/app';
import { readConfig } from '../apps/api/src/config';
import { dispatchOne, recoverExpiredClaims } from '../apps/api/src/messaging';
import { runBillingJob, scheduleBilling } from '../apps/worker/src/billing';
import { recordWorkerHeartbeat, workerHeartbeatName } from '../apps/api/src/operations';
import { businessDay, businessMonth, dateInputToUtc, monthKey, periodDate, shiftMonth } from '../packages/shared/src/ledger';
import { provisionOwner } from '../scripts/owners';
import { invalidateRestoredSessions, quarantineRestoredReceipts } from '../scripts/backup/postgres';
import { testDatabase } from './local-db';

const db = testDatabase();
const apiDb = process.env.TEST_API_DATABASE_URL ? testDatabase(process.env.TEST_API_DATABASE_URL) : db;
const workerDb = process.env.TEST_WORKER_DATABASE_URL ? testDatabase(process.env.TEST_WORKER_DATABASE_URL) : db;
const origin = 'http://localhost:5173';
const password = randomBytes(24).toString('base64url');
const slug = crypto.randomUUID().slice(0, 8);
const mail = await mkdtemp(join(tmpdir(), 'rental-mail-'));
const env = { NODE_ENV: 'test', APP_ORIGIN: origin, BETTER_AUTH_SECRET: randomBytes(32).toString('hex'), DEV_MAIL_DIR: mail };
const config = readConfig({ ...env, WHATSAPP_MODE: 'mock' });
const meta = readConfig({ ...env, WHATSAPP_MODE: 'meta', META_GRAPH_VERSION: 'v25.0',
  META_PHONE_NUMBER_ID: '101', META_ACCESS_TOKEN: 'test-only-token', META_APP_SECRET: 'test-signing-secret',
  META_VERIFY_TOKEN: 'test-only-verification-value-0123456', META_CASH_TEMPLATE: 'rent_cash', META_ONLINE_TEMPLATE: 'rent_online',
});
const { app } = createApp(apiDb, config);
const metaApp = createApp(apiDb, meta).app;

type Owner = { id: string; userId: string; cookies: string };
type Fixture = { property: string; room: string; tenant: string; lease: string; charge: string };
let ownerA: Owner;
let ownerB: Owner;
let a: Fixture;
let b: Fixture;

const cookie = (response: Response) => response.headers.getSetCookie().map(item => item.split(';')[0]).join('; ');
async function request(path: string, method = 'GET', data?: unknown, cookies = '', use = app, headers: Record<string, string> = {}) {
  return use.request(`${origin}${path}`, { method, headers: { origin, 'x-rental-client-ip': `127.0.${parseInt(slug.slice(0, 2), 16)}.${parseInt(slug.slice(2, 4), 16)}`,
    cookie: cookies, 'content-type': 'application/json', ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
}
const route = (owner: Owner, path: string) => `/api/orgs/${owner.id}/${path}`;
const call = (owner: Owner, path: string, method = 'GET', data?: unknown, use = app) => request(route(owner, path), method, data, owner.cookies, use);
async function successful(response: Response, status = 200) {
  const data = await response.json();
  expect(response.status, JSON.stringify(data)).toBe(status);
  return data;
}
async function addOwner(label: string) {
  const email = `${label}-${slug}@example.test`;
  const { user, organization } = await provisionOwner(db, { name: label, email, password, organization: `Rentals ${label} ${slug}`, verified: true });
  const clientIp = [127, ...randomBytes(3)].join('.');
  const signIn = await request('/api/auth/sign-in/email', 'POST', { email, password }, '', app, { 'x-rental-client-ip': clientIp });
  const cookies = cookie(signIn);
  await successful(signIn);
  expect(cookies).toContain('session_token=');
  return { id: organization.id, userId: user.id, cookies };
}
async function fixture(owner: Owner, label: string, startsOn = `${businessMonth()}-01`): Promise<Fixture> {
  const property = (await successful(await call(owner, 'properties', 'POST', { name: `${label} property ${slug}` }), 201)).id;
  const room = (await successful(await call(owner, 'rooms', 'POST', { name: label, propertyId: property }), 201)).id;
  const tenant = (await successful(await call(owner, 'tenants', 'POST', { name: `${label} tenant ${slug}`, whatsapp: '+919876543210' }), 201)).id;
  await successful(await call(owner, `tenants/${tenant}/consent`, 'POST', { allowed: true, source: 'Test record of opt-in' }));
  const lease = (await successful(await call(owner, 'leases', 'POST', { roomId: room, tenantId: tenant, startsOn, amountPaise: 800_000, dueDay: 5 }), 201)).id;
  const charge = (await successful(await call(owner, `ledger?leaseId=${lease}`)))[0].id;
  return { property, room, tenant, lease, charge };
}
function payment(data: Fixture, amountPaise: number, extras = {}) {
  return { key: crypto.randomUUID(), leaseId: data.lease, amountPaise, paidAt: new Date().toISOString(), mode: 'CASH', allocations: [{ chargeId: data.charge, amountPaise }], ...extras };
}

function totp(secret: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...secret].map(char => alphabet.indexOf(char).toString(2).padStart(5, '0')).join('');
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map(value => parseInt(value, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

beforeAll(async () => {
  ownerA = await addOwner('owner-a'); ownerB = await addOwner('owner-b');
  a = await fixture(ownerA, 'A101'); b = await fixture(ownerB, 'B101');
});
afterAll(async () => {
  await Promise.all([...new Set([db, apiDb, workerDb])].map(connection => connection.$disconnect()));
  await rm(mail, { recursive: true, force: true });
});

describe('organization authorization and authentication', () => {
  test('rate-limits repeated sign-in attempts without disabling limits for fixture creation', async () => {
    const ip = [127, ...randomBytes(3)].join('.');
    for (let attempt = 0; attempt < 10; attempt++) {
      expect((await request('/api/auth/sign-in/email', 'POST', { email: `missing-${slug}@example.test`, password }, '', app, { 'x-rental-client-ip': ip })).status).toBe(401);
    }
    expect((await request('/api/auth/sign-in/email', 'POST', { email: `missing-${slug}@example.test`, password }, '', app, { 'x-rental-client-ip': ip })).status).toBe(429);
  });
  test('denies protected access without a valid verified session and rejects cross-origin writes', async () => {
    expect((await request(route(ownerA, 'ledger'))).status).toBe(401);
    expect((await request(route(ownerA, 'properties'), 'POST', { name: 'Injected' }, ownerA.cookies, app, { origin: 'https://evil.example' })).status).toBe(403);
    const own = await successful(await request('/api/organizations', 'GET', undefined, ownerA.cookies));
    expect(own.map((item: { organization: { id: string } }) => item.organization.id)).toEqual([ownerA.id]);
    const signup = await request('/api/auth/sign-up/email', 'POST', { name: 'Public', email: `public-${slug}@example.test`, password });
    expect(signup.status).toBeGreaterThanOrEqual(400);
  });

  test('denies forged resource IDs in paths, filters and bodies across every sensitive surface', async () => {
    const otherPayment = (await successful(await call(ownerB, 'payments', 'POST', payment(b, 500)), 201)).payment;
    for (const [path, method, payload] of [
      [`properties/${b.property}`, 'GET'], [`rooms/${b.room}`, 'GET'], [`tenants/${b.tenant}`, 'GET'], [`leases/${b.lease}`, 'GET'],
      [`properties/${b.property}`, 'PATCH', { name: 'Stolen' }], [`rooms/${b.room}/archive`, 'POST'], [`tenants/${b.tenant}/archive`, 'POST'],
      [`rooms`, 'POST', { name: 'Injected room', propertyId: b.property }], [`ledger/generate`, 'POST', { month: businessMonth(), leaseId: b.lease }],
      [`leases`, 'POST', { roomId: a.room, tenantId: b.tenant, startsOn: businessDay(), amountPaise: 1000, dueDay: 5 }],
      [`payments`, 'POST', payment(b, 1000)], [`payments`, 'POST', payment(a, 1000, { allocations: [{ chargeId: b.charge, amountPaise: 1000 }] })],
      [`payments/${otherPayment.id}/reverse`, 'POST', { reason: 'Attempted theft' }], [`ledger/${b.charge}/void`, 'POST', { reason: 'Attempted theft' }],
      [`notifications/${otherPayment.notification.id}/retry`, 'POST'], [`dashboard?roomId=${b.room}`, 'GET'], [`exports/ledger?tenantId=${b.tenant}`, 'GET'],
      [`exports/payments?leaseId=${b.lease}`, 'GET'], [`backup/archive`, 'GET'],
    ] as const) expect((await call(ownerA, path, method, payload)).status, path).toBe(404);
    expect((await request(route(ownerB, 'settings'), 'GET', undefined, ownerA.cookies)).status).toBe(404);
    expect((await call(ownerA, 'properties', 'POST', { name: 'Forged', organizationId: ownerB.id })).status).toBe(400);
    const csv = await (await call(ownerA, 'exports/ledger')).text();
    expect(csv).toContain('A101'); expect(csv).not.toContain('B101');
    expect((await successful(await call(ownerA, 'backup-health'))).status).toBe('UNCONFIGURED');
  });

  test('verifies email, resets password, revokes an expired session and signs out', async () => {
    const email = `unverified-${slug}@example.test`;
    const account = await provisionOwner(db, { email, name: 'Invite owner', organization: 'Invited Rentals', password });
    expect((await request('/api/auth/sign-in/email', 'POST', { email, password })).status).toBe(403);
    await successful(await request('/api/auth/send-verification-email', 'POST', { email, callbackURL: `${origin}/sign-in` }));
    const mails = async () => Promise.all((await readdir(mail)).map(async file => JSON.parse(await readFile(join(mail, file), 'utf8'))));
    const verify = (await mails()).find(row => row.to === email && row.subject.includes('Verify'));
    expect((await app.request(verify.url)).status).toBe(302);
    expect((await db.user.findUniqueOrThrow({ where: { id: account.user.id } })).emailVerified).toBe(true);
    expect(await db.auditLog.count({ where: { organizationId: account.organization.id, actorId: account.user.id, action: 'account.email_verified' } })).toBe(1);
    await successful(await request('/api/auth/request-password-reset', 'POST', { email, redirectTo: `${origin}/reset` }));
    const reset = (await mails()).find(row => row.to === email && row.subject.includes('password'));
    const redirect = (await app.request(reset.url)).headers.get('location');
    const token = new URL(redirect!).searchParams.get('token');
    const newPassword = `${password}-reset`;
    const otherPasswordEvents = await db.auditLog.count({ where: { organizationId: { not: account.organization.id }, action: 'account.password_updated' } });
    const passwordEvents = () => db.auditLog.findMany({ where: { organizationId: account.organization.id, action: 'account.password_updated' } });
    await successful(await request('/api/auth/reset-password', 'POST', { token, newPassword }));
    expect(await passwordEvents()).toMatchObject([{ actorId: account.user.id, entityId: account.user.id }]);
    expect((await request('/api/auth/reset-password', 'POST', { token, newPassword })).status).toBe(400);
    expect(await passwordEvents()).toHaveLength(1);
    expect((await request('/api/auth/sign-in/email', 'POST', { email, password })).status).toBe(401);
    const signedIn = await request('/api/auth/sign-in/email', 'POST', { email, password: newPassword });
    const cookies = cookie(signedIn);
    await successful(signedIn);
    await db.session.updateMany({ where: { userId: account.user.id }, data: { expiresAt: new Date(0) } });
    expect((await request('/api/organizations', 'GET', undefined, cookies)).status).toBe(401);
    const second = await request('/api/auth/sign-in/email', 'POST', { email, password: newPassword });
    const secondCookie = cookie(second);
    await successful(second);
    const changed = await request('/api/auth/change-password', 'POST', { currentPassword: newPassword, newPassword: `${newPassword}-changed`, revokeOtherSessions: true }, secondCookie);
    await successful(changed);
    expect(await passwordEvents()).toHaveLength(2);
    expect(await db.auditLog.count({ where: { organizationId: { not: account.organization.id }, action: 'account.password_updated' } })).toBe(otherPasswordEvents);
    const activeCookies = cookie(changed) || secondCookie;
    await successful(await request('/api/auth/sign-out', 'POST', {}, activeCookies));
    expect((await request('/api/organizations', 'GET', undefined, activeCookies)).status).toBe(401);
  });

  test('enrolls TOTP and keeps a password-only MFA sign-in out of the owner API', async () => {
    const owner = await addOwner('factor-owner');
    const enrollment = await successful(await request('/api/auth/two-factor/enable', 'POST', { password }, owner.cookies));
    const secret = new URL(enrollment.totpURI).searchParams.get('secret')!;
    await successful(await request('/api/auth/two-factor/verify-totp', 'POST', { code: totp(secret) }, owner.cookies));
    const pending = await request('/api/auth/sign-in/email', 'POST', { email: `factor-owner-${slug}@example.test`, password });
    const factorCookies = cookie(pending);
    expect((await successful(pending)).twoFactorRedirect).toBe(true);
    expect((await request('/api/organizations', 'GET', undefined, factorCookies)).status).toBe(401);
    const verified = await request('/api/auth/two-factor/verify-backup-code', 'POST', { code: enrollment.backupCodes[0] }, factorCookies);
    const cookies = cookie(verified);
    await successful(verified);
    expect((await request('/api/organizations', 'GET', undefined, cookies)).status).toBe(200);
  });
});

describe('ledger integrity and concurrency', () => {
  test('enforces unique rent, lease intervals and no cross-organization database relationship', async () => {
    const generate = () => call(ownerA, 'ledger/generate', 'POST', { month: businessMonth(), leaseId: a.lease });
    for (const response of await Promise.all([generate(), generate()])) expect((await successful(response)).created).toBe(0);
    expect((await call(ownerA, 'leases', 'POST', { roomId: a.room, tenantId: a.tenant, startsOn: businessDay(), amountPaise: 10_000, dueDay: 5 })).status).toBe(409);
    await expect(db.room.create({ data: { organizationId: ownerA.id, propertyId: b.property, name: 'invalid relationship' } })).rejects.toMatchObject({ code: 'P2003' });
    await scheduleBilling(workerDb);
    await Promise.all([runBillingJob(workerDb), runBillingJob(workerDb)]);
    expect(await db.rentCharge.count({ where: { organizationId: ownerA.id, leaseId: a.lease, period: periodDate(businessMonth()) } })).toBe(1);
  });

  test('commits one payment for concurrent replays, rejects over-allocation, applies credit, and reverses without erasing history', async () => {
    const next = monthKey(shiftMonth(periodDate(businessMonth()), 1));
    await successful(await call(ownerA, `leases/${a.lease}/terms`, 'POST', { month: next, amountPaise: 900_000, dueDay: 31, reason: 'Next month terms' }), 201);
    await successful(await call(ownerA, 'ledger/generate', 'POST', { month: next, leaseId: a.lease }));
    const future = (await successful(await call(ownerA, `ledger?leaseId=${a.lease}&month=${next}`)))[0];
    expect(future.amountPaise).toBe(900_000);
    const input = payment(a, 210_000, { mode: 'ONLINE', reference: '0000042', allowCredit: true, allocations: [{ chargeId: a.charge, amountPaise: 100_000 }, { chargeId: future.id, amountPaise: 100_000 }] });
    const responses = await Promise.all(Array.from({ length: 3 }, () => call(ownerA, 'payments', 'POST', input)));
    expect(responses.map(response => response.status).sort()).toEqual([200, 200, 201]);
    const ids = await Promise.all(responses.map(async response => (await response.json()).payment.id));
    expect(new Set(ids).size).toBe(1);
    const [id] = ids;
    expect(await db.notificationOutbox.count({ where: { organizationId: ownerA.id, paymentId: id } })).toBe(1);
    expect(await db.auditLog.count({ where: { organizationId: ownerA.id, entityId: id, action: 'payment.recorded' } })).toBe(1);
    expect((await call(ownerA, 'payments', 'POST', { ...input, reference: 'other' })).status).toBe(409);
    expect((await call(ownerA, 'payments', 'POST', { ...input, key: crypto.randomUUID() })).status).toBe(409);
    const invalid = payment(a, 800_000);
    expect((await call(ownerA, 'payments', 'POST', invalid)).status).toBe(409);
    expect(await db.payment.count({ where: { organizationId: ownerA.id, key: invalid.key } })).toBe(0);
    const credit = { key: crypto.randomUUID(), allocations: [{ chargeId: future.id, amountPaise: 10_000 }] };
    await successful(await call(ownerA, `payments/${id}/credit`, 'POST', credit));
    expect((await successful(await call(ownerA, `payments/${id}/credit`, 'POST', credit))).replay).toBe(true);
    expect((await successful(await call(ownerA, `payments/${id}`))).creditPaise).toBe(0);
    const summary = await successful(await call(ownerA, `dashboard?month=${businessMonth()}`));
    expect(summary).toMatchObject({ expected: '800000', applied: '100000', received: '210000', occupied: 1 });
    await successful(await call(ownerA, `payments/${id}/reverse`, 'POST', { reason: 'Corrected entry' }));
    expect((await successful(await call(ownerA, `ledger?month=${next}`)))[0].allocatedPaise).toBe(0);
    expect((await successful(await call(ownerA, `payments/${id}`))).reference).toBe('0000042');
    await expect(db.payment.update({ where: { id }, data: { amountPaise: 1000 } })).rejects.toBeDefined();
    const competing = await Promise.all([call(ownerA, 'payments', 'POST', payment(a, 500_000)), call(ownerA, 'payments', 'POST', payment(a, 500_000))]);
    expect(competing.map(response => response.status).sort()).toEqual([201, 409]);
    const lastSummary = await successful(await call(ownerA, `dashboard?month=${businessMonth()}`));
    expect(lastSummary).toMatchObject({ expected: '800000', applied: '500000', received: '500000', outstanding: '300000' });
  });
});

describe('durable receipts and webhook isolation', () => {
  test('labels mock receipts and rechecks consent before dispatch', async () => {
    const data = await fixture(ownerA, 'Mock101');
    await successful(await call(ownerA, 'settings', 'PATCH', { name: 'Rentals owner A', whatsappEnabled: true }));
    const create = async () => (await successful(await call(ownerA, 'payments', 'POST', payment(data, 1000)), 201)).payment.notification;
    const mock = await create();
    expect(mock.status).toBe('PENDING');
    expect(await dispatchOne(workerDb, config)).toBe(true);
    expect((await db.notificationOutbox.findUniqueOrThrow({ where: { id: mock.id } })).status).toBe('SIMULATED');
    const pending = await create();
    await successful(await call(ownerA, `tenants/${data.tenant}/consent`, 'POST', { allowed: false, source: 'Tenant opted out' }));
    await db.notificationOutbox.update({ where: { id: mock.id }, data: { updatedAt: new Date(0) } });
    expect(await dispatchOne(workerDb, config)).toBe(true);
    expect((await db.notificationOutbox.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('NO_CONSENT');
  });

  test('separates Meta acceptance from delivery, deduplicates signed callbacks, and recovers expired claims as uncertain', async () => {
    const data = await fixture(ownerB, 'Meta101');
    await successful(await call(ownerB, 'settings', 'PATCH', { name: 'Rentals owner B', whatsappEnabled: true }));
    await db.notificationOutbox.updateMany({ where: { organizationId: ownerA.id, claimToken: { not: null } }, data: { updatedAt: new Date(0) } });
    const notification = (await successful(await call(ownerB, 'payments', 'POST', payment(data, 2000), metaApp), 201)).payment.notification;
    const providerId = `wamid.test-${slug}`;
    let payload: Record<string, unknown> = {};
    const stub: typeof fetch = Object.assign(async (_input: string | URL | Request, options?: RequestInit) => {
      payload = JSON.parse(String(options?.body));
      return Response.json({ messages: [{ id: providerId }] });
    }, { preconnect: fetch.preconnect });
    expect(await dispatchOne(workerDb, meta, stub)).toBe(true);
    expect(payload).toMatchObject({ messaging_product: 'whatsapp', to: '919876543210' });
    expect((await db.notificationOutbox.findUniqueOrThrow({ where: { id: notification.id } })).status).toBe('ACCEPTED');
    const webhook = (phone: string, status: string) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: phone }, statuses: [{ id: providerId, status, timestamp: '123' }] } }] }] });
    const send = (phone: string, status: string, authenticated = true) => {
      const data = webhook(phone, status);
      const signature = createHmac('sha256', meta.META_APP_SECRET!).update(JSON.stringify(data)).digest('hex');
      return request('/api/webhooks/whatsapp', 'POST', data, '', metaApp, { 'x-hub-signature-256': authenticated ? `sha256=${signature}` : 'sha256=incorrect' });
    };
    expect((await request(`/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${meta.META_VERIFY_TOKEN}&hub.challenge=test`, 'GET', undefined, '', metaApp)).status).toBe(200);
    expect((await send('101', 'delivered', false)).status).toBe(403);
    expect((await send('202', 'delivered')).status).toBe(200);
    expect((await db.notificationOutbox.findUniqueOrThrow({ where: { id: notification.id } })).status).toBe('ACCEPTED');
    expect((await send('101', 'delivered')).status).toBe(200);
    expect((await send('101', 'delivered')).status).toBe(200);
    expect((await send('101', 'sent')).status).toBe(200);
    expect((await db.notificationOutbox.findUniqueOrThrow({ where: { id: notification.id } })).status).toBe('DELIVERED');
    const expired = (await successful(await call(ownerB, 'payments', 'POST', payment(data, 1000), metaApp), 201)).payment.notification;
    await db.notificationOutbox.update({ where: { id: expired.id }, data: { status: 'SENDING', claimToken: crypto.randomUUID(), claimUntil: new Date(0) } });
    expect(await recoverExpiredClaims(workerDb)).toBeGreaterThan(0);
    expect((await db.notificationOutbox.findUniqueOrThrow({ where: { id: expired.id } })).status).toBe('UNCERTAIN');
    expect((await call(ownerB, `notifications/${expired.id}/retry`, 'POST', {}, metaApp)).status).toBe(409);
  });

  test('backs off safe provider rejections and enforces bounded manual retry eligibility', async () => {
    const data = await fixture(ownerB, 'Retry101');
    const row = (await successful(await call(ownerB, 'payments', 'POST', payment(data, 1500), metaApp), 201)).payment.notification;
    const stub: typeof fetch = Object.assign(async () => new Response(null, { status: 429 }), { preconnect: fetch.preconnect });
    await db.notificationOutbox.updateMany({ where: { organizationId: { in: [ownerA.id, ownerB.id] }, claimToken: { not: null } }, data: { updatedAt: new Date(0) } });
    expect(await dispatchOne(workerDb, meta, stub)).toBe(true);
    const queued = await db.notificationOutbox.findUniqueOrThrow({ where: { id: row.id } });
    expect(queued).toMatchObject({ status: 'PENDING', retryable: true, attempts: 1 });
    expect(queued.nextAt.getTime()).toBeGreaterThan(Date.now());
    expect((await call(ownerB, `notifications/${row.id}/retry`, 'POST', {}, metaApp)).status).toBe(409);
    await db.notificationOutbox.update({ where: { id: row.id }, data: { attempts: 4, nextAt: new Date(0), updatedAt: new Date(0) } });
    expect(await dispatchOne(workerDb, meta, stub)).toBe(true);
    expect((await db.notificationOutbox.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('FAILED');
    await successful(await call(ownerB, `notifications/${row.id}/retry`, 'POST', {}, metaApp));
    expect(await db.notificationOutbox.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: 'PENDING', attempts: 0, manualRetries: 1 });
    await db.notificationOutbox.update({ where: { id: row.id }, data: { status: 'FAILED', attempts: 5, manualRetries: 2, retryable: true } });
    expect((await call(ownerB, `notifications/${row.id}/retry`, 'POST', {}, metaApp)).status).toBe(409);
  });
  test('uses the committed payment ID and approved field order when dispatching receipt templates', async () => {
    const owner = await addOwner('receipt-owner');
    const data = await fixture(owner, 'Receipt101');
    await successful(await call(owner, 'settings', 'PATCH', { name: 'Receipt owner', whatsappEnabled: true }));
    const compact = { ...meta, META_TEMPLATE_LAYOUT: 'receipt_v1' as const };
    const use = createApp(apiDb, compact).app;
    for (const mode of ['CASH', 'ONLINE'] as const) {
      const amountPaise = mode === 'CASH' ? 12_345 : 20_001;
      const reference = mode === 'ONLINE' ? '000UPI123' : undefined;
      const recorded = (await successful(await call(owner, 'payments', 'POST', payment(data, amountPaise, { mode, reference }), use), 201)).payment;
      await db.notificationOutbox.updateMany({ where: {
        organizationId: { in: [ownerA.id, ownerB.id, owner.id] }, claimToken: { not: null },
      }, data: { updatedAt: new Date(0) } });
      let payload: { template: { components: { parameters: { text: string }[] }[] } } | undefined;
      const stub: typeof fetch = Object.assign(async (_input: string | URL | Request, options?: RequestInit) => {
        payload = JSON.parse(String(options?.body));
        return Response.json({ messages: [{ id: `wamid.receipt-${recorded.id}` }] });
      }, { preconnect: fetch.preconnect });
      expect(await dispatchOne(workerDb, compact, stub)).toBe(true);
      const values = payload!.template.components[0].parameters.map(value => value.text);
      expect(values).toHaveLength(mode === 'CASH' ? 6 : 7);
      expect(values[0]).toBe(`Receipt101 tenant ${slug}`);
      expect(values[1]).toBe(mode === 'CASH' ? '123.45' : '200.01');
      expect(values[2]).toContain(`Owner: Receipt owner; Property: Receipt101 property ${slug}; Rent: ${businessMonth()}`);
      expect(values[3]).toBe('Receipt101');
      expect(values[4]).toBe(recorded.id);
      if (mode === 'ONLINE') expect(values[5]).toBe('000UPI123');
      expect(values.at(-1)).toContain('IST');
      const row = await db.notificationOutbox.findUniqueOrThrow({ where: { id: recorded.notification.id } });
      expect(row.status).toBe('ACCEPTED');
      expect(values[4]).not.toBe(row.claimToken);
    }
  });
});

describe('operational health and preserved lease history', () => {
  test('scopes failed jobs, denies cross-owner retries, and audits authorized retries', async () => {
    const owner = await addOwner('operations-owner');
    const other = await addOwner('operations-other');
    const month = monthKey(shiftMonth(periodDate(businessMonth()), -1));
    const otherMonth = monthKey(shiftMonth(periodDate(businessMonth()), -2));
    await db.billingJob.createMany({ data: [
      { organizationId: owner.id, period: periodDate(month), attempts: 5, failedAt: new Date() },
      { organizationId: other.id, period: periodDate(otherMonth), attempts: 5, failedAt: new Date() },
    ] });
    await db.workerHeartbeat.upsert({ where: { name: workerHeartbeatName },
      create: { name: workerHeartbeatName, lastSucceededAt: new Date(0) }, update: { lastSucceededAt: new Date(0) },
    });
    const health = await successful(await call(owner, 'operations-health'));
    expect(health.worker.status).toBe('OVERDUE');
    expect(health.billing).toMatchObject({ failed: 1, pending: 0 });
    expect(health.billing.failedJobs.map((job: { period: string }) => job.period.slice(0, 7))).toEqual([month]);
    expect((await request(route(other, 'operations-health'), 'GET', undefined, owner.cookies)).status).toBe(404);
    expect((await call(owner, `billing-jobs/${otherMonth}/retry`, 'POST', { reason: 'Forged month' })).status).toBe(404);
    expect((await request(route(other, `billing-jobs/${otherMonth}/retry`), 'POST', { reason: 'Forged organization' }, owner.cookies)).status).toBe(404);
    await successful(await call(owner, `billing-jobs/${month}/retry`, 'POST', { reason: 'Operator fixed the cause' }));
    expect((await call(owner, `billing-jobs/${month}/retry`, 'POST', { reason: 'Repeated request' })).status).toBe(409);
    expect(await db.auditLog.count({ where: { organizationId: owner.id, action: 'billing.retried' } })).toBe(1);
    expect(await db.billingJob.findUniqueOrThrow({ where: { organizationId_period: { organizationId: other.id, period: periodDate(otherMonth) } } })).toMatchObject({ attempts: 5 });
    await recordWorkerHeartbeat(workerDb);
    expect((await successful(await call(owner, 'operations-health'))).worker.status).toBe('HEALTHY');
    await expect(apiDb.workerHeartbeat.update({ where: { name: workerHeartbeatName }, data: { lastSucceededAt: new Date(0) } })).rejects.toBeDefined();
  });

  test('preserves paid months and snapshots when rent changes, leases end and occupants change', async () => {
    const owner = await addOwner('history-owner');
    const month = businessMonth();
    const next = monthKey(shiftMonth(periodDate(month), 1));
    const previous = monthKey(shiftMonth(periodDate(month), -1));
    const data = await fixture(owner, 'History101', `${previous}-01`);
    await successful(await call(owner, `rooms/${data.room}`, 'PATCH', { propertyId: data.property, name: 'History101', suggestedPaise: 950_000, suggestedDay: 10 }));
    expect((await successful(await call(owner, `ledger?leaseId=${data.lease}`)))[0].amountPaise).toBe(800_000);
    await successful(await call(owner, `leases/${data.lease}/terms`, 'POST', { month: next, amountPaise: 900_000, dueDay: 31, reason: 'Future rent change' }), 201);
    await successful(await call(owner, 'ledger/generate', 'POST', { month: next, leaseId: data.lease }));
    const future = (await successful(await call(owner, `ledger?leaseId=${data.lease}&month=${next}`)))[0];
    expect(future.amountPaise).toBe(900_000);
    expect((await call(owner, `leases/${data.lease}/end`, 'POST', { endsOn: businessDay(), reason: 'Tenant moving out' })).status).toBe(409);
    const receipt = (await successful(await call(owner, 'payments', 'POST', payment(data, 800_000, {
      paidAt: dateInputToUtc(`${previous}-28T12:00`),
    })), 201)).payment;
    expect((await successful(await call(owner, `dashboard?month=${previous}`))).received).toBe('800000');
    expect((await successful(await call(owner, `dashboard?month=${month}`)))).toMatchObject({ received: '0', applied: '800000' });
    await successful(await call(owner, `ledger/${future.id}/void`, 'POST', { reason: 'Unused month after move-out' }));
    await successful(await call(owner, `leases/${data.lease}/end`, 'POST', { endsOn: businessDay(), reason: 'Tenant moving out' }));
    await successful(await call(owner, `tenants/${data.tenant}/archive`, 'POST'));
    const replacement = (await successful(await call(owner, 'tenants', 'POST', { name: 'Replacement tenant' }), 201)).id;
    await successful(await call(owner, 'leases', 'POST', { roomId: data.room, tenantId: replacement, startsOn: businessDay(), amountPaise: 1_000_000, dueDay: 5, depositPaise: 500_000 }), 201);
    const room = (await successful(await call(owner, 'rooms'))).find((row: { id: string }) => row.id === data.room);
    expect(room.leases[0].tenant.name).toBe('Replacement tenant');
    expect((await call(owner, `rooms/${data.room}/archive`, 'POST')).status).toBe(409);
    const history = await successful(await call(owner, `ledger?leaseId=${data.lease}&month=${month}`));
    expect(history[0]).toMatchObject({ amountPaise: 800_000, allocatedPaise: 800_000, status: 'PAID' });
    expect((await successful(await call(owner, `payments/${receipt.id}`))).notification.snapshot.room).toBe('History101');
    await expect(db.rentCharge.delete({ where: { id: data.charge } })).rejects.toBeDefined();
    const allocation = await db.allocation.findFirstOrThrow({ where: { paymentId: receipt.id } });
    await expect(db.allocation.update({ where: { id: allocation.id }, data: { amountPaise: 1 } })).rejects.toBeDefined();
  });

  test('holds restored receipts for reconciliation without changing money or duplicating audit events', async () => {
    const owner = await addOwner('recovery-owner');
    const data = await fixture(owner, 'Recovery101');
    await successful(await call(owner, 'settings', 'PATCH', { name: 'Recovery Rentals', whatsappEnabled: true }));
    const receipt = (await successful(await call(owner, 'payments', 'POST', payment(data, 1000), metaApp), 201)).payment;
    expect(receipt.notification.status).toBe('PENDING');
    const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    try {
      await client.connect();
      await client.query('BEGIN');
      expect(await quarantineRestoredReceipts(client)).toBeGreaterThan(0);
      expect((await client.query('SELECT status, reason, retryable FROM "NotificationOutbox" WHERE id = $1', [receipt.notification.id])).rows[0])
        .toEqual({ status: 'UNCERTAIN', reason: 'RESTORE_RECONCILIATION_REQUIRED', retryable: false });
      expect((await client.query('SELECT "amountPaise" FROM "Payment" WHERE id = $1', [receipt.id])).rows[0].amountPaise).toBe(1000);
      expect((await client.query('SELECT count(*)::int AS n FROM "AuditLog" WHERE "entityId" = $1 AND action = $2', [receipt.notification.id, 'notification.recovery_hold'])).rows[0].n).toBe(1);
      expect(await quarantineRestoredReceipts(client)).toBe(0);
      await client.query('INSERT INTO "Verification" (id, identifier, value, "expiresAt", "updatedAt") VALUES ($1, $2, $3, $4, $5)',
        [crypto.randomUUID(), 'recovery-test-link', 'synthetic-one-time-token', new Date(Date.now() + 60_000), new Date()]);
      const expired = await invalidateRestoredSessions(client);
      expect(BigInt(expired.expiredSessions)).toBeGreaterThan(0n);
      expect(BigInt(expired.expiredTokens)).toBeGreaterThan(0n);
      expect((await client.query('SELECT count(*)::int AS n FROM "Session"')).rows[0].n).toBe(0);
      expect((await client.query('SELECT count(*)::int AS n FROM "Verification"')).rows[0].n).toBe(0);
      expect(await invalidateRestoredSessions(client)).toEqual({ expiredSessions: '0', expiredTokens: '0' });
      expect((await client.query('SELECT "amountPaise" FROM "Payment" WHERE id = $1', [receipt.id])).rows[0].amountPaise).toBe(1000);
    } finally { await client.query('ROLLBACK'); await client.end(); }
    expect((await db.notificationOutbox.findUniqueOrThrow({ where: { id: receipt.notification.id } })).status).toBe('PENDING');
    await db.notificationOutbox.update({ where: { id: receipt.notification.id }, data: { status: 'CANCELLED', reason: 'TEST_COMPLETE' } });
  });
});

describe('owner activity, receipt filters and occupancy history', () => {
  test('scopes and redacts activity while applying inclusive IST dates and stable pagination', async () => {
    const owner = await addOwner('activity-owner');
    const other = await addOwner('activity-other');
    const entityId = crypto.randomUUID();
    await db.auditLog.createMany({ data: [
      { organizationId: owner.id, entityId, action: 'payment.recorded', createdAt: new Date('2024-01-01T18:29:59.999Z') },
      { organizationId: owner.id, entityId, actorId: owner.userId, action: 'payment.recorded', createdAt: new Date('2024-01-01T18:30:00.000Z'), details: { amountPaise: 10, accessToken: 'secret-not-for-owner-response', nested: { password: 'private' } } },
      { organizationId: owner.id, entityId, action: 'payment.recorded', createdAt: new Date('2024-01-02T18:29:59.999Z'), details: { amountPaise: 20 } },
      { organizationId: owner.id, entityId, action: 'payment.recorded', createdAt: new Date('2024-01-02T18:30:00.000Z') },
      { organizationId: other.id, entityId, action: 'payment.recorded', createdAt: new Date('2024-01-01T19:00:00.000Z'), details: { reason: 'OTHER_ORGANIZATION_PRIVATE_ACTIVITY' } },
    ] });
    const path = `audit?category=payment&q=payment%20recorded&entityId=${entityId}&from=2024-01-02&to=2024-01-02`;
    const events = await successful(await call(owner, path));
    expect(events).toHaveLength(2);
    expect(events.map((event: { details: { amountPaise: number } }) => event.details.amountPaise)).toEqual([20, 10]);
    expect(JSON.stringify(events)).not.toMatch(/secret-not-for-owner-response|accessToken|password|nested|OTHER_ORGANIZATION/);
    expect(events[0]).not.toHaveProperty('organizationId');
    const first = await successful(await call(owner, `${path}&take=1`));
    const second = await successful(await call(owner, `${path}&take=1&offset=1`));
    expect([first[0].id, second[0].id]).toEqual(events.map((event: { id: string }) => event.id));
    expect((await request(route(other, 'audit'), 'GET', undefined, owner.cookies)).status).toBe(404);
    expect((await call(owner, 'audit?from=2024-01-03&to=2024-01-02')).status).toBe(400);
    expect((await call(owner, 'audit?category=unknown')).status).toBe(400);
    expect((await call(owner, 'audit', 'POST', { action: 'erase.history' })).status).toBe(404);
  });

  test('filters receipts without exposing other owners, snapshots or sender credentials', async () => {
    const owner = await addOwner('receipt-filter-owner');
    const other = await addOwner('receipt-filter-other');
    const data = await fixture(owner, 'Filter101');
    const privateData = await fixture(other, 'Filter101');
    const disabled = (await successful(await call(owner, 'payments', 'POST', payment(data, 1000)), 201)).payment;
    await successful(await call(owner, 'settings', 'PATCH', { name: 'Filter Rentals', whatsappEnabled: true }));
    const queued = (await successful(await call(owner, 'payments', 'POST', payment(data, 1000)), 201)).payment;
    await successful(await call(other, 'settings', 'PATCH', { name: 'Other Filter Rentals', whatsappEnabled: true }));
    const foreign = (await successful(await call(other, 'payments', 'POST', payment(privateData, 1000)), 201)).payment;
    const rows = await successful(await call(owner, 'notifications?status=PENDING&q=Filter101'));
    expect(rows.map((row: { paymentId: string }) => row.paymentId)).toEqual([queued.id]);
    expect(rows[0].payment.lease.tenant.name).toBe(`Filter101 tenant ${slug}`);
    expect(rows[0]).not.toHaveProperty('snapshot');
    expect(rows[0]).not.toHaveProperty('providerId');
    expect(JSON.stringify(rows)).not.toContain('919876543210');
    expect((await successful(await call(owner, `notifications?q=${foreign.id}`)))).toEqual([]);
    expect((await successful(await call(owner, 'notifications?status=UNCONFIGURED')))[0].paymentId).toBe(disabled.id);
    expect((await call(owner, 'notifications?status=NOT_A_STATE')).status).toBe(400);
    expect((await request(route(other, 'messaging-health'), 'GET', undefined, owner.cookies)).status).toBe(404);
    expect(await successful(await call(owner, 'messaging-health'))).toEqual({ status: 'SIMULATED' });
    expect(await successful(await call(owner, 'messaging-health', 'GET', undefined, metaApp))).toEqual({ status: 'CONFIGURED' });
    const missingCredentials = createApp(apiDb, { ...meta, META_ACCESS_TOKEN: undefined }).app;
    expect(await successful(await call(owner, 'messaging-health', 'GET', undefined, missingCredentials))).toEqual({ status: 'UNCONFIGURED' });
    await successful(await call(owner, 'settings', 'PATCH', { name: 'Filter Rentals', whatsappEnabled: false }));
    expect(await successful(await call(owner, 'messaging-health', 'GET', undefined, metaApp))).toEqual({ status: 'DISABLED' });
  });

  test('reports historical occupancy from recorded room availability with exclusive move-out and scoped filters', async () => {
    const owner = await addOwner('occupancy-owner');
    const other = await addOwner('occupancy-other');
    const current = businessMonth();
    const previous = monthKey(shiftMonth(periodDate(current), -1));
    const opening = monthKey(shiftMonth(periodDate(current), -2));
    const beforeOpening = monthKey(shiftMonth(periodDate(current), -3));
    const data = await fixture(owner, 'Occupancy101', `${opening}-01`);
    const foreign = await fixture(other, 'Occupancy101', `${opening}-01`);
    const unused = await successful(await call(owner, `ledger?leaseId=${data.lease}`));
    for (const charge of unused.filter((row: { month: string }) => row.month >= previous)) {
      await successful(await call(owner, `ledger/${charge.id}/void`, 'POST', { reason: 'Unused rent after historic move-out' }));
    }
    await successful(await call(owner, `leases/${data.lease}/end`, 'POST', { endsOn: `${previous}-01`, reason: 'Historic move-out' }));
    const replacement = (await successful(await call(owner, 'tenants', 'POST', { name: 'Occupancy replacement' }), 201)).id;
    await successful(await call(owner, 'leases', 'POST', { roomId: data.room, tenantId: replacement, startsOn: `${previous}-01`, amountPaise: 900_000, dueDay: 5 }), 201);
    const vacant = (await successful(await call(owner, 'rooms', 'POST', { propertyId: data.property, name: 'Newly recorded vacant room' }), 201)).id;
    for (const month of [opening, previous]) {
      const summary = await successful(await call(owner, `dashboard?month=${month}`));
      expect(summary).toMatchObject({ rooms: 1, occupied: 1, vacant: 0, activeTenants: 1 });
      expect(summary.occupancy).toHaveLength(1);
      expect(summary.occupancy[0]).toMatchObject({ month, rooms: 1, occupied: 1, vacant: 0 });
    }
    const summary = await successful(await call(owner, `dashboard?month=${current}`));
    expect(summary).toMatchObject({ rooms: 2, occupied: 1, vacant: 1, activeTenants: 1 });
    expect(summary.occupancy[0].asOf).toBe(businessDay());
    expect((await successful(await call(owner, `dashboard?month=${beforeOpening}`))).rooms).toBe(0);
    const former = await successful(await call(owner, `dashboard?month=${previous}&tenantId=${data.tenant}`));
    expect(former).toMatchObject({ rooms: 0, occupied: 0, vacant: 0 });
    expect((await successful(await call(owner, `dashboard?month=${opening}&tenantId=${data.tenant}`))).occupied).toBe(1);
    const year = await successful(await call(owner, `dashboard?year=${current.slice(0, 4)}`));
    expect(year.occupancy.at(-1)).toMatchObject({ month: current, rooms: 2, occupied: 1, vacant: 1 });
    expect(year.occupancy).toHaveLength(Number(current.slice(5)));
    const future = monthKey(shiftMonth(periodDate(current), 1));
    expect((await successful(await call(owner, `dashboard?month=${future}`))).occupancy).toEqual([]);
    expect((await call(owner, `dashboard?roomId=${foreign.room}`)).status).toBe(404);
    await successful(await call(owner, `rooms/${vacant}/archive`, 'POST'));
    expect((await successful(await call(owner, `dashboard?month=${current}`))).rooms).toBe(1);
  });
});
