import { z } from 'zod';
import { calendarDate, isoDay, maxPaise } from './ledger';

export const id = z.uuid();
export const day = z.string().regex(/^(19\d\d|20\d\d|21\d\d)-\d{2}-\d{2}$/).refine(value => {
  const date = calendarDate(value);
  return Number.isFinite(date.getTime()) && isoDay(date) === value;
}, 'Use a valid date');
export const month = z.string().regex(/^(19\d\d|20\d\d|21\d\d)-(0[1-9]|1[0-2])$/);
export const name = z.string().trim().min(1).max(120);
export const reason = z.string().trim().min(3).max(300);
const notes = z.string().trim().max(2000).nullable().optional();
const dueDay = z.number().int().min(1).max(31);
const paise = z.number().int().min(1).max(maxPaise);
const phone = z.string().trim().min(5).max(35).nullable().optional();

export const propertyInput = z.strictObject({ name, address: z.string().trim().max(400).nullable().optional(), notes });
export const roomInput = z.strictObject({ propertyId: id, name, notes, suggestedPaise: paise.nullable().optional(), suggestedDay: dueDay.nullable().optional() });
export const tenantInput = z.strictObject({ name, phone, whatsapp: phone, email: z.email().max(254).nullable().optional(), notes });
export const consentInput = z.strictObject({ allowed: z.boolean(), source: reason });
export const leaseInput = z.strictObject({ roomId: id, tenantId: id, startsOn: day, endsOn: day.nullable().optional(), amountPaise: paise,
  dueDay, depositPaise: z.number().int().min(0).max(maxPaise).nullable().optional(), notes });
export const termInput = z.strictObject({ month, amountPaise: paise, dueDay, reason });
export const endInput = z.strictObject({ endsOn: day, reason });
export const generateInput = z.strictObject({ month, leaseId: id.optional() });
const allocation = z.strictObject({ chargeId: id, amountPaise: paise });
const allocations = z.array(allocation).max(24).refine(values => new Set(values.map(value => value.chargeId)).size === values.length, 'Select each charge once');
export const creditInput = z.strictObject({ key: id, allocations: allocations.refine(values => values.length > 0) });
export const paymentInput = z.strictObject({
  key: id, leaseId: id, amountPaise: paise, paidAt: z.iso.datetime({ offset: true }), mode: z.enum(['CASH', 'ONLINE']),
  reference: z.string().trim().min(1).max(100).regex(/^[^\p{Cc}]+$/u).nullable().optional(), notes,
  allocations, allowCredit: z.boolean().default(false), acknowledgeReference: z.boolean().default(false),
}).superRefine((value, ctx) => {
  if ((value.mode === 'ONLINE') !== Boolean(value.reference)) ctx.addIssue({ code: 'custom', path: ['reference'], message: 'An online payment requires a reference and a cash payment must omit it' });
  const allocated = value.allocations.reduce((total, row) => total + row.amountPaise, 0);
  if (allocated > value.amountPaise || (!value.allowCredit && allocated !== value.amountPaise)) {
    ctx.addIssue({ code: 'custom', path: ['allocations'], message: 'Allocate the full payment or explicitly keep the remainder as advance credit' });
  }
});

export const pageInput = z.strictObject({
  take: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  q: z.string().trim().max(120).optional(),
});
export const reportInput = pageInput.extend({
  month: month.optional(), year: z.string().regex(/^(19\d\d|20\d\d|21\d\d)$/).optional(),
  roomId: id.optional(), propertyId: id.optional(), tenantId: id.optional(), leaseId: id.optional(),
  mode: z.enum(['CASH', 'ONLINE']).optional(),
  paymentStatus: z.enum(['RECORDED', 'REVERSED']).optional(),
  status: z.enum(['UNPAID', 'PARTIAL', 'OVERDUE', 'PAID', 'VOID']).optional(),
});
