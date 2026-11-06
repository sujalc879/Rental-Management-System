import { useRef, useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { businessMonth, dateInputToUtc, inr, rupeesToPaise } from '../../../packages/shared/src/ledger';
import { paymentInput } from '../../../packages/shared/src/input';
import { ApiError, orgPath, queryString, useOrg, useRecords, useWrite } from './api';
import type { Charge, Lease, Payment, PaymentDetails, Property, Room, Summary, Tenant } from './types';
import { ActionForm, Amount, Badge, Field, getText, localInstant, messageOf, money, optionalText, Page, Pager, Panel, Result, Table } from './ui';

function PaymentRows({ rows }: { rows: Payment[] }) {
  return <Table headers={['Tenant and room', 'Received (IST)', 'Method', 'Amount', 'Receipt status']}>{rows.map(row => <tr key={row.id}>
    <td><Link to={`/payments/${row.id}`}>{row.lease.tenant.name}</Link><small>{row.lease.room.property.name} · {row.lease.room.name}</small></td>
    <td>{localInstant(row.paidAt)}</td><td><Badge value={row.mode} /></td><td><Amount value={row.amountPaise} /></td><td><Badge value={row.reversal ? 'REVERSED' : row.notification?.status ?? 'UNCONFIGURED'} /></td>
  </tr>)}</Table>;
}

function LedgerRows({ rows, controls }: { rows: Charge[]; controls?: boolean }) {
  const write = useWrite();
  return <Table headers={['Billing month', 'Room and tenant', 'Due date', 'Expected', 'Applied', 'Outstanding', 'Status', ...(controls ? ['Actions'] : [])]}>{rows.map(row => <tr key={row.id}>
    <td>{row.month}</td><td>{row.room}<small>{row.property} · {row.tenant}</small></td><td>{row.dueOn}</td><td><Amount value={row.amountPaise} /></td><td><Amount value={row.allocatedPaise} /></td><td><Amount value={row.outstandingPaise} /></td>
    <td><Badge value={row.status} />{row.overdue && row.status === 'PARTIAL' && <small>Overdue balance</small>}</td>
    {controls && <td>{row.outstandingPaise > 0 && <Link to={`/payments/new?leaseId=${row.leaseId}`}>Record</Link>}
      {row.status !== 'VOID' && !row.allocatedPaise && <details><summary>Void charge</summary><ActionForm label="Confirm void" secondary onSubmit={form => write(`ledger/${row.id}/void`, { reason: getText(form, 'reason') })}><Field label="Reason"><input name="reason" required minLength={3} maxLength={300} /></Field></ActionForm></details>}
    </td>}
  </tr>)}</Table>;
}

export function Dashboard() {
  const [month, setMonth] = useState(businessMonth());
  const dashboard = useRecords<Summary>(`dashboard?month=${month || businessMonth()}`);
  const data = dashboard.data;
  return <Page title="Dashboard" description="Review rent, collections and occupancy across your properties." action={<Link className="button" to="/payments/new">Record payment</Link>}>
    <div className="filters standalone"><Field label="Reporting month"><input type="month" value={month} onChange={event => setMonth(event.target.value)} /></Field></div>
    <Result busy={dashboard.isPending} error={dashboard.error}>{data && <>
      <div className="metrics">
        {[['Expected rent', data.expected], ['Rent applied', data.applied], ['Money received', data.received], ['Outstanding rent', data.outstanding], ['Overdue rent', data.overdue]].map(([label, amount]) => <div key={label} className="metric"><span>{label}</span><strong>{inr(amount)}</strong></div>)}
        <div className="metric"><span>Occupancy</span><strong>{data.occupied} / {data.rooms}</strong><small>{data.vacant} vacant · {data.activeTenants} active tenants</small></div>
      </div>
      <div className="split"><Panel title="Rent applied by billing month">
        {!data.trend.length && <p className="empty">No billing months yet.</p>}
        {data.trend.map(row => <div key={row.month} className="trend"><span>{row.month}</span><meter min={0} max={Math.max(1, Number(row.expected))} value={Number(row.applied)} aria-label={`${row.month} rent applied`} /><small>{inr(row.applied)} / {inr(row.expected)}</small></div>)}
      </Panel><Panel title="Collections and receipts">
        {data.cashModes.length ? data.cashModes.map(row => <p key={row.mode}><Badge value={row.mode} /> <Amount value={row.amount} /></p>) : <p>No payments received for this month.</p>}
        {data.notices.map(row => <p key={row.status}><Badge value={row.status} /> {row._count._all}</p>)}
        <Link to="/notifications">View WhatsApp history</Link>
      </Panel></div>
      <Panel title="Upcoming dues"><Result busy={false} empty={!data.upcoming.length}><LedgerRows rows={data.upcoming} /></Result></Panel>
      <Panel title="Recent payments"><Result busy={false} empty={!data.recentPayments.length}><PaymentRows rows={data.recentPayments} /></Result></Panel>
      <Panel title="Rent by room"><Result busy={false} empty={!data.byRoom.length}><Table headers={['Property', 'Room', 'Expected', 'Outstanding']}>{data.byRoom.map(row => <tr key={row.roomId}><td>{row.property}</td><td><Link to={`/rooms?id=${row.roomId}`}>{row.room}</Link></td><td><Amount value={row.amount} /></td><td><Amount value={row.outstanding} /></td></tr>)}</Table></Result></Panel>
    </>}</Result>
  </Page>;
}

export function Reports({ view }: { view: 'ledger' | 'payments' | 'reports' }) {
  const org = useOrg();
  const [params] = useSearchParams();
  const [month, setMonth] = useState(view === 'ledger' && !params.get('leaseId') ? businessMonth() : '');
  const [year, setYear] = useState(view === 'reports' ? businessMonth().slice(0, 4) : '');
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [roomId, setRoomId] = useState(params.get('roomId') ?? '');
  const [propertyId, setPropertyId] = useState(params.get('propertyId') ?? '');
  const [tenantId, setTenantId] = useState(params.get('tenantId') ?? '');
  const [status, setStatus] = useState('');
  const [mode, setMode] = useState('');
  const [paymentStatus, setPaymentStatus] = useState('');
  const leaseId = params.get('leaseId') ?? '';
  const filters = { month, year: month ? undefined : year, leaseId, roomId, propertyId, tenantId, q: search };
  const ledgerFilter = queryString({ ...filters, status, take: 30, offset });
  const paymentFilter = queryString({ ...filters, mode, paymentStatus, take: 30, offset });
  const charges = useRecords<Charge[]>(`ledger${ledgerFilter}`, view !== 'payments');
  const history = useRecords<Payment[]>(`payments${paymentFilter}`, view !== 'ledger');
  const report = useRecords<Summary>(`dashboard${queryString({ ...filters, status, mode, paymentStatus })}`, view === 'reports');
  const rooms = useRecords<Room[]>('rooms?take=200');
  const properties = useRecords<Property[]>('properties?take=200');
  const tenants = useRecords<Tenant[]>('tenants?take=200');
  const write = useWrite();
  const update = (setter: (value: string) => void, value: string) => { setter(value); setOffset(0); };
  const options = (records?: { id: string; name: string }[]) => records?.map(row => <option key={row.id} value={row.id}>{row.name}</option>);
  const heading = view === 'ledger' ? 'Rent ledger' : view === 'payments' ? 'Payment history' : 'Reports and exports';
  return <Page title={heading} description="Billing month follows the rent charge. Money received follows the actual payment date in IST." action={<Link className="button" to="/payments/new">Record payment</Link>}>
    <Panel title="Filters"><div className="filters">
      <Field label="Billing or collection month"><input type="month" value={month} onChange={event => update(setMonth, event.target.value)} /></Field>
      <Field label="Year (when month is empty)"><input type="number" min={1900} max={2199} value={year} disabled={!!month} onChange={event => update(setYear, event.target.value)} /></Field>
      <Field label="Property"><select value={propertyId} onChange={event => update(setPropertyId, event.target.value)}><option value="">All properties</option>{options(properties.data)}</select></Field>
      <Field label="Room"><select value={roomId} onChange={event => update(setRoomId, event.target.value)}><option value="">All rooms</option>{options(rooms.data)}</select></Field>
      <Field label="Tenant"><select value={tenantId} onChange={event => update(setTenantId, event.target.value)}><option value="">All tenants</option>{options(tenants.data)}</select></Field>
      <Field label="Search"><input value={search} onChange={event => update(setSearch, event.target.value)} /></Field>
      {view !== 'payments' && <Field label="Rent status"><select value={status} onChange={event => update(setStatus, event.target.value)}><option value="">All statuses</option>{['PAID', 'PARTIAL', 'UNPAID', 'OVERDUE', 'VOID'].map(value => <option key={value}>{value}</option>)}</select></Field>}
      {view !== 'ledger' && <Field label="Payment mode"><select value={mode} onChange={event => update(setMode, event.target.value)}><option value="">Both modes</option><option value="CASH">Cash</option><option value="ONLINE">Online</option></select></Field>}
      {view !== 'ledger' && <Field label="Payment status"><select value={paymentStatus} onChange={event => update(setPaymentStatus, event.target.value)}><option value="">All payments</option><option value="RECORDED">Recorded</option><option value="REVERSED">Reversed</option></select></Field>}
    </div><div className="actions">
      {view !== 'payments' && <a className="button secondary" href={orgPath(org, `exports/ledger${queryString({ ...filters, status })}`)}>Download ledger CSV</a>}
      {view !== 'ledger' && <a className="button secondary" href={orgPath(org, `exports/payments${queryString({ ...filters, mode, paymentStatus })}`)}>Download payments CSV</a>}
    </div></Panel>
    {view === 'reports' && <Result busy={report.isPending} error={report.error}>{report.data && <Panel title="Period totals"><div className="metrics">
      {[['Money received', report.data.received], ['Rent expected', report.data.expected], ['Rent applied', report.data.applied], ['Outstanding', report.data.outstanding], ['Overdue', report.data.overdue], ...report.data.cashModes.map(row => [`${row.mode === 'CASH' ? 'Cash' : 'Online'} received`, row.amount])].map(([label, amount]) => <div className="metric" key={label}><span>{label}</span><strong>{inr(amount)}</strong></div>)}
    </div></Panel>}</Result>}
    {view === 'ledger' && <Panel title="Generate charges"><ActionForm label="Generate rent charges" secondary onSubmit={form => write('ledger/generate', { month: getText(form, 'month'), leaseId: leaseId || undefined })} success="Month processed. Existing charges were kept.">
      <Field label="Month to generate"><input type="month" name="month" defaultValue={month || businessMonth()} required /></Field>
    </ActionForm></Panel>}
    {view !== 'payments' && <Panel title="Rent charges"><Result busy={charges.isPending} error={charges.error} empty={!charges.data?.length}><LedgerRows rows={charges.data ?? []} controls={view === 'ledger'} /></Result></Panel>}
    {view !== 'ledger' && <Panel title="Payments received"><Result busy={history.isPending} error={history.error} empty={!history.data?.length}><PaymentRows rows={history.data ?? []} /></Result></Panel>}
    <Pager offset={offset} count={Math.max(charges.data?.length ?? 0, history.data?.length ?? 0)} onChange={setOffset} />
  </Page>;
}

function AllocationFields({ rows }: { rows: Charge[] }) {
  return <div className="allocations">{rows.filter(row => row.outstandingPaise > 0).map(row => <div key={row.id}>
    <Field label={`${row.month} · ${inr(row.outstandingPaise)} remaining of ${inr(row.amountPaise)}`}><input name={`charge:${row.id}`} inputMode="decimal" placeholder="₹ 0.00" /></Field>
    <small>Due {row.dueOn} · {inr(row.allocatedPaise)} already applied</small>
  </div>)}</div>;
}
function allocations(form: FormData) {
  return [...form].flatMap(([key, value]) => key.startsWith('charge:') && String(value).trim() && rupeesToPaise(String(value).trim()) > 0
    ? [{ chargeId: key.slice(7), amountPaise: rupeesToPaise(String(value).trim()) }] : []);
}
function istInput() { return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 16); }

