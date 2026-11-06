import type { z } from 'zod';
import { Prisma } from '../../../packages/db/generated/client';
import type { reportInput } from '../../../packages/shared/src/input';
import { businessDay, businessMonth, calendarDate, dateInputToUtc, monthKey, periodDate, shiftMonth } from '../../../packages/shared/src/ledger';
import { DomainError, missing, type Scope, type Tx } from './domain';

export type Filters = z.infer<typeof reportInput>;
type LedgerStatus = NonNullable<Filters['status']>;
type LedgerRow = {
  id: string; leaseId: string; month: string; dueOn: string; amountPaise: number; allocatedPaise: number;
  outstandingPaise: number; overdue: boolean; status: LedgerStatus; tenant: string; room: string; property: string;
};

export async function verifyFilters(tx: Tx, scope: Scope, filters: Filters) {
  const organizationId = scope.organizationId;
  if (filters.roomId && !await tx.room.findFirst({ where: { organizationId, id: filters.roomId }, select: { id: true } })) throw missing();
  if (filters.propertyId && !await tx.property.findFirst({ where: { organizationId, id: filters.propertyId }, select: { id: true } })) throw missing();
  if (filters.tenantId && !await tx.tenant.findFirst({ where: { organizationId, id: filters.tenantId }, select: { id: true } })) throw missing();
  if (filters.leaseId && !await tx.lease.findFirst({ where: { organizationId, id: filters.leaseId }, select: { id: true } })) throw missing();
}

function periodRange(filters: Filters) {
  if (!filters.month && !filters.year) return null;
  const start = periodDate(filters.month ?? `${filters.year}-01`);
  return [monthKey(start), monthKey(shiftMonth(start, filters.month ? 1 : 12))] as const;
}

function ledgerCte(scope: Scope, filters: Filters) {
  const range = periodRange(filters);
  return Prisma.sql`WITH ledger AS (
    SELECT c.id, c."leaseId", to_char(c.period, 'YYYY-MM') AS month, to_char(c."dueOn", 'YYYY-MM-DD') AS "dueOn",
      c."amountPaise", a.amount::int AS "allocatedPaise",
      CASE WHEN c."voidedAt" IS NULL THEN (c."amountPaise" - a.amount)::int ELSE 0 END AS "outstandingPaise",
      (c."voidedAt" IS NULL AND a.amount < c."amountPaise" AND c."dueOn" < ${businessDay()}::date) AS overdue,
      CASE WHEN c."voidedAt" IS NOT NULL THEN 'VOID' WHEN a.amount = c."amountPaise" THEN 'PAID'
        WHEN a.amount > 0 THEN 'PARTIAL' WHEN c."dueOn" < ${businessDay()}::date THEN 'OVERDUE' ELSE 'UNPAID' END AS status,
      t.name AS tenant, r.name AS room, p.name AS property, r.id AS "roomId"
    FROM "RentCharge" c
    JOIN "Lease" l ON (l."organizationId", l.id) = (c."organizationId", c."leaseId")
    JOIN "Room" r ON (r."organizationId", r.id) = (l."organizationId", l."roomId")
    JOIN "Property" p ON (p."organizationId", p.id) = (r."organizationId", r."propertyId")
    JOIN "Tenant" t ON (t."organizationId", t.id) = (l."organizationId", l."tenantId")
    CROSS JOIN LATERAL (
      SELECT COALESCE(SUM(x."amountPaise"), 0) AS amount FROM "Allocation" x
      WHERE x."organizationId" = c."organizationId" AND x."leaseId" = c."leaseId" AND x."chargeId" = c.id
        AND NOT EXISTS (SELECT 1 FROM "PaymentReversal" v WHERE (v."organizationId", v."paymentId") = (x."organizationId", x."paymentId"))
    ) a
    WHERE c."organizationId" = ${scope.organizationId}::uuid
      ${range ? Prisma.sql`AND c.period >= ${`${range[0]}-01`}::date AND c.period < ${`${range[1]}-01`}::date` : Prisma.empty}
      ${filters.leaseId ? Prisma.sql`AND l.id = ${filters.leaseId}::uuid` : Prisma.empty}
      ${filters.roomId ? Prisma.sql`AND r.id = ${filters.roomId}::uuid` : Prisma.empty}
      ${filters.propertyId ? Prisma.sql`AND p.id = ${filters.propertyId}::uuid` : Prisma.empty}
      ${filters.tenantId ? Prisma.sql`AND t.id = ${filters.tenantId}::uuid` : Prisma.empty}
      ${filters.q ? Prisma.sql`AND (strpos(lower(t.name), lower(${filters.q})) > 0 OR strpos(lower(r.name), lower(${filters.q})) > 0 OR strpos(lower(p.name), lower(${filters.q})) > 0)` : Prisma.empty}
  )`;
}

const ledgerStatus = (filters: Filters) => filters.status ? Prisma.sql`WHERE status = ${filters.status}` : Prisma.empty;

