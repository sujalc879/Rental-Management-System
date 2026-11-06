import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { businessDay } from '../../../packages/shared/src/ledger';
import { queryString, useRecords, useWrite } from './api';
import type { Lease, Property, Room, Tenant } from './types';
import { ActionForm, Amount, Badge, Field, getText, money, optionalText, Page, Pager, Panel, Result, Table, toRupees } from './ui';

export function Rentals({ kind }: { kind: 'properties' | 'rooms' | 'tenants' }) {
  const [params, setParams] = useSearchParams();
  const selected = params.get('id') || '';
  const [search, setSearch] = useState('');
  const [occupancy, setOccupancy] = useState('');
  const [propertySearch, setPropertySearch] = useState('');
  const [offset, setOffset] = useState(0);
  const properties = useRecords<Property[]>('properties' + queryString({ take: 200, q: propertySearch }), kind === 'rooms');
  const list = useRecords<(Property | Room | Tenant)[]>(kind + queryString({ q: search, take: 30, offset, ...(kind === 'rooms' ? { occupancy } : {}) }));
  const detail = useRecords<Property | Room | Tenant>(`${kind}/${selected}`, Boolean(selected));
  const current = selected ? detail.data : undefined;
  const room = kind === 'rooms' ? current as Room | undefined : undefined;
  const property = kind === 'properties' ? current as Property | undefined : undefined;
  const tenant = kind === 'tenants' ? current as Tenant | undefined : undefined;
  const write = useWrite();
  const title = { properties: 'Properties', rooms: 'Rooms', tenants: 'Tenants' }[kind];
  const singular = { properties: 'property', rooms: 'room', tenants: 'tenant' }[kind];
  const choose = (id: string) => setParams(id ? { id } : {});
  async function save(form: FormData) {
    const common = { name: getText(form, 'name'), notes: optionalText(form, 'notes') };
    const input = kind === 'properties' ? { ...common, address: optionalText(form, 'address') }
      : kind === 'rooms' ? { ...common, propertyId: getText(form, 'propertyId'), suggestedPaise: money(form, 'rent'), suggestedDay: Number(getText(form, 'dueDay')) || null }
      : { ...common, phone: optionalText(form, 'phone'), whatsapp: optionalText(form, 'whatsapp'), email: optionalText(form, 'email') };
    const saved = await write<{ id: string }>(selected ? `${kind}/${selected}` : kind, input, selected ? 'PATCH' : 'POST');
    choose(saved.id);
  }
  return <Page title={title} description={`Manage your ${title.toLowerCase()} and look up rental history.`} action={selected && <button className="button" onClick={() => choose('')}>Add {singular}</button>}>
    <div className="split">
      <Panel title={title}>
        <div className="filters"><Field label={`Search ${title.toLowerCase()}`}><input value={search} onChange={event => { setSearch(event.target.value); setOffset(0); }} /></Field>
          {kind === 'rooms' && <Field label="Occupancy"><select value={occupancy} onChange={event => { setOccupancy(event.target.value); setOffset(0); }}><option value="">All rooms</option><option value="occupied">Occupied</option><option value="vacant">Vacant</option><option value="archived">Archived</option></select></Field>}</div>
        <Result busy={list.isPending} error={list.error} empty={!list.data?.length}><ul className="record-list">{list.data?.map(row => <li key={row.id}>
          <button type="button" className={row.id === selected ? 'selected' : ''} onClick={() => choose(row.id)}><strong>{row.name}</strong>
            {'property' in row && <small>{row.property.name} · {row.archivedAt ? 'Archived' : row.leases[0]?.tenant.name ?? 'Vacant'}
              {row.leases[0]?.terms[0] && <> · <Amount value={row.leases[0].terms[0].amountPaise} /> per month</>}</small>}
            {'phone' in row && <small>{row.archivedAt ? 'Archived' : row.phone || row.email || 'Tenant'}</small>}
            {'address' in row && row.address && <small>{row.address}</small>}
          </button></li>)}</ul></Result>
        <Pager count={list.data?.length ?? 0} offset={offset} onChange={setOffset} />
      </Panel>
      <div className="stack">
        <Panel title={current ? `Edit ${singular}` : `Add ${singular}`}>
          <Result busy={Boolean(selected && detail.isPending)} error={selected ? detail.error : null}>
            <ActionForm key={selected} label={selected ? 'Save changes' : `Create ${singular}`} onSubmit={save}>
              <Field label={kind === 'rooms' ? 'Room name or number' : 'Name'}><input name="name" maxLength={120} required defaultValue={current?.name} /></Field>
              {kind === 'properties' && <Field label="Address"><input name="address" maxLength={400} defaultValue={property?.address ?? ''} /></Field>}
              {kind === 'rooms' && <><Field label="Find a property"><input value={propertySearch} onChange={event => setPropertySearch(event.target.value)} /></Field>
                <Field label="Property"><select name="propertyId" required defaultValue={room?.propertyId ?? ''}><option value="">Choose a property</option>{room && !properties.data?.some(item => item.id === room.propertyId) && <option value={room.propertyId}>{room.property.name}</option>}{properties.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
                <Field label="Suggested rent (₹)"><input name="rent" inputMode="decimal" defaultValue={toRupees(room?.suggestedPaise ?? null)} /></Field>
                <Field label="Suggested due day"><input type="number" name="dueDay" min={1} max={31} defaultValue={room?.suggestedDay ?? ''} /></Field></>}
              {kind === 'tenants' && <><Field label="Phone"><input type="tel" name="phone" defaultValue={tenant?.phone ?? ''} /></Field>
                <Field label="WhatsApp number"><input type="tel" name="whatsapp" defaultValue={tenant?.whatsapp ?? ''} /></Field>
                <Field label="Email"><input type="email" name="email" defaultValue={tenant?.email ?? ''} /></Field></>}
              <Field label="Notes"><textarea name="notes" maxLength={2000} defaultValue={current?.notes ?? ''} /></Field>
            </ActionForm>
          </Result>
        </Panel>
        {current && <Panel title="History and actions">
          <div className="actions"><Link to={`/leases?${singular}Id=${current.id}`}>Lease history</Link><Link to={`/reports?${singular}Id=${current.id}`}>Ledger and payments</Link></div>
          {((room && !room.archivedAt) || (tenant && !tenant.archivedAt)) && <ActionForm key={current.id} label={`Archive ${singular}`} secondary onSubmit={async () => {
            if (window.confirm(`Archive this ${singular}? Its rental history will be kept.`)) await write(`${kind}/${current.id}/archive`);
          }} success="Archive request finished." />}
        </Panel>}
        {tenant && !tenant.archivedAt && <Panel title="WhatsApp consent"><p>{tenant.consentAt && !tenant.optedOutAt ? `Opted in · ${tenant.consentSource}` : 'Consent is not active.'}</p>
          <ActionForm key={tenant.id} label="Save consent" onSubmit={form => write(`tenants/${tenant.id}/consent`, { allowed: getText(form, 'allowed') === 'yes', source: getText(form, 'source') })}>
            <Field label="Permission"><select name="allowed"><option value="no">Record opt-out</option><option value="yes">Record explicit opt-in</option></select></Field>
            <Field label="Consent source or opt-out reason"><input name="source" minLength={3} maxLength={300} required /></Field>
          </ActionForm>
        </Panel>}
      </div>
    </div>
  </Page>;
}

export function Leases() {
  const [params, setParams] = useSearchParams();
  const [offset, setOffset] = useState(0);
  const [roomId, setRoomId] = useState('');
  const [roomSearch, setRoomSearch] = useState('');
  const [tenantSearch, setTenantSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const id = params.get('id');
  const filters = { roomId: params.get('roomId') || undefined, tenantId: params.get('tenantId') || undefined, propertyId: params.get('propertyId') || undefined };
  const list = useRecords<Lease[]>('leases' + queryString({ ...filters, take: 30, offset }));
  const selected = useRecords<Lease>(`leases/${id}`, !!id);
  const rooms = useRecords<Room[]>('rooms' + queryString({ take: 200, q: roomSearch }), showForm);
  const tenants = useRecords<Tenant[]>('tenants' + queryString({ take: 200, q: tenantSearch }), showForm);
  const room = rooms.data?.find(item => item.id === roomId);
  const write = useWrite();
  const pick = (leaseId: string) => setParams({ ...Object.fromEntries(params), id: leaseId });
  return <Page title="Leases" description="Track occupancy dates, agreed rent and changes to terms." action={<button className="button" onClick={() => setShowForm(!showForm)}>{showForm ? 'Close form' : 'New lease'}</button>}>
    {showForm && <Panel title="New lease"><ActionForm label="Create lease" onSubmit={async form => {
      const lease = await write<{ id: string }>('leases', { roomId, tenantId: getText(form, 'tenantId'), startsOn: getText(form, 'startsOn'), endsOn: optionalText(form, 'endsOn'), amountPaise: money(form, 'rent'), dueDay: Number(getText(form, 'dueDay')), depositPaise: money(form, 'deposit'), notes: optionalText(form, 'notes') });
      pick(lease.id); setShowForm(false);
    }}>
      <Field label="Find a room"><input value={roomSearch} onChange={event => { setRoomSearch(event.target.value); setRoomId(''); }} /></Field><Field label="Find a tenant"><input value={tenantSearch} onChange={event => setTenantSearch(event.target.value)} /></Field>
      <Field label="Room"><select required value={roomId} onChange={event => setRoomId(event.target.value)}><option value="">Choose a room</option>{rooms.data?.filter(row => !row.archivedAt).map(row => <option key={row.id} value={row.id}>{row.property.name} · {row.name}</option>)}</select></Field>
      <Field label="Tenant"><select name="tenantId" required><option value="">Choose a tenant</option>{tenants.data?.filter(row => !row.archivedAt).map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></Field>
      <Field label="Move-in date"><input name="startsOn" type="date" required defaultValue={businessDay()} /></Field><Field label="Move-out date (exclusive)"><input name="endsOn" type="date" /></Field>
      <Field label="Monthly rent (₹)"><input name="rent" key={`${roomId}-rent`} inputMode="decimal" required defaultValue={toRupees(room?.suggestedPaise ?? null)} /></Field>
      <Field label="Due day"><input name="dueDay" key={`${roomId}-day`} type="number" min={1} max={31} required defaultValue={room?.suggestedDay ?? 5} /></Field>
      <Field label="Security deposit (₹)"><input name="deposit" inputMode="decimal" /></Field><Field label="Notes"><textarea name="notes" maxLength={2000} /></Field>
    </ActionForm></Panel>}
    <Panel title="Lease history"><Result busy={list.isPending} error={list.error} empty={!list.data?.length}><Table headers={['Room', 'Tenant', 'Move-in', 'Move-out', 'Status']}>
      {list.data?.map(row => <tr key={row.id}><td><button className="text-button" onClick={() => pick(row.id)}>{row.room.name}</button></td><td>{row.tenant.name}</td><td>{row.startsOn.slice(0, 10)}</td><td>{row.endsOn?.slice(0, 10) || 'Open'}</td><td><Badge value={row.startsOn.slice(0, 10) > businessDay() ? 'SCHEDULED' : row.endsOn && row.endsOn.slice(0, 10) <= businessDay() ? 'ENDED' : 'ACTIVE'} /></td></tr>)}
    </Table></Result><Pager count={list.data?.length ?? 0} offset={offset} onChange={setOffset} /></Panel>
    {id && <Result busy={selected.isPending} error={selected.error}>{selected.data && <div className="split">
      <Panel title={`${selected.data.room.name} · ${selected.data.tenant.name}`}><p>Security deposit {selected.data.depositPaise === null ? '—' : <Amount value={selected.data.depositPaise} />}</p>
        <Table headers={['Effective month', 'Monthly rent', 'Due day']}>{selected.data.terms.map(term => <tr key={term.id}><td>{term.period.slice(0, 7)}</td><td><Amount value={term.amountPaise} /></td><td>{term.dueDay}</td></tr>)}</Table>
        <div className="actions"><Link to={`/ledger?leaseId=${id}`}>Lease ledger</Link><Link to={`/payments/new?leaseId=${id}`}>Record payment</Link></div>
      </Panel>
      <div className="stack"><Panel title="Change future terms"><ActionForm key={`${id}-terms`} label="Schedule rent terms" onSubmit={form => write(`leases/${id}/terms`, { month: getText(form, 'month'), amountPaise: money(form, 'rent'), dueDay: Number(getText(form, 'dueDay')), reason: getText(form, 'reason') })}>
        <Field label="Effective month"><input type="month" name="month" required /></Field><Field label="Monthly rent (₹)"><input name="rent" inputMode="decimal" required /></Field><Field label="Due day"><input type="number" min={1} max={31} name="dueDay" required /></Field><Field label="Reason"><input name="reason" minLength={3} maxLength={300} required /></Field>
      </ActionForm></Panel><Panel title="End lease"><ActionForm key={`${id}-end`} label="End lease" secondary onSubmit={form => write(`leases/${id}/end`, { endsOn: getText(form, 'endsOn'), reason: getText(form, 'reason') })}>
        <Field label="Move-out date"><input type="date" name="endsOn" required /></Field><Field label="Reason"><input name="reason" minLength={3} maxLength={300} required /></Field>
      </ActionForm></Panel></div>
    </div>}</Result>}
  </Page>;
}
