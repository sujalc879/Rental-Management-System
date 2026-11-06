import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createApp } from '../apps/api/src/app';
import { readConfig } from '../apps/api/src/config';
import { dispatchOne, recoverExpiredClaims } from '../apps/api/src/messaging';
import { runBillingJob, scheduleBilling } from '../apps/worker/src/billing';
import { businessDay, businessMonth, monthKey, periodDate, shiftMonth } from '../packages/shared/src/ledger';
import { provisionOwner } from '../scripts/owners';
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
  const signIn = await request('/api/auth/sign-in/email', 'POST', { email, password });
  const cookies = cookie(signIn);
  await successful(signIn);
  expect(cookies).toContain('session_token=');
  return { id: organization.id, userId: user.id, cookies };
}
async function fixture(owner: Owner, label: string): Promise<Fixture> {
  const property = (await successful(await call(owner, 'properties', 'POST', { name: `${label} property ${slug}` }), 201)).id;
  const room = (await successful(await call(owner, 'rooms', 'POST', { name: label, propertyId: property }), 201)).id;
  const tenant = (await successful(await call(owner, 'tenants', 'POST', { name: `${label} tenant ${slug}`, whatsapp: '+919876543210' }), 201)).id;
  await successful(await call(owner, `tenants/${tenant}/consent`, 'POST', { allowed: true, source: 'Test record of opt-in' }));
  const lease = (await successful(await call(owner, 'leases', 'POST', { roomId: room, tenantId: tenant, startsOn: `${businessMonth()}-01`, amountPaise: 800_000, dueDay: 5 }), 201)).id;
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
    await successful(await request('/api/auth/request-password-reset', 'POST', { email, redirectTo: `${origin}/reset` }));
    const reset = (await mails()).find(row => row.to === email && row.subject.includes('password'));
    const redirect = (await app.request(reset.url)).headers.get('location');
    const token = new URL(redirect!).searchParams.get('token');
    const newPassword = `${password}-reset`;
    await successful(await request('/api/auth/reset-password', 'POST', { token, newPassword }));
    expect((await request('/api/auth/sign-in/email', 'POST', { email, password })).status).toBe(401);
    const signedIn = await request('/api/auth/sign-in/email', 'POST', { email, password: newPassword });
    const cookies = cookie(signedIn);
    await successful(signedIn);
    await db.session.updateMany({ where: { userId: account.user.id }, data: { expiresAt: new Date(0) } });
    expect((await request('/api/organizations', 'GET', undefined, cookies)).status).toBe(401);
    const second = await request('/api/auth/sign-in/email', 'POST', { email, password: newPassword });
    const secondCookie = cookie(second);
    await successful(second);
    await successful(await request('/api/auth/sign-out', 'POST', {}, secondCookie));
    expect((await request('/api/organizations', 'GET', undefined, secondCookie)).status).toBe(401);
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
});