export function ledger(tx: Tx, scope: Scope, filters: Filters, exportRows = false) {
  return tx.$queryRaw<LedgerRow[]>`${ledgerCte(scope, filters)} SELECT * FROM ledger ${ledgerStatus(filters)}
    ORDER BY month DESC, "dueOn", id LIMIT ${exportRows ? 50_001 : filters.take} OFFSET ${exportRows ? 0 : filters.offset}`;
}

function paymentWhere(scope: Scope, filters: Filters): Prisma.PaymentWhereInput {
  const range = periodRange(filters);
  return {
    organizationId: scope.organizationId, leaseId: filters.leaseId, mode: filters.mode,
    reversal: filters.paymentStatus === 'REVERSED' ? { isNot: null } : filters.paymentStatus === 'RECORDED' ? null : undefined,
    paidAt: range ? { gte: new Date(dateInputToUtc(`${range[0]}-01T00:00:00`)), lt: new Date(dateInputToUtc(`${range[1]}-01T00:00:00`)) } : undefined,
    lease: { tenantId: filters.tenantId, roomId: filters.roomId, room: { propertyId: filters.propertyId } },
    OR: filters.q ? [{ reference: { contains: filters.q, mode: 'insensitive' } }, { lease: { tenant: { name: { contains: filters.q, mode: 'insensitive' } } } }] : undefined,
  };
}

export function payments(tx: Tx, scope: Scope, filters: Filters, exportRows = false) {
  return tx.payment.findMany({ where: paymentWhere(scope, filters), orderBy: [{ paidAt: 'desc' }, { id: 'desc' }],
    skip: exportRows ? 0 : filters.offset, take: exportRows ? 50_001 : filters.take,
    select: { id: true, paidAt: true, createdAt: true, amountPaise: true, mode: true, reference: true, source: true, leaseId: true,
      reversal: { select: { createdAt: true } }, notification: { select: { id: true, status: true } },
      lease: { select: { tenant: { select: { name: true } }, room: { select: { name: true, property: { select: { name: true } } } } } },
    },
  });
}

