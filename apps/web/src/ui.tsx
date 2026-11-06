import { useState, type FormEvent, type ReactNode } from 'react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { businessTimeZone, inr, rupeesToPaise } from '../../../packages/shared/src/ledger';

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
export const getText = (data: FormData, key: string) => String(data.get(key) ?? '').trim();
export const optionalText = (data: FormData, key: string) => getText(data, key) || null;
export const money = (data: FormData, key: string) => getText(data, key) ? rupeesToPaise(getText(data, key)) : null;
export const toRupees = (value: number | null) => value === null ? '' : `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`;
export const localInstant = (value: string) => new Intl.DateTimeFormat('en-IN', { timeZone: businessTimeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
export const messageOf = (error: unknown) => error instanceof Error ? error.message : 'The request failed. Try again.';
export const readable = (label: string) => label === 'SIMULATED' ? 'Local simulation' : label.toLowerCase().replaceAll('_', ' ').replace(/^./, c => c.toUpperCase());

export function Badge({ value }: { value: string }) { return <span className={cn('badge', `badge-${value.toLowerCase()}`)}>{readable(value)}</span>; }
export function Page({ title, description, action, children }: { title: string; description: string; action?: ReactNode; children: ReactNode }) {
  return <><header className="page-heading"><div><h1>{title}</h1><p>{description}</p></div>{action}</header>{children}</>;
}
export function Panel({ title, children }: { title?: string; children: ReactNode }) {
  return <section className="panel">{title && <h2>{title}</h2>}{children}</section>;
}
export function Result({ busy, error, empty, children }: { busy: boolean; error?: Error | null; empty?: boolean; children: ReactNode }) {
  if (busy) return <div className="loading" role="status">Loading records…</div>;
  if (error) return <p className="error" role="alert">{error.message}</p>;
  if (empty) return <p className="empty">No records match this view.</p>;
  return <>{children}</>;
}
export function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="field"><span>{label}</span>{children}</label>; }
export function Table({ headers, children }: { headers: string[]; children: ReactNode }) {
  return <div className="table-scroll" tabIndex={0} role="region" aria-label={headers.join(', ')}><table><thead><tr>{headers.map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead><tbody>{children}</tbody></table></div>;
}
export function Pager({ offset, count, onChange }: { offset: number; count: number; onChange: (offset: number) => void }) {
  return <div className="actions pager"><button className="button secondary" disabled={!offset} onClick={() => onChange(Math.max(0, offset - 30))}>Previous</button><span>{offset + (count ? 1 : 0)}–{offset + count}</span><button className="button secondary" disabled={count < 30} onClick={() => onChange(offset + 30)}>Next</button></div>;
}
export function ActionForm({ children, label, onSubmit, secondary, success = 'Saved.' }: { children?: ReactNode; label: string; onSubmit: (form: FormData) => Promise<unknown>; secondary?: boolean; success?: string }) {
  const [state, setState] = useState({ busy: false, error: '', message: '' });
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.busy) return;
    const data = new FormData(event.currentTarget);
    setState({ busy: true, error: '', message: '' });
    try { await onSubmit(data); setState({ busy: false, error: '', message: success }); }
    catch (error) { setState({ busy: false, error: messageOf(error), message: '' }); }
  }
  return <form onSubmit={submit}><fieldset disabled={state.busy} className="form-grid">{children}<div className="form-end">
    <button className={cn('button', secondary && 'secondary')} type="submit">{state.busy ? 'Saving…' : label}</button>
    {state.error && <p className="error" role="alert">{state.error}</p>}{state.message && <p className="success" role="status">{state.message}</p>}
  </div></fieldset></form>;
}
export function Amount({ value }: { value: string | number }) { return <span className="amount">{inr(value)}</span>; }
