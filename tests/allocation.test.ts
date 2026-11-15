import { expect, test } from 'vitest';
import { allocateOldest, allocationSummary } from '../apps/web/src/allocation';

const rows = [
  { id: 'newer', month: '2026-11', outstandingPaise: 80_000 },
  { id: 'older', month: '2026-10', outstandingPaise: 12_345 },
  { id: 'paid', month: '2026-09', outstandingPaise: 0 },
];

test('allocates exact fractional rupees to the oldest unpaid month and leaves an explicit advance remainder', () => {
  const values = allocateOldest('1000.01', rows);
  expect(values).toEqual({ older: '123.45', newer: '800.00' });
  expect(allocationSummary('1000.01', values, rows, false).error).toContain('advance credit');
  expect(allocationSummary('1000.01', values, rows, true)).toEqual({
    amountPaise: 100_001, allocatedPaise: 92_345, remainingPaise: 7656, creditPaise: 7656, error: '',
  });
  expect(allocateOldest('123.46', rows)).toEqual({ older: '123.45', newer: '0.01' });
  expect(allocationSummary('123.46', { older: '123.45', newer: '0.01' }, rows, false).error).toBe('');
});

test('rejects invalid precision, per-month overpayment, excess allocations and implicit credit', () => {
  for (const value of ['0', '-1', '1.005', '1e3', '10000000.01']) {
    expect(allocationSummary(value, {}, rows, true).error).not.toBe('');
  }
  expect(allocationSummary('200', { older: '200' }, rows, true).error).toContain('outstanding rent');
  expect(allocationSummary('10', { older: '10.01' }, rows, true).error).toContain('exceed');
  expect(allocationSummary('10.01', { older: '10' }, rows, false).error).toContain('remaining money');
  expect(allocationSummary('10', { older: '1.005' }, rows, false).error).toContain('two decimal places');
});

test('limits automatic allocations to 24 charges and requires an explicit remainder decision', () => {
  const many = Array.from({ length: 25 }, (_, index) => ({ id: String(index), month: String(index).padStart(2, '0'), outstandingPaise: 100 }));
  const values = allocateOldest('25', many);
  expect(Object.keys(values)).toHaveLength(24);
  expect(allocationSummary('25', values, many, true)).toMatchObject({ allocatedPaise: 2400, creditPaise: 100, error: '' });
  expect(allocationSummary('25', { ...values, '24': '1' }, many, true).error).toContain('24 rent charges');
});
