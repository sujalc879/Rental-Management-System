import { lazy, StrictMode, Suspense, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { Building2, ClipboardList, DoorOpen, FileSpreadsheet, KeyRound, LayoutDashboard, LogOut, Menu, MessageCircle, ReceiptText, Settings2, Users, Wallet, X } from 'lucide-react';
import { api, auth, Organization } from './api';
import { Field, Result } from './ui';
import './style.css';

const AuthPage = lazy(() => import('./account').then(module => ({ default: module.AuthPage })));
const Notifications = lazy(() => import('./account').then(module => ({ default: module.Notifications })));
const Settings = lazy(() => import('./account').then(module => ({ default: module.Settings })));
const Dashboard = lazy(() => import('./financial-pages').then(module => ({ default: module.Dashboard })));
const NewPayment = lazy(() => import('./financial-pages').then(module => ({ default: module.NewPayment })));
const ReceiptPage = lazy(() => import('./financial-pages').then(module => ({ default: module.ReceiptPage })));
const Reports = lazy(() => import('./financial-pages').then(module => ({ default: module.Reports })));
const Leases = lazy(() => import('./rental-pages').then(module => ({ default: module.Leases })));
const Rentals = lazy(() => import('./rental-pages').then(module => ({ default: module.Rentals })));

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: true } } });
const links = [
  ['/', 'Dashboard', LayoutDashboard], ['/properties', 'Properties', Building2], ['/rooms', 'Rooms', DoorOpen], ['/tenants', 'Tenants', Users],
  ['/leases', 'Leases', ClipboardList], ['/ledger', 'Rent ledger', ReceiptText], ['/payments', 'Payments', Wallet], ['/notifications', 'WhatsApp', MessageCircle],
  ['/reports', 'Reports', FileSpreadsheet], ['/settings', 'Settings', Settings2],
] as const;

function OwnerApp() {
  const session = auth.useSession();
  const cache = useQueryClient();
  const location = useLocation();
  const [selected, setSelected] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [logoutError, setLogoutError] = useState(false);
  const organizations = useQuery({ queryKey: ['memberships', session.data?.user.id], enabled: Boolean(session.data?.user.emailVerified), retry: false,
    queryFn: () => api<{ organization: { id: string; name: string } }[]>('/api/organizations'),
  });
  if (session.isPending) return <div className="loading" role="status">Checking your session…</div>;
  if (session.error) return <main className="loading" role="alert">Session check failed. Refresh to retry.</main>;
  if (!session.data?.user.emailVerified) return <Navigate to="/sign-in" replace />;
  const org = organizations.data?.find(row => row.organization.id === selected)?.organization ?? organizations.data?.[0]?.organization;
  async function logout() {
    setLogoutError(false);
    const result = await auth.signOut().catch(() => null);
    if (result?.error || !result) { setLogoutError(true); return; }
    cache.clear();
    window.location.assign('/sign-in');
  }
  return <div className="shell"><a href="#main" className="skip">Skip to content</a>
    <header className="mobile-bar"><Link to="/"><KeyRound size={20} /> RentLedger</Link><button type="button" className="icon-button" aria-label={expanded ? 'Close navigation' : 'Open navigation'} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? <X /> : <Menu />}</button></header>
    <aside className={expanded ? 'sidebar open' : 'sidebar'}><Link className="brand" to="/" onClick={() => setExpanded(false)}><span className="brand-mark"><KeyRound size={20} /></span><span>RentLedger<small>Owner workspace</small></span></Link>
      {org && <Field label="Organization"><select value={org.id} onChange={event => { setSelected(event.target.value); setExpanded(false); }}>
        {organizations.data?.map(({ organization }) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}</select></Field>}
      <nav aria-label="Owner navigation">{links.map(([path, name, Icon]) => <NavLink key={path} to={path} end={path === '/'} onClick={() => setExpanded(false)}><Icon size={19} aria-hidden="true" />{name}</NavLink>)}</nav>
      <div className="sidebar-bottom"><span>{session.data.user.name}</span><button type="button" onClick={logout}><LogOut size={16} /> Sign out</button>{logoutError && <p role="alert">Sign-out failed. Try again.</p>}</div>
    </aside>
    <main className="content" id="main"><Result busy={organizations.isPending} error={organizations.error}>{org ? <Organization.Provider key={org.id} value={org.id}><Suspense fallback={<div className="loading" role="status">Loading page…</div>}><Routes>
      <Route index element={<Dashboard />} /><Route path="properties" element={<Rentals key="properties" kind="properties" />} /><Route path="rooms" element={<Rentals key="rooms" kind="rooms" />} />
      <Route path="tenants" element={<Rentals key="tenants" kind="tenants" />} /><Route path="leases" element={<Leases key={location.search.replace(/([?&])id=[^&]*/, '$1')} />} />
      <Route path="ledger" element={<Reports key={`ledger${location.search}`} view="ledger" />} /><Route path="payments" element={<Reports key="payments" view="payments" />} />
      <Route path="payments/new" element={<NewPayment key={location.search} />} /><Route path="payments/:id" element={<ReceiptPage />} /><Route path="notifications" element={<Notifications />} />
      <Route path="reports" element={<Reports key={`reports${location.search}`} view="reports" />} /><Route path="settings" element={<Settings />} /><Route path="*" element={<p>Page not found. <Link to="/">Return to dashboard</Link></p>} />
    </Routes></Suspense></Organization.Provider> : <p className="empty">No owner organization is assigned to your account.</p>}</Result></main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><QueryClientProvider client={queryClient}><BrowserRouter><Suspense fallback={<div className="loading" role="status">Loading page…</div>}><Routes>
  <Route path="sign-in" element={<AuthPage key="sign-in" mode="sign-in" />} /><Route path="recover" element={<AuthPage key="recover" mode="recover" />} />
  <Route path="verify" element={<AuthPage key="verify" mode="verify" />} /><Route path="reset" element={<AuthPage key="reset" mode="reset" />} />
  <Route path="*" element={<OwnerApp />} />
</Routes></Suspense></BrowserRouter></QueryClientProvider></StrictMode>);
