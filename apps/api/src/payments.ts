import type { z } from 'zod';
import type { Database } from '../../../packages/db/src/index';
import type { creditInput, paymentInput } from '../../../packages/shared/src/input';
import { monthKey } from '../../../packages/shared/src/ledger';
import { atomic, audit, conflict, DomainError, hash, missing, type Scope, type Tx } from './domain';
import { senderFor, type Receipt } from './receipt';
import type { Config } from './config';

type Parts = { chargeId: string; amountPaise: number }[];
const total = (parts: { amountPaise: number }[]) => parts.reduce((sum, row) => sum + row.amountPaise, 0);
const sorted = (parts: Parts) => [...parts].sort((a, b) => a.chargeId.localeCompare(b.chargeId));

async function checkAllocations(tx: Tx, scope: Scope, leaseId: string, allocations: Parts) {
  if (!allocations.length) return [];
  const charges = await tx.rentCharge.findMany({ where: { organizationId: scope.organizationId, leaseId,
    id: { in: allocations.map(part => part.chargeId) }, voidedAt: null },
  include: { allocations: { where: { payment: { reversal: null } }, select: { amountPaise: true } } } });
  if (charges.length !== allocations.length) throw missing();
  const byId = new Map(charges.map(charge => [charge.id, charge]));
  return allocations.map(part => {
    const charge = byId.get(part.chargeId)!;
    if (part.amountPaise > charge.amountPaise - total(charge.allocations)) throw conflict('An allocation exceeds the remaining rent for its month');
    return { period: monthKey(charge.period), amountPaise: part.amountPaise };
  }).sort((a, b) => a.period.localeCompare(b.period));
}

const paymentResult = { notification: { select: { id: true, status: true, reason: true } } } as const;

export function recordPayment(db: Database, config: Config, scope: Scope, input: z.infer<typeof paymentInput>) {
  return atomic(db, scope, async tx => {
    const organizationId = scope.organizationId;
    const paidAt = new Date(input.paidAt);
    const reference = input.reference ?? null;
    const notes = input.notes || null;
    const requestHash = hash(JSON.stringify([input.leaseId, input.amountPaise, paidAt.toISOString(), input.mode, reference,
      notes, sorted(input.allocations), input.allowCredit]));
    const existing = await tx.payment.findUnique({ where: { organizationId_key: { organizationId, key: input.key } }, include: paymentResult });
    if (existing) {
      if (existing.requestHash !== requestHash) throw conflict('This submission key was already used for different payment details', 'IDEMPOTENCY_CONFLICT');
      return { payment: existing, replay: true };
    }
    if (paidAt.getTime() > Date.now() + 60_000) throw new DomainError(400, 'Actual payment time cannot be in the future');
    const lease = await tx.lease.findFirst({ where: { organizationId, id: input.leaseId }, include: { tenant: true, room: { include: { property: true } } } });
    if (!lease) throw missing();
    const referenceMatches = reference ? await tx.payment.count({ where: { organizationId, leaseId: lease.id, reference, reversal: null } }) : 0;
    if (referenceMatches && !input.acknowledgeReference) throw conflict('This online reference already exists for the lease. Verify it before recording another payment.', 'DUPLICATE_REFERENCE');
    const months = await checkAllocations(tx, scope, lease.id, input.allocations);
    const organization = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, include: { sender: true } });
    const tenant = lease.tenant;
    const hasConsent = Boolean(tenant.whatsapp && tenant.consentAt && !tenant.optedOutAt && !tenant.archivedAt);
    const configured = organization.whatsappEnabled && (config.WHATSAPP_MODE === 'mock' || senderFor(config, organization.sender, input.mode));
    const status = !configured ? 'UNCONFIGURED' : hasConsent ? 'PENDING' : 'NO_CONSENT';
    const snapshot: Receipt = { version: 1, tenant: tenant.name, owner: organization.name, property: lease.room.property.name,
      room: lease.room.name, whatsapp: hasConsent ? tenant.whatsapp : null, consentAt: hasConsent ? tenant.consentAt!.toISOString() : null,
      mode: input.mode, reference, amountPaise: input.amountPaise, paidAt: paidAt.toISOString(), months, creditPaise: input.amountPaise - total(input.allocations) };
    const payment = await tx.payment.create({ data: { organizationId, leaseId: lease.id, recordedBy: scope.actorId!,
      amountPaise: input.amountPaise, paidAt, mode: input.mode, reference, notes, key: input.key, requestHash,
      notification: { create: { snapshot, status } },
    }, include: paymentResult });
    if (input.allocations.length) await tx.allocation.createMany({ data: input.allocations.map(part => ({ ...part, organizationId, leaseId: lease.id, paymentId: payment.id })) });
    await audit(tx, scope, 'payment.recorded', payment.id, { amountPaise: payment.amountPaise, mode: payment.mode, referenceAcknowledged: referenceMatches > 0 });
    return { payment, replay: false };
  });
}

