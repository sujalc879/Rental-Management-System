import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import type { z } from 'zod';
import type { Database } from '../../../packages/db/src/index';
import { businessDay, businessMonth, calendarDate, dueDate, periodDate, shiftMonth } from '../../../packages/shared/src/ledger';
import type { endInput, leaseInput, propertyInput, roomInput, tenantInput, termInput, consentInput } from '../../../packages/shared/src/input';
import { atomic, audit, conflict, DomainError, missing, type Scope, type Tx } from './domain';

function normalizedPhone(value: string | null | undefined) {
  if (!value) return value;
  const phone = parsePhoneNumberFromString(value, { defaultCountry: 'IN', extract: false });
  if (!phone?.isValid() || phone.ext) throw new DomainError(400, 'Enter a valid phone number, including the country code for numbers outside India');
  return phone.number;
}

export function saveProperty(db: Database, scope: Scope, input: z.infer<typeof propertyInput>, id?: string) {
  return atomic(db, scope, async tx => {
    const organizationId = scope.organizationId;
    const property = id ? await tx.property.update({ where: { organizationId_id: { organizationId, id } }, data: input })
      : await tx.property.create({ data: { ...input, organizationId } });
    await audit(tx, scope, id ? 'property.updated' : 'property.created', property.id);
    return property;
  });
}

export function saveRoom(db: Database, scope: Scope, input: z.infer<typeof roomInput>, id?: string) {
  return atomic(db, scope, async tx => {
    const organizationId = scope.organizationId;
    if (!await tx.property.findUnique({ where: { organizationId_id: { organizationId, id: input.propertyId } } })) throw missing();
    if (id) {
      const room = await tx.room.findUnique({ where: { organizationId_id: { organizationId, id } } });
      if (!room) throw missing();
      if (room.propertyId !== input.propertyId && await tx.lease.count({ where: { organizationId, roomId: id } })) {
        throw conflict('A room with lease history must stay with its original property');
      }
    }
    const room = id ? await tx.room.update({ where: { organizationId_id: { organizationId, id } }, data: input })
      : await tx.room.create({ data: { ...input, organizationId } });
    await audit(tx, scope, id ? 'room.updated' : 'room.created', room.id);
    return room;
  });
}

export function saveTenant(db: Database, scope: Scope, input: z.infer<typeof tenantInput>, id?: string) {
  return atomic(db, scope, async tx => {
    const organizationId = scope.organizationId;
    const whatsapp = normalizedPhone(input.whatsapp);
    const data = { ...input, phone: normalizedPhone(input.phone), whatsapp };
    if (!id) {
      const tenant = await tx.tenant.create({ data: { ...data, organizationId } });
      await audit(tx, scope, 'tenant.created', tenant.id);
      return tenant;
    }
    const previous = await tx.tenant.findUnique({ where: { organizationId_id: { organizationId, id } } });
    if (!previous) throw missing();
    const changed = whatsapp !== undefined && previous.whatsapp !== whatsapp;
    const tenant = await tx.tenant.update({ where: { organizationId_id: { organizationId, id } }, data: {
      ...data, ...(changed ? { consentAt: null, consentSource: null, optedOutAt: new Date() } : {}),
    } });
    await audit(tx, scope, 'tenant.updated', id, { consentCleared: changed });
    return tenant;
  });
}

export function changeConsent(db: Database, scope: Scope, id: string, input: z.infer<typeof consentInput>) {
  return atomic(db, scope, async tx => {
    const where = { organizationId_id: { organizationId: scope.organizationId, id } };
    const tenant = await tx.tenant.findUnique({ where });
    if (!tenant) throw missing();
    if (input.allowed && (!tenant.whatsapp || tenant.archivedAt)) throw conflict('An active tenant needs a valid WhatsApp number to opt in');
    const updated = await tx.tenant.update({ where, data: input.allowed
      ? { consentAt: new Date(), consentSource: input.source, optedOutAt: null }
      : { optedOutAt: new Date() } });
    await audit(tx, scope, input.allowed ? 'tenant.whatsapp_opt_in' : 'tenant.whatsapp_opt_out', id);
    return updated;
  });
}

export function archiveRental(db: Database, scope: Scope, kind: 'room' | 'tenant', id: string) {
  return atomic(db, scope, async tx => {
    const organizationId = scope.organizationId;
    const where = { organizationId_id: { organizationId, id } };
    const existing = kind === 'room' ? await tx.room.findUnique({ where }) : await tx.tenant.findUnique({ where });
    if (!existing) throw missing();
    if (existing.archivedAt) return existing;
    const leases = await tx.lease.count({ where: {
      organizationId, ...(kind === 'room' ? { roomId: id } : { tenantId: id }),
      OR: [{ endsOn: null }, { endsOn: { gt: calendarDate(businessDay()) } }],
    } });
    if (leases) throw conflict('End current and future leases before archiving');
    const archivedAt = new Date();
    const result = kind === 'room' ? await tx.room.update({ where, data: { archivedAt } })
      : await tx.tenant.update({ where, data: { archivedAt, optedOutAt: archivedAt } });
    await audit(tx, scope, `${kind}.archived`, id);
    return result;
  });
}

