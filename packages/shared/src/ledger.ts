export const businessTimeZone = 'Asia/Kolkata';
export const maxPaise = 1_000_000_000;
const ist = new Intl.DateTimeFormat('en-CA', { timeZone: businessTimeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
const currency = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });

export const isoDay = (date: Date) => date.toISOString().slice(0, 10);
export const businessDay = (date = new Date()) => ist.format(date);
export const calendarDate = (day: string) => new Date(`${day}T00:00:00.000Z`);
export const periodDate = (month: string) => calendarDate(`${month}-01`);
export const businessMonth = (date = new Date()) => businessDay(date).slice(0, 7);
export const monthKey = (date: Date) => isoDay(date).slice(0, 7);
export const dateInputToUtc = (value: string) => new Date(`${value}+05:30`).toISOString();

export function shiftMonth(date: Date, months: number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

export function dueDate(period: Date, startsOn: Date, dueDay: number) {
  const last = new Date(shiftMonth(period, 1).getTime() - 86_400_000).getUTCDate();
  const due = new Date(Date.UTC(period.getUTCFullYear(), period.getUTCMonth(), Math.min(last, dueDay)));
  return due < startsOn ? startsOn : due;
}

export function chargeState(amount: number, allocated: number, dueOn: Date, voidedAt: Date | null, today = businessDay()) {
  const outstandingPaise = voidedAt ? 0 : amount - allocated;
  const overdue = outstandingPaise > 0 && isoDay(dueOn) < today;
  const status = voidedAt ? 'VOID' : outstandingPaise === 0 ? 'PAID' : allocated > 0 ? 'PARTIAL' : overdue ? 'OVERDUE' : 'UNPAID';
  return { outstandingPaise, overdue, status } as const;
}

export function rupeesToPaise(input: string) {
  if (!/^\d{1,8}(?:\.\d{1,2})?$/.test(input)) throw new Error('Enter rupees with up to two decimal places');
  const [whole, fraction = ''] = input.split('.');
  const value = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (value > maxPaise) throw new Error('Amount exceeds the supported limit');
  return value;
}

export function inr(value: string | number | bigint) {
  const amount = BigInt(value);
  const sign = amount < 0n ? '−' : '';
  const absolute = amount < 0n ? -amount : amount;
  return `${sign}${currency.format(absolute / 100n).replace(/\.00$/, `.${String(absolute % 100n).padStart(2, '0')}`)}`;
}
