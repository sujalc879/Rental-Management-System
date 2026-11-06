import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { z } from 'zod';
import type { Database } from '../../../packages/db/src/index';
import { consentInput, creditInput, endInput, generateInput, id, leaseInput, name, pageInput, paymentInput, propertyInput, reason, reportInput, roomInput, tenantInput, termInput } from '../../../packages/shared/src/input';
import { businessDay, businessMonth, calendarDate, periodDate } from '../../../packages/shared/src/ledger';
import { createAuth } from './auth';
import type { Config } from './config';
import { atomic, audit, DomainError, missing, type Scope } from './domain';
import { receiveWebhook, retryNotification, verifyWebhook } from './messaging';
import { applyCredit, recordPayment, reversePayment, voidCharge } from './payments';
import { receiptSchema } from './receipt';
import { dashboard, exportCsv, ledger, payments, verifyFilters } from './reports';
import { archiveRental, changeConsent, changeTerms, createLease, endLease, generateMonth, saveProperty, saveRoom, saveTenant } from './rentals';

type Variables = { actorId: string; scope: Scope };
type ApiContext = Context<{ Variables: Variables }>;
const routeId = (c: ApiContext, field = 'id') => id.parse(c.req.param(field));
const scopeOf = (c: ApiContext) => c.get('scope');
const asReason = z.strictObject({ reason });
const appSettings = z.strictObject({ name, whatsappEnabled: z.boolean() });