export async function dashboard(tx: Tx, scope: Scope, filters: Filters) {
  const period = filters.month ?? (filters.year ? undefined : businessMonth());
  const selection = { ...filters, month: period };
  const range = periodRange(selection);
  const organizationId = scope.organizationId;
  const today = calendarDate(businessDay());
  const occupancyDate = range && (period !== businessMonth() && filters.year !== businessMonth().slice(0, 4))
    ? calendarDate(`${range[1]}-01`) : today;
  if (occupancyDate !== today) occupancyDate.setUTCDate(0);
  const archiveCutoff = new Date(dateInputToUtc(`${occupancyDate.toISOString().slice(0, 10)}T23:59:59.999`));
  const currentLease: Prisma.LeaseWhereInput = { organizationId, startsOn: { lte: occupancyDate },
    OR: [{ endsOn: null }, { endsOn: { gt: occupancyDate } }], tenantId: filters.tenantId, id: filters.leaseId };
  const roomWhere: Prisma.RoomWhereInput = { organizationId, propertyId: filters.propertyId, id: filters.roomId,
    OR: [{ archivedAt: null }, { archivedAt: { gt: archiveCutoff } }],
  };
  const rooms = await tx.room.count({ where: roomWhere });
  const occupied = await tx.room.count({ where: { ...roomWhere, leases: { some: currentLease } } });
  const activeTenants = await tx.tenant.count({ where: { organizationId, id: filters.tenantId, leases: { some: { ...currentLease, room: roomWhere } } } });
  const summary = await tx.$queryRaw<{ expected: string; applied: string; outstanding: string; overdue: string }[]>`${ledgerCte(scope, selection)}
      SELECT COALESCE(SUM("amountPaise") FILTER (WHERE status <> 'VOID'), 0)::text AS expected,
        COALESCE(SUM("allocatedPaise"), 0)::text AS applied, COALESCE(SUM("outstandingPaise"), 0)::text AS outstanding,
        COALESCE(SUM("outstandingPaise") FILTER (WHERE overdue), 0)::text AS overdue FROM ledger ${ledgerStatus(filters)}`;
  const cashModes = await tx.$queryRaw<{ mode: 'CASH' | 'ONLINE'; amount: string }[]>`SELECT x.mode::text, SUM(x."amountPaise")::text AS amount
      FROM "Payment" x JOIN "Lease" l ON (x."organizationId", x."leaseId") = (l."organizationId", l.id)
      JOIN "Room" r ON (l."organizationId", l."roomId") = (r."organizationId", r.id)
      JOIN "Tenant" t ON (l."organizationId", l."tenantId") = (t."organizationId", t.id)
      WHERE x."organizationId" = ${organizationId}::uuid
        AND NOT EXISTS (SELECT 1 FROM "PaymentReversal" v WHERE (v."organizationId", v."paymentId") = (x."organizationId", x.id))
        ${range ? Prisma.sql`AND x."paidAt" >= ${dateInputToUtc(`${range[0]}-01T00:00:00`)}::timestamptz AND x."paidAt" < ${dateInputToUtc(`${range[1]}-01T00:00:00`)}::timestamptz` : Prisma.empty}
        ${filters.roomId ? Prisma.sql`AND r.id = ${filters.roomId}::uuid` : Prisma.empty}
        ${filters.propertyId ? Prisma.sql`AND r."propertyId" = ${filters.propertyId}::uuid` : Prisma.empty}
        ${filters.tenantId ? Prisma.sql`AND l."tenantId" = ${filters.tenantId}::uuid` : Prisma.empty}
        ${filters.leaseId ? Prisma.sql`AND l.id = ${filters.leaseId}::uuid` : Prisma.empty}
        ${filters.mode ? Prisma.sql`AND x.mode = ${filters.mode}::"PaymentMode"` : Prisma.empty}
        ${filters.paymentStatus === 'REVERSED' ? Prisma.sql`AND false` : Prisma.empty}
        ${filters.q ? Prisma.sql`AND (strpos(lower(t.name), lower(${filters.q})) > 0 OR strpos(lower(x.reference), lower(${filters.q})) > 0)` : Prisma.empty}
      GROUP BY x.mode`;
  const recentPayments = await payments(tx, scope, { ...selection, offset: 0, take: 5 });
  const notices = await tx.notificationOutbox.groupBy({ by: ['status'], where: { organizationId, status: { in: ['PENDING', 'SENDING', 'FAILED', 'UNCERTAIN'] } }, _count: { _all: true } });
  const upcoming = await tx.$queryRaw<LedgerRow[]>`${ledgerCte(scope, { ...filters, month: undefined, year: undefined })} SELECT * FROM ledger
      WHERE "outstandingPaise" > 0 AND "dueOn" >= ${businessDay()} ORDER BY "dueOn", id LIMIT 5`;
  const byRoom = await tx.$queryRaw<{ property: string; room: string; roomId: string; amount: string; outstanding: string }[]>`${ledgerCte(scope, selection)}
      SELECT property, room, "roomId", SUM("amountPaise")::text AS amount, SUM("outstandingPaise")::text AS outstanding
      FROM ledger WHERE status <> 'VOID' GROUP BY property, room, "roomId" ORDER BY property, room, "roomId" LIMIT 100`;
  const trend = await tx.$queryRaw<{ month: string; expected: string; applied: string }[]>`${ledgerCte(scope, { ...filters, month: undefined, year: undefined })}
    SELECT month, SUM("amountPaise")::text AS expected, SUM("allocatedPaise")::text AS applied FROM ledger WHERE status <> 'VOID'
      AND month BETWEEN ${monthKey(shiftMonth(periodDate(period ?? `${filters.year ?? businessMonth().slice(0, 4)}-12`), -11))} AND ${period ?? `${filters.year ?? businessMonth().slice(0, 4)}-12`}
      GROUP BY month ORDER BY month`;
  return { month: period, year: filters.year, rooms, occupied, vacant: rooms - occupied, activeTenants, ...summary[0],
    received: cashModes.reduce((sum, row) => sum + BigInt(row.amount), 0n).toString(), cashModes, recentPayments, notices, upcoming, byRoom, trend };
}

export function csv(rows: (string | number | Date | null)[][]) {
  const cell = (input: string | number | Date | null) => {
    const value = input instanceof Date ? input.toISOString() : String(input ?? '');
    const safe = /^[\s\uFEFF]*[=+\-@\t\r\n]/u.test(value) ? `'${value}` : value;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  return rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

export async function exportCsv(tx: Tx, scope: Scope, filters: Filters, kind: 'ledger' | 'payments') {
  if (kind === 'ledger') {
    const rows = await ledger(tx, scope, filters, true);
    if (rows.length > 50_000) throw new DomainError(413, 'Narrow the report before exporting');
    return csv([['Billing month', 'Property', 'Room', 'Tenant', 'Due on', 'Rent paise', 'Allocated paise', 'Outstanding paise', 'Status'],
      ...rows.map(row => [row.month, row.property, row.room, row.tenant, row.dueOn, row.amountPaise, row.allocatedPaise, row.outstandingPaise, row.status])]);
  }
  const rows = await payments(tx, scope, filters, true);
  if (rows.length > 50_000) throw new DomainError(413, 'Narrow the report before exporting');
  return csv([['Payment ID', 'Received at UTC', 'Property', 'Room', 'Tenant', 'Amount paise', 'Mode', 'Online reference', 'Verification', 'Reversed at UTC'],
    ...rows.map(row => [row.id, row.paidAt, row.lease.room.property.name, row.lease.room.name, row.lease.tenant.name, row.amountPaise, row.mode, row.reference, row.source, row.reversal?.createdAt ?? null])]);
}
