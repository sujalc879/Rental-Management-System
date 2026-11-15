import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { auditCategories } from '../../../packages/shared/src/input';
import { auth, queryString, useRecords } from './api';
import type { AuditEvent } from './types';
import { Amount, Field, localInstant, Page, Pager, Panel, readable, Result, Table } from './ui';

function recordLink(event: AuditEvent) {
  const category = event.action.split('.')[0];
  if (category === 'payment') return `/payments/${event.entityId}`;
  if (category === 'lease') return `/leases?id=${event.entityId}`;
  const paths: Record<string, string> = { property: 'properties', room: 'rooms', tenant: 'tenants' };
  return paths[category] ? `/${paths[category]}?id=${event.entityId}` : null;
}

export function Activity() {
  const [params, setParams] = useSearchParams();
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [offset, setOffset] = useState(0);
  const session = auth.useSession();
  const history = useRecords<AuditEvent[]>(`audit${queryString({ category, q: search, from, to, entityId: params.get('entityId') || '', take: 30, offset })}`);
  const update = (setter: (value: string) => void, value: string) => { setter(value); setOffset(0); };
  return <Page title="Activity log" description="Review recorded changes to rent, payments, rental records and account security. Times are shown in IST." action={<button className="button secondary" onClick={() => { void history.refetch(); }}>Refresh activity</button>}>
    <Panel title="Filters"><div className="filters">
      <Field label="Activity category"><select value={category} onChange={event => update(setCategory, event.target.value)}><option value="">All activity</option>{auditCategories.map(value => <option key={value} value={value}>{readable(value)}</option>)}</select></Field>
      <Field label="Search activity"><input value={search} maxLength={120} onChange={event => update(setSearch, event.target.value)} /></Field>
      <Field label="From date (IST)"><input type="date" value={from} max={to || undefined} onChange={event => update(setFrom, event.target.value)} /></Field>
      <Field label="Through date (IST)"><input type="date" value={to} min={from || undefined} onChange={event => update(setTo, event.target.value)} /></Field>
    </div>{params.has('entityId') && <p>Showing activity for one record. <button className="text-button" onClick={() => { setParams({}); setOffset(0); }}>Show all records</button></p>}</Panel>
    <Panel title="Recorded activity"><Result busy={history.isPending} error={history.error} empty={!history.data?.length}>
      <Table headers={['When (IST)', 'Activity', 'Recorded by', 'Record and details']}>{history.data?.map(event => {
        const link = recordLink(event);
        return <tr key={event.id}><td>{localInstant(event.createdAt)}</td><td>{readable(event.action.replaceAll('.', ' '))}</td>
          <td>{event.actorId === session.data?.user.id ? 'You' : event.actorId ? 'Organization owner' : 'Automatic process'}</td>
          <td>{link && <Link to={link}>Open record</Link>}<details><summary>View details</summary><dl className="details"><dt>Record reference</dt><dd>{event.entityId}</dd>
            {Object.entries(event.details ?? {}).map(([key, value]) => <div className="audit-detail" key={key}><dt>{readable(key.replace(/([a-z])([A-Z])/g, '$1 $2'))}</dt><dd>{key === 'amountPaise' && typeof value === 'number' ? <Amount value={value} /> : String(value ?? '—')}</dd></div>)}
          </dl></details></td>
        </tr>;
      })}</Table>
    </Result><Pager count={history.data?.length ?? 0} offset={offset} onChange={setOffset} /></Panel>
  </Page>;
}