export async function generateCharges(tx: Tx, scope: Scope, period: Date, leaseId?: string) {
  const organizationId = scope.organizationId;
  const leases = await tx.lease.findMany({ where: {
    organizationId, id: leaseId, startsOn: { lt: shiftMonth(period, 1) }, OR: [{ endsOn: null }, { endsOn: { gt: period } }],
  }, include: { terms: { where: { period: { lte: period } }, orderBy: { period: 'desc' }, take: 1 } } });
  const data = leases.map(lease => {
    const term = lease.terms[0];
    if (!term) throw new Error('Lease is missing its opening terms');
    return { organizationId, leaseId: lease.id, period, dueOn: dueDate(period, lease.startsOn, term.dueDay), amountPaise: term.amountPaise };
  });
  const inserted = data.length ? await tx.rentCharge.createManyAndReturn({ data, skipDuplicates: true, select: { id: true } }) : [];
  if (inserted.length) await tx.auditLog.createMany({ data: inserted.map(({ id }) => ({ ...scope, action: 'charge.created', entityId: id })) });
  return { created: inserted.length };
}

export function generateMonth(db: Database, scope: Scope, month: string, leaseId?: string) {
  return atomic(db, scope, async tx => {
    const period = periodDate(month);
    if (period > shiftMonth(periodDate(businessMonth()), 12)) throw new DomainError(400, 'Generate charges at most 12 months ahead');
    if (leaseId && !await tx.lease.findFirst({ where: { organizationId: scope.organizationId, id: leaseId } })) throw missing();
    return generateCharges(tx, scope, period, leaseId);
  });
}

export function createLease(db: Database, scope: Scope, input: z.infer<typeof leaseInput>) {
  return atomic(db, scope, async tx => {
    const organizationId = scope.organizationId;
    const startsOn = calendarDate(input.startsOn);
    const endsOn = input.endsOn ? calendarDate(input.endsOn) : null;
    if (endsOn && endsOn <= startsOn) throw new DomainError(400, 'Move-out must be after move-in');
    const first = periodDate(input.startsOn.slice(0, 7));
    const current = periodDate(businessMonth());
    if (first < shiftMonth(current, -120) || first > shiftMonth(current, 12)) throw new DomainError(400, 'Move-in must be within 10 years back and 12 months ahead');
    const room = await tx.room.findFirst({ where: { id: input.roomId, organizationId, archivedAt: null } });
    const tenant = await tx.tenant.findFirst({ where: { id: input.tenantId, organizationId, archivedAt: null } });
    if (!room || !tenant) throw missing();
    if (await tx.lease.findFirst({ where: { organizationId, roomId: room.id, startsOn: endsOn ? { lt: endsOn } : undefined,
      OR: [{ endsOn: null }, { endsOn: { gt: startsOn } }],
    } })) throw conflict('This room already has a lease that overlaps those dates');
    const lease = await tx.lease.create({ data: { organizationId, roomId: room.id, tenantId: tenant.id, startsOn, endsOn,
      depositPaise: input.depositPaise, notes: input.notes,
      terms: { create: { period: first, amountPaise: input.amountPaise, dueDay: input.dueDay } },
    } });
    await audit(tx, scope, 'lease.created', lease.id);
    for (let period = first; period <= current && (!endsOn || period < endsOn); period = shiftMonth(period, 1)) {
      await generateCharges(tx, scope, period, lease.id);
    }
    return lease;
  });
}

export function changeTerms(db: Database, scope: Scope, id: string, input: z.infer<typeof termInput>) {
  return atomic(db, scope, async tx => {
    const organizationId = scope.organizationId;
    const lease = await tx.lease.findFirst({ where: { id, organizationId } });
    if (!lease) throw missing();
    const period = periodDate(input.month);
    if (period <= periodDate(businessMonth()) || shiftMonth(period, 1) <= lease.startsOn || (lease.endsOn && lease.endsOn <= period)) {
      throw conflict('Terms can change only for a future billing month within the lease');
    }
    if (await tx.rentCharge.findFirst({ where: { organizationId, leaseId: id, period: { gte: period } } })) {
      throw conflict('Charges already exist on or after this month');
    }
    const term = await tx.leaseTerm.create({ data: { organizationId, leaseId: id, period, amountPaise: input.amountPaise, dueDay: input.dueDay } });
    await audit(tx, scope, 'lease.terms_changed', id, { termId: term.id, reason: input.reason });
    return term;
  });
}

export function endLease(db: Database, scope: Scope, id: string, input: z.infer<typeof endInput>) {
  return atomic(db, scope, async tx => {
    const organizationId = scope.organizationId;
    const where = { organizationId_id: { organizationId, id } };
    const lease = await tx.lease.findUnique({ where });
    if (!lease) throw missing();
    const endsOn = calendarDate(input.endsOn);
    if (endsOn <= lease.startsOn || (lease.endsOn && endsOn > lease.endsOn)) throw conflict('The new move-out must shorten the lease and follow move-in');
    if (lease.endsOn?.getTime() === endsOn.getTime()) return lease;
    const outside = endsOn.getUTCDate() === 1 ? endsOn : shiftMonth(endsOn, 1);
    if (await tx.rentCharge.findFirst({ where: { organizationId, leaseId: id, period: { gte: outside }, voidedAt: null } })) {
      throw conflict('Void unused charges outside the new lease dates before ending it');
    }
    const updated = await tx.lease.update({ where, data: { endsOn } });
    await audit(tx, scope, 'lease.ended', id, { reason: input.reason, endsOn: input.endsOn });
    return updated;
  });
}