export function NewPayment() {
  const [params] = useSearchParams();
  const [leaseId, setLease] = useState(params.get('leaseId') || '');
  const [mode, setMode] = useState<'CASH' | 'ONLINE'>('CASH');
  const [leaseSearch, setLeaseSearch] = useState('');
  const [state, setState] = useState({ error: '', busy: false, duplicate: false });
  const [done, setDone] = useState<{ id: string; status?: string } | null>(null);
  const key = useRef(crypto.randomUUID());
  const submitting = useRef(false);
  const leases = useRecords<Lease[]>(`leases${queryString({ take: 200, q: leaseSearch })}`);
  const selected = useRecords<Lease>(`leases/${leaseId}`, !!leaseId);
  const charges = useRecords<Charge[]>(`ledger?leaseId=${leaseId}&take=200`, !!leaseId);
  const write = useWrite();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const form = new FormData(event.currentTarget);
    submitting.current = true;
    setState(value => ({ ...value, busy: true, error: '' }));
    try {
      const input = paymentInput.safeParse({ key: key.current, leaseId, amountPaise: money(form, 'amount'), paidAt: dateInputToUtc(getText(form, 'paidAt')),
        mode, reference: mode === 'ONLINE' ? optionalText(form, 'reference') : null, notes: optionalText(form, 'notes'),
        allocations: allocations(form), allowCredit: form.has('allowCredit'), acknowledgeReference: form.has('acknowledgeReference'),
      });
      if (!input.success) throw new Error(input.error.issues[0].message);
      if (!window.confirm(`Record ${inr(input.data.amountPaise)} received by ${mode === 'CASH' ? 'cash' : 'online transfer'}?`)) return;
      const result = await write<{ payment: { id: string; notification: { status: string } | null } }>('payments', input.data);
      setDone({ id: result.payment.id, status: result.payment.notification?.status });
    } catch (error) { setState({ busy: true, error: messageOf(error), duplicate: error instanceof ApiError && error.code === 'DUPLICATE_REFERENCE' }); }
    finally { submitting.current = false; setState(value => ({ ...value, busy: false })); }
  }
  return <Page title="Record payment" description="Record the money received and choose how to apply it to rent.">
    {done ? <Panel title="Payment recorded"><p role="status">The payment is saved in the ledger.</p><p>WhatsApp receipt <Badge value={done.status ?? 'UNCONFIGURED'} /></p><div className="actions"><Link className="button" to={`/payments/${done.id}`}>Open receipt</Link><button className="button secondary" onClick={() => { key.current = crypto.randomUUID(); setState({ error: '', busy: false, duplicate: false }); setDone(null); }}>Record another payment</button></div></Panel> :
      <Panel title="Payment details"><form onSubmit={submit}><fieldset disabled={state.busy} className="form-grid">
        <Field label="Find tenant"><input value={leaseSearch} onChange={event => setLeaseSearch(event.target.value)} /></Field>
        <Field label="Tenant and lease"><select required value={leaseId} onChange={event => setLease(event.target.value)}><option value="">Choose tenant and room</option>
          {selected.data && !leases.data?.some(row => row.id === selected.data?.id) && <option value={selected.data.id}>{selected.data.tenant.name} · {selected.data.room.name}</option>}
          {leases.data?.map(row => <option value={row.id} key={row.id}>{row.tenant.name} · {row.room.name} · {row.startsOn.slice(0, 10)}</option>)}</select></Field>
        <Field label="Amount received (₹)"><input required name="amount" inputMode="decimal" /></Field>
        <Field label="Actual payment date and time (IST)"><input required name="paidAt" type="datetime-local" defaultValue={istInput()} /></Field>
        <Field label="Payment mode"><select value={mode} onChange={event => setMode(event.target.value === 'ONLINE' ? 'ONLINE' : 'CASH')}><option value="CASH">Cash</option><option value="ONLINE">Online</option></select></Field>
        {mode === 'ONLINE' && <Field label="Online transaction reference"><input required name="reference" maxLength={100} /></Field>}
        <Field label="Payment notes"><textarea name="notes" maxLength={2000} /></Field>
        <div className="form-end"><h3>Apply to rent months</h3><Result busy={!!leaseId && charges.isPending} error={charges.error} empty={!!leaseId && !charges.data?.some(row => row.outstandingPaise > 0)}><AllocationFields key={leaseId} rows={charges.data ?? []} /></Result>
          {leaseId && <Link to={`/ledger?leaseId=${leaseId}`}>Open lease ledger to generate more months</Link>}</div>
        <label className="check"><input type="checkbox" name="allowCredit" /> Keep any unallocated amount as advance credit for this lease</label>
        {state.duplicate && <label className="check"><input type="checkbox" name="acknowledgeReference" required /> I verified the repeated reference and want to record a separate payment</label>}
        <div className="form-end"><button className="button" type="submit" disabled={!leaseId}>{state.busy ? 'Recording…' : 'Confirm payment'}</button>{state.error && <p className="error" role="alert">{state.error}</p>}</div>
      </fieldset></form></Panel>}
  </Page>;
}

