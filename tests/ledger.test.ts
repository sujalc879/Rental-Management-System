import { describe, expect, test } from 'vitest';
import { businessDay, calendarDate, chargeState, dateInputToUtc, dueDate, inr, periodDate, rupeesToPaise } from '../packages/shared/src/ledger';
import { day, paymentInput } from '../packages/shared/src/input';
import { csv } from '../apps/api/src/reports';

describe('billing policy and boundaries', () => {
  test('uses the IST date at the UTC day boundary', () => {
    expect(businessDay(new Date('2026-01-31T18:29:59.999Z'))).toBe('2026-01-31');
    expect(businessDay(new Date('2026-01-31T18:30:00.000Z'))).toBe('2026-02-01');
    expect(dateInputToUtc('2026-02-01T00:00')).toBe('2026-01-31T18:30:00.000Z');
  });
  test('clamps month end and honors move-in', () => {
    expect(dueDate(periodDate('2024-02'), calendarDate('2024-02-01'), 31)).toEqual(calendarDate('2024-02-29'));
    expect(dueDate(periodDate('2026-02'), calendarDate('2026-02-21'), 5)).toEqual(calendarDate('2026-02-21'));
    expect(day.safeParse('2026-02-29').success).toBe(false);
  });
  test('keeps partial and overdue semantics distinct', () => {
    const due = calendarDate('2026-02-05');
    expect(chargeState(800_000, 0, due, null, '2026-02-05').status).toBe('UNPAID');
    expect(chargeState(800_000, 0, due, null, '2026-02-06').status).toBe('OVERDUE');
    expect(chargeState(800_000, 200_000, due, null, '2026-02-06')).toEqual({ status: 'PARTIAL', overdue: true, outstandingPaise: 600_000 });
  });
  test('preserves paise and leading zeros and checks overpayments', () => {
    expect(rupeesToPaise('8000.09')).toBe(800_009);
    expect(inr('90071992547409939')).toBe('₹90,07,19,92,54,74,099.39');
    expect(() => rupeesToPaise('0.001')).toThrow();
    const payload = { key: crypto.randomUUID(), leaseId: crypto.randomUUID(), amountPaise: 123, paidAt: '2026-02-05T01:00:00Z', mode: 'ONLINE', reference: ' 000123 ', allocations: [], allowCredit: true };
    expect(paymentInput.parse(payload).reference).toBe('000123');
    expect(paymentInput.safeParse({ ...payload, reference: '' }).success).toBe(false);
    expect(paymentInput.safeParse({ ...payload, allowCredit: false }).success).toBe(false);
  });
  test('escapes CSV formula injection and quoted values', () => {
    expect(csv([[' =1+1', 'a"b']])).toBe('"\' =1+1","a""b"\r\n');
  });
});