export function applyCredit(db: Database, scope: Scope, id: string, input: z.infer<typeof creditInput>) {
  return atomic(db, scope, async tx => {
    const organizationId = scope.organizationId;
    const payment = await tx.payment.findFirst({ where: { organizationId, id }, include: { reversal: true, allocations: { select: { amountPaise: true } } } });
    if (!payment) throw missing();
    const requestHash = hash(JSON.stringify(sorted(input.allocations)));
    const previous = await tx.creditApplication.findUnique({ where: { organizationId_paymentId_key: { organizationId, paymentId: id, key: input.key } } });
    if (previous) {
      if (previous.requestHash !== requestHash) throw conflict('This submission key was already used for different allocations');
      return { appliedPaise: total(input.allocations), replay: true };
    }
    const appliedPaise = total(input.allocations);
    if (payment.reversal || appliedPaise > payment.amountPaise - total(payment.allocations)) throw conflict('This payment does not have enough available advance credit');
    await checkAllocations(tx, scope, payment.leaseId, input.allocations);
    await tx.allocation.createMany({ data: input.allocations.map(part => ({ ...part, organizationId, leaseId: payment.leaseId, paymentId: id })) });
    await tx.creditApplication.create({ data: { organizationId, paymentId: id, key: input.key, requestHash } });
    await audit(tx, scope, 'payment.credit_applied', id, { amountPaise: appliedPaise });
    return { appliedPaise, replay: false };
  });
}

export function reversePayment(db: Database, scope: Scope, id: string, reason: string) {
  return atomic(db, scope, async tx => {
    const organizationId = scope.organizationId;
    const payment = await tx.payment.findFirst({ where: { organizationId, id }, include: { reversal: true } });
    if (!payment) throw missing();
    if (payment.reversal) return payment.reversal;
    const reversal = await tx.paymentReversal.create({ data: { organizationId, paymentId: id, actorId: scope.actorId!, reason } });
    await tx.notificationOutbox.updateMany({ where: { organizationId, paymentId: id, status: { in: ['PENDING', 'FAILED', 'UNCONFIGURED', 'NO_CONSENT'] }, providerId: null },
      data: { status: 'CANCELLED', reason: 'PAYMENT_REVERSED', retryable: false } });
    await audit(tx, scope, 'payment.reversed', id, { reversalId: reversal.id });
    return reversal;
  });
}

export function voidCharge(db: Database, scope: Scope, id: string, reason: string) {
  return atomic(db, scope, async tx => {
    const where = { id, organizationId: scope.organizationId };
    const charge = await tx.rentCharge.findFirst({ where, include: { allocations: { where: { payment: { reversal: null } }, take: 1 } } });
    if (!charge) throw missing();
    if (charge.voidedAt) return charge;
    if (charge.allocations.length) throw conflict('Reverse linked payments before voiding this charge');
    const result = await tx.rentCharge.update({ where, data: { voidedAt: new Date(), voidReason: reason } });
    await audit(tx, scope, 'charge.voided', id);
    return result;
  });
}