async function body<T>(c: ApiContext, schema: z.ZodType<T>): Promise<T> {
  if (c.req.header('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new DomainError(415, 'Send an application/json request');
  const json = await c.req.json().catch(() => { throw new DomainError(400, 'Invalid JSON request'); });
  return schema.parse(json);
}

export function createApp(db: Database, config: Config) {
  const auth = createAuth(db, config);
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', secureHeaders({
    strictTransportSecurity: config.NODE_ENV === 'production' ? 'max-age=31536000' : false,
    referrerPolicy: 'no-referrer', xFrameOptions: 'DENY',
  }));
  app.use('/api/*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  app.use('/api/*', bodyLimit({ maxSize: 256 * 1024, onError: c => c.json({ error: 'Request is too large' }, 413) }));
  app.onError((error, c) => {
    if (error instanceof z.ZodError) return c.json({ error: 'Check the submitted fields', issues: error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message })) }, 400);
    if (error instanceof DomainError) {
      if (error.status === 404 && c.get('scope')) console.warn(JSON.stringify({ event: 'resource.inaccessible', ...c.get('scope'), method: c.req.method }));
      return c.json({ error: error.message, code: error.code }, error.status);
    }
    const code = 'code' in error && typeof error.code === 'string' ? error.code : null;
    if (code === 'P2025') return c.json({ error: 'Record not found' }, 404);
    if (code === 'P2002' || code === 'P2003' || code === 'P2004' || code === 'P2034') return c.json({ error: 'This change conflicts with an existing record. Refresh and try again.' }, 409);
    console.error(JSON.stringify({ event: 'api.error', method: c.req.method, kind: error.name, code }));
    return c.json({ error: 'An unexpected error occurred' }, 500);
  });
  app.get('/health', c => c.json({ status: 'ok' }));
  app.get('/ready', async c => {
    try { await db.$queryRaw`SELECT 1`; return c.json({ status: 'ready' }); }
    catch { return c.json({ status: 'unavailable' }, 503); }
  });
  app.get('/api/webhooks/whatsapp', c => verifyWebhook(config, new URL(c.req.url)));
  app.post('/api/webhooks/whatsapp', c => receiveWebhook(db, config, c.req.raw));

  app.use('/api/*', async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && c.req.header('origin') !== config.APP_ORIGIN) {
      throw new DomainError(403, 'Untrusted request origin');
    }
    await next();
  });
  app.on(['GET', 'POST'], '/api/auth/*', async c => {
    const response = await auth.handler(c.req.raw);
    if (response.status >= 400 && c.req.method === 'POST') console.warn(JSON.stringify({ event: 'authentication.rejected', status: response.status }));
    return response;
  });
  app.use('/api/*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user.emailVerified) throw new DomainError(401, 'Sign in with a verified email');
    c.set('actorId', session.user.id);
    await next();
  });
  app.get('/api/organizations', async c => c.json(await db.membership.findMany({ where: { userId: c.get('actorId'), role: 'OWNER' },
    select: { organization: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' },
  })));
  app.use('/api/orgs/:organizationId/*', async (c, next) => {
    const organizationId = routeId(c, 'organizationId');
    const actorId = c.get('actorId');
    const member = await db.membership.findFirst({ where: { organizationId, userId: actorId, role: 'OWNER', user: { emailVerified: true } }, select: { organizationId: true } });
    if (!member) {
      console.warn(JSON.stringify({ event: 'authorization.denied', actorId, target: 'organization' }));
      throw missing();
    }
    c.set('scope', { organizationId, actorId });
    await next();
  });

  const base = '/api/orgs/:organizationId';
  const page = (c: ApiContext) => pageInput.parse(c.req.query());
  const report = (c: ApiContext) => reportInput.parse(c.req.query());
  const contains = (q: string | undefined) => q ? { contains: q, mode: 'insensitive' as const } : undefined;
  const missingIfNull = <T>(result: T | null) => { if (!result) throw missing(); return result; };

  app.get(`${base}/settings`, async c => c.json(await db.organization.findUniqueOrThrow({ where: { id: scopeOf(c).organizationId }, select: { name: true, whatsappEnabled: true } })));
  app.patch(`${base}/settings`, async c => {
    const input = await body(c, appSettings);
    const scope = scopeOf(c);
    return c.json(await atomic(db, scope, async tx => {
      const data = await tx.organization.update({ where: { id: scope.organizationId }, data: input, select: { name: true, whatsappEnabled: true } });
      await audit(tx, scope, 'organization.settings_updated', scope.organizationId, { whatsappEnabled: input.whatsappEnabled });
      return data;
    }));
  });
  app.get(`${base}/properties`, async c => {
    const { q, take, offset } = page(c);
    return c.json(await db.property.findMany({ where: { organizationId: scopeOf(c).organizationId, name: contains(q) }, orderBy: [{ name: 'asc' }, { id: 'asc' }], take, skip: offset }));
  });
  app.get(`${base}/properties/:id`, async c => c.json(missingIfNull(await db.property.findFirst({ where: { organizationId: scopeOf(c).organizationId, id: routeId(c) } }))));
  app.post(`${base}/properties`, async c => c.json(await saveProperty(db, scopeOf(c), await body(c, propertyInput)), 201));
  app.patch(`${base}/properties/:id`, async c => c.json(await saveProperty(db, scopeOf(c), await body(c, propertyInput), routeId(c))));

  app.get(`${base}/rooms`, async c => {
    const { q, take, offset, propertyId, occupancy } = pageInput.extend({ propertyId: id.optional(), occupancy: z.enum(['occupied', 'vacant', 'archived']).optional() }).parse(c.req.query());
    const organizationId = scopeOf(c).organizationId;
    if (propertyId && !await db.property.findFirst({ where: { organizationId, id: propertyId } })) throw missing();
    const today = calendarDate(businessDay());
    const active = { organizationId, startsOn: { lte: today }, OR: [{ endsOn: null }, { endsOn: { gt: today } }] };
    return c.json(await db.room.findMany({ where: { organizationId, propertyId, name: contains(q),
      archivedAt: occupancy === 'archived' ? { not: null } : occupancy ? null : undefined,
      leases: occupancy === 'occupied' ? { some: active } : occupancy === 'vacant' ? { none: active } : undefined,
    }, include: { property: { select: { name: true } }, leases: { where: active, take: 1, include: {
      tenant: { select: { id: true, name: true } }, terms: { where: { period: { lte: periodDate(businessMonth()) } }, orderBy: { period: 'desc' }, take: 1, select: { amountPaise: true, dueDay: true } },
    } } },
    orderBy: [{ name: 'asc' }, { id: 'asc' }], take, skip: offset }));
  });
  app.get(`${base}/rooms/:id`, async c => c.json(missingIfNull(await db.room.findFirst({ where: { organizationId: scopeOf(c).organizationId, id: routeId(c) },
    include: { property: { select: { name: true } } },
  }))));
  app.post(`${base}/rooms`, async c => c.json(await saveRoom(db, scopeOf(c), await body(c, roomInput)), 201));
  app.patch(`${base}/rooms/:id`, async c => c.json(await saveRoom(db, scopeOf(c), await body(c, roomInput), routeId(c))));
  app.post(`${base}/rooms/:id/archive`, async c => c.json(await archiveRental(db, scopeOf(c), 'room', routeId(c))));

  app.get(`${base}/tenants`, async c => {
    const { q, take, offset } = page(c);
    return c.json(await db.tenant.findMany({ where: { organizationId: scopeOf(c).organizationId, name: contains(q) }, orderBy: [{ name: 'asc' }, { id: 'asc' }], take, skip: offset }));
  });
  app.get(`${base}/tenants/:id`, async c => c.json(missingIfNull(await db.tenant.findFirst({ where: { organizationId: scopeOf(c).organizationId, id: routeId(c) } }))));
  app.post(`${base}/tenants`, async c => c.json(await saveTenant(db, scopeOf(c), await body(c, tenantInput)), 201));
  app.patch(`${base}/tenants/:id`, async c => c.json(await saveTenant(db, scopeOf(c), await body(c, tenantInput), routeId(c))));
  app.post(`${base}/tenants/:id/archive`, async c => c.json(await archiveRental(db, scopeOf(c), 'tenant', routeId(c))));
  app.post(`${base}/tenants/:id/consent`, async c => c.json(await changeConsent(db, scopeOf(c), routeId(c), await body(c, consentInput))));

  app.get(`${base}/leases`, async c => {
    const filters = report(c);
    const scope = scopeOf(c);
    await verifyFilters(db, scope, filters);
    return c.json(await db.lease.findMany({ where: { organizationId: scope.organizationId, roomId: filters.roomId, tenantId: filters.tenantId,
      room: { propertyId: filters.propertyId }, OR: filters.q ? [{ tenant: { name: contains(filters.q) } }, { room: { name: contains(filters.q) } }] : undefined,
    }, include: { terms: { orderBy: { period: 'asc' } }, room: { select: { name: true } }, tenant: { select: { name: true } } },
    orderBy: [{ startsOn: 'desc' }, { id: 'desc' }], take: filters.take, skip: filters.offset }));
  });
  app.get(`${base}/leases/:id`, async c => c.json(missingIfNull(await db.lease.findFirst({ where: { organizationId: scopeOf(c).organizationId, id: routeId(c) },
    include: { terms: { orderBy: { period: 'asc' } }, room: { select: { name: true } }, tenant: { select: { name: true } } },
  }))));
  app.post(`${base}/leases`, async c => c.json(await createLease(db, scopeOf(c), await body(c, leaseInput)), 201));
  app.post(`${base}/leases/:id/end`, async c => c.json(await endLease(db, scopeOf(c), routeId(c), await body(c, endInput))));
  app.post(`${base}/leases/:id/terms`, async c => c.json(await changeTerms(db, scopeOf(c), routeId(c), await body(c, termInput)), 201));

  app.post(`${base}/ledger/generate`, async c => {
    const input = await body(c, generateInput);
    return c.json(await generateMonth(db, scopeOf(c), input.month, input.leaseId));
  });
  app.post(`${base}/ledger/:id/void`, async c => c.json(await voidCharge(db, scopeOf(c), routeId(c), (await body(c, asReason)).reason)));
  app.get(`${base}/ledger`, async c => {
    const filters = report(c); const scope = scopeOf(c);
    await verifyFilters(db, scope, filters);
    return c.json(await ledger(db, scope, filters));
  });
  app.get(`${base}/payments`, async c => {
    const filters = report(c); const scope = scopeOf(c);
    await verifyFilters(db, scope, filters);
    return c.json(await payments(db, scope, filters));
  });
  app.get(`${base}/payments/:id`, async c => {
    const payment = missingIfNull(await db.payment.findFirst({ where: { organizationId: scopeOf(c).organizationId, id: routeId(c) },
      select: { id: true, leaseId: true, paidAt: true, createdAt: true, amountPaise: true, mode: true, reference: true, source: true, notes: true,
        reversal: { select: { createdAt: true, reason: true } }, notification: { select: { id: true, status: true, snapshot: true } },
        allocations: { select: { id: true, amountPaise: true, charge: { select: { period: true } } }, orderBy: { createdAt: 'asc' } },
      },
    }));
    const creditPaise = payment.reversal ? 0 : payment.amountPaise - payment.allocations.reduce((total, row) => total + row.amountPaise, 0);
    const receipt = payment.notification ? receiptSchema.parse(payment.notification.snapshot) : null;
    const snapshot = receipt && { tenant: receipt.tenant, owner: receipt.owner, property: receipt.property, room: receipt.room };
    return c.json({ ...payment, creditPaise, notification: payment.notification && { ...payment.notification, snapshot } });
  });
  app.post(`${base}/payments`, async c => {
    const result = await recordPayment(db, config, scopeOf(c), await body(c, paymentInput));
    return c.json(result, result.replay ? 200 : 201);
  });
  app.post(`${base}/payments/:id/reverse`, async c => c.json(await reversePayment(db, scopeOf(c), routeId(c), (await body(c, asReason)).reason)));
  app.post(`${base}/payments/:id/credit`, async c => c.json(await applyCredit(db, scopeOf(c), routeId(c), await body(c, creditInput))));
  app.get(`${base}/dashboard`, async c => {
    const filters = report(c); const scope = scopeOf(c);
    return c.json(await db.$transaction(async tx => { await verifyFilters(tx, scope, filters); return dashboard(tx, scope, filters); }, { isolationLevel: 'RepeatableRead' }));
  });
  app.get(`${base}/exports/:kind`, async c => {
    const kind = z.enum(['ledger', 'payments']).parse(c.req.param('kind'));
    const filters = report(c); const scope = scopeOf(c);
    const content = await db.$transaction(async tx => { await verifyFilters(tx, scope, filters); return exportCsv(tx, scope, filters, kind); }, { isolationLevel: 'RepeatableRead' });
    return c.body(content, 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="rental-${kind}.csv"` });
  });
  app.get(`${base}/notifications`, async c => {
    const { take, offset } = page(c);
    return c.json(await db.notificationOutbox.findMany({ where: { organizationId: scopeOf(c).organizationId },
      select: { id: true, paymentId: true, status: true, reason: true, retryable: true, manualRetries: true, attempts: true, createdAt: true, updatedAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take, skip: offset,
    }));
  });
  app.post(`${base}/notifications/:id/retry`, async c => c.json(await retryNotification(db, config, scopeOf(c), routeId(c))));
  app.get(`${base}/audit`, async c => {
    const { take, offset } = page(c);
    return c.json(await db.auditLog.findMany({ where: { organizationId: scopeOf(c).organizationId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take, skip: offset }));
  });
  app.get(`${base}/backup-health`, async c => {
    if (!config.BACKUP_ENABLED) return c.json({ status: 'UNCONFIGURED' });
    const last = await db.backupRun.findFirst({ where: { status: 'SUCCESS' }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } });
    return c.json({ status: last && Date.now() - last.startedAt.getTime() < 25 * 3_600_000 ? 'HEALTHY' : 'OVERDUE', lastSuccessAt: last?.startedAt });
  });
  app.notFound(c => c.json({ error: 'Record not found' }, 404));
  return { app, auth };
}
