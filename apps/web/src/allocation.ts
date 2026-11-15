import { rupeesToPaise } from '../../../packages/shared/src/ledger';

type OutstandingCharge = { id: string; month: string; outstandingPaise: number };

export function allocationSummary(amount: string, values: Record<string, string>, rows: OutstandingCharge[], allowCredit: boolean) {
  let amountPaise = 0;
  let allocatedPaise = 0;
  let selected = 0;
  let error = '';
  try {
    amountPaise = amount.trim() ? rupeesToPaise(amount.trim()) : 0;
    for (const row of rows) {
      const text = values[row.id]?.trim();
      if (!text) continue;
      const value = rupeesToPaise(text);
      allocatedPaise += value;
      if (value > 0) selected++;
      if (value > row.outstandingPaise) error = `${row.month} exceeds its outstanding rent.`;
    }
    if (!error && !amountPaise) error = 'Enter the amount received.';
    if (!error && selected > 24) error = 'Apply one payment to at most 24 rent charges.';
    if (!error && allocatedPaise > amountPaise) error = 'The rent allocations exceed the amount received.';
    if (!error && allocatedPaise < amountPaise && !allowCredit) error = 'Allocate the remaining money or choose advance credit.';
  } catch (cause) { error = cause instanceof Error ? cause.message : 'Check the entered amounts.'; }
  return { amountPaise, allocatedPaise, remainingPaise: amountPaise - allocatedPaise,
    creditPaise: allowCredit && !error ? amountPaise - allocatedPaise : 0, error };
}

export function allocateOldest(amount: string, rows: OutstandingCharge[]) {
  let remaining = rupeesToPaise(amount.trim());
  const values: Record<string, string> = {};
  for (const row of [...rows].filter(row => row.outstandingPaise > 0).sort((a, b) => a.month.localeCompare(b.month)).slice(0, 24)) {
    if (!remaining) break;
    const value = Math.min(remaining, row.outstandingPaise);
    values[row.id] = `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`;
    remaining -= value;
  }
  return values;
}