export function ReceiptPage() {
  const { id } = useParams();
  const record = useRecords<PaymentDetails>(`payments/${id}`);
  const value = record.data;
  const charges = useRecords<Charge[]>(`ledger?leaseId=${value?.leaseId}&take=200`, !!value?.creditPaise);
  const write = useWrite();
  const key = useRef(crypto.randomUUID());
  return <Page title="Payment receipt" description="Original payment details and subsequent ledger adjustments." action={<button className="button secondary print-hidden" onClick={() => window.print()}>Print receipt</button>}>
    <Result busy={record.isPending} error={record.error}>{value && <>
      <Panel title={value.notification?.snapshot.owner ?? 'Rent receipt'}>
        <p>{value.notification?.snapshot.property} · Room {value.notification?.snapshot.room}</p><p>{value.notification?.snapshot.tenant}</p>
        <dl className="details"><dt>Amount received</dt><dd><Amount value={value.amountPaise} /></dd><dt>Received at (IST)</dt><dd>{localInstant(value.paidAt)}</dd><dt>Method</dt><dd><Badge value={value.mode} /></dd>
          {value.reference && <><dt>Online reference</dt><dd>{value.reference}</dd></>}<dt>Verification</dt><dd>Manually recorded</dd><dt>Receipt delivery</dt><dd><Badge value={value.notification?.status ?? 'UNCONFIGURED'} /></dd><dt>Payment ID</dt><dd>{value.id}</dd>
          <dt>Advance credit available</dt><dd><Amount value={value.creditPaise} /></dd></dl>
        {value.notes && <p>{value.notes}</p>}{value.reversal && <p className="error">Reversed {localInstant(value.reversal.createdAt)} IST · {value.reversal.reason}</p>}
        <Table headers={['Billing month', 'Allocation']}>{value.allocations.map(row => <tr key={row.id}><td>{row.charge.period.slice(0, 7)}</td><td><Amount value={row.amountPaise} /></td></tr>)}</Table>
      </Panel>
      {!value.reversal && <div className="split print-hidden">
        {value.creditPaise > 0 && <Panel title="Apply advance credit"><ActionForm label="Apply credit" onSubmit={async form => {
          await write(`payments/${id}/credit`, { key: key.current, allocations: allocations(form) }); key.current = crypto.randomUUID();
        }}><Result busy={charges.isPending} error={charges.error} empty={!charges.data?.some(row => row.outstandingPaise > 0)}><AllocationFields rows={charges.data ?? []} /></Result></ActionForm></Panel>}
        <Panel title="Correct this payment"><p>A reversal removes the payment from balances and collections. The original receipt stays in history.</p><ActionForm label="Confirm reversal" secondary onSubmit={form => write(`payments/${id}/reverse`, { reason: getText(form, 'reason') })}><Field label="Reversal reason"><input name="reason" minLength={3} maxLength={300} required /></Field></ActionForm></Panel>
      </div>}
    </>}</Result>
  </Page>;
}
