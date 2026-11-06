import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { KeyRound } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { auth, useRecords, useWrite } from './api';
import type { Notice } from './types';
import { ActionForm, Badge, Field, getText, localInstant, messageOf, Page, Pager, Panel, Result, Table } from './ui';

function checked<T>(response: { data: T | null; error: { message?: string } | null }) {
  if (response.error) throw new Error(response.error.message || 'Account request failed');
  return response.data;
}

const credentials = z.object({ email: z.email(), password: z.string().min(1, 'Enter your password') });
function SignInForm({ onSuccess }: { onSuccess: (needsFactor: boolean) => void }) {
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm({ resolver: zodResolver(credentials) });
  return <form onSubmit={handleSubmit(async input => {
    try {
      const result = await auth.signIn.email(input);
      if (result.error) throw new Error('Sign-in failed. Check your credentials and email verification.');
      onSuccess(Boolean(result.data && 'twoFactorRedirect' in result.data && result.data.twoFactorRedirect));
    } catch (error) { setError('root', { message: messageOf(error) }); }
  })}><fieldset disabled={isSubmitting} className="form-grid">
    <Field label="Email"><input type="email" {...register('email')} autoComplete="username" required /></Field>
    <Field label="Password"><input type="password" {...register('password')} autoComplete="current-password" required /></Field>
    <div className="form-end"><button className="button" type="submit">{isSubmitting ? 'Signing in…' : 'Sign in'}</button>
      {(errors.root || errors.email || errors.password) && <p role="alert" className="error">{errors.root?.message || errors.email?.message || errors.password?.message}</p>}
    </div>
  </fieldset></form>;
}

export function AuthPage({ mode }: { mode: 'sign-in' | 'recover' | 'verify' | 'reset' }) {
  const [factor, setFactor] = useState(false);
  const [backup, setBackup] = useState(false);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const email = (form: FormData) => getText(form, 'email');
  const password = (form: FormData) => String(form.get('password') ?? '');
  const title = { 'sign-in': 'Sign in to RentLedger', recover: 'Recover access', verify: 'Verify your email', reset: 'Choose a new password' }[mode];
  return <div className="auth-screen"><div className="auth-side"><div className="brand-mark"><KeyRound size={23} /></div><strong>RentLedger</strong><h1>Rental records in one place.</h1><p>Keep track of rooms, rent, collections and receipts across your properties.</p></div>
    <main className="auth-main"><Panel title={factor ? 'Two-step verification' : title}>
      {factor ? <><ActionForm label="Verify and sign in" onSubmit={async form => {
        const code = getText(form, 'code');
        if (backup) checked(await auth.twoFactor.verifyBackupCode({ code }));
        else checked(await auth.twoFactor.verifyTotp({ code }));
        window.location.assign('/');
      }}><Field label={backup ? 'Backup code' : 'Authenticator code'}><input required autoComplete="one-time-code" name="code" /></Field></ActionForm>
        <button className="text-button" onClick={() => setBackup(!backup)}>{backup ? 'Use authenticator code' : 'Use a backup code'}</button></> : <>
        {mode === 'sign-in' && <><p>Use the email address associated with your owner account.</p><SignInForm onSuccess={factor => { if (factor) setFactor(true); else window.location.assign('/'); }} />
          <div className="actions"><Link to="/recover">Forgot password</Link><Link to="/verify">Verify email</Link></div></>}
        {mode === 'recover' && <ActionForm label="Send password link" success="If the address is eligible, a password link will arrive by email." onSubmit={async form => {
          await auth.requestPasswordReset({ email: email(form), redirectTo: `${location.origin}/reset` });
        }}><Field label="Email"><input type="email" name="email" autoComplete="email" required /></Field></ActionForm>}
        {mode === 'verify' && <><p>{params.get('error') ? 'That verification link could not be used. Request a fresh link.' : 'Request a fresh verification link or return to sign in after verifying.'}</p>
          <ActionForm label="Send verification link" success="If the address is eligible, a verification link will arrive by email." onSubmit={async form => {
            await auth.sendVerificationEmail({ email: email(form), callbackURL: `${location.origin}/sign-in` });
          }}><Field label="Email"><input type="email" name="email" autoComplete="email" required /></Field></ActionForm></>}
        {mode === 'reset' && (params.get('token') ? <ActionForm label="Set password" onSubmit={async form => {
          checked(await auth.resetPassword({ newPassword: password(form), token: params.get('token')! })); navigate('/sign-in');
        }}><Field label="New password"><input type="password" name="password" autoComplete="new-password" minLength={12} required /></Field></ActionForm> : <p>Request a fresh password link to continue.</p>)}
        {mode !== 'sign-in' && <div className="actions"><Link to="/sign-in">Back to sign in</Link></div>}
      </>}
    </Panel></main>
  </div>;
}

export function Settings() {
  const organization = useRecords<{ name: string; whatsappEnabled: boolean }>('settings');
  const backup = useRecords<{ status: string; lastSuccessAt?: string }>('backup-health');
  const session = auth.useSession();
  const write = useWrite();
  const [mfa, setMfa] = useState<{ totpURI: string; backupCodes: string[] } | null>(null);
  const [showCodes, setShowCodes] = useState<string[]>([]);
  return <Page title="Settings" description="Manage your organization, account security and backup status.">
    <div className="split"><Panel title="Organization"><Result busy={organization.isPending} error={organization.error}>{organization.data && <ActionForm label="Save organization" onSubmit={form => write('settings', { name: getText(form, 'name'), whatsappEnabled: form.has('whatsappEnabled') }, 'PATCH')}>
      <Field label="Organization name"><input name="name" defaultValue={organization.data.name} required maxLength={120} /></Field><label className="check"><input type="checkbox" name="whatsappEnabled" defaultChecked={organization.data.whatsappEnabled} /> Queue receipts when an approved sender is available</label>
    </ActionForm>}</Result></Panel><Panel title="Independent backups"><Result busy={backup.isPending} error={backup.error}>{backup.data && <><Badge value={backup.data.status} /><p>{backup.data.lastSuccessAt ? `Last verified backup ${localInstant(backup.data.lastSuccessAt)} IST` : 'No verified off-site backup is available to report.'}</p></>}</Result></Panel></div>
    <div className="split"><Panel title="Account and password"><p>{session.data?.user.email}</p><ActionForm label="Change password" onSubmit={async form => {
      checked(await auth.changePassword({ currentPassword: String(form.get('current') ?? ''), newPassword: String(form.get('next') ?? ''), revokeOtherSessions: true }));
    }}><Field label="Current password"><input name="current" type="password" autoComplete="current-password" required /></Field><Field label="New password"><input name="next" type="password" autoComplete="new-password" required minLength={12} /></Field></ActionForm>
      <ActionForm label="Sign out other sessions" secondary onSubmit={async () => { checked(await auth.revokeOtherSessions()); }} />
    </Panel><Panel title="Two-step verification">
      {mfa ? <><p>Add a time-based account to your authenticator using this setup key.</p><code className="break-all">{new URL(mfa.totpURI).searchParams.get('secret')}</code>
        <ActionForm label="Confirm setup" onSubmit={async form => { checked(await auth.twoFactor.verifyTotp({ code: getText(form, 'code') })); setShowCodes(mfa.backupCodes); setMfa(null); await session.refetch(); }}><Field label="Authenticator code"><input name="code" required autoComplete="one-time-code" /></Field></ActionForm></>
        : <ActionForm label={session.data?.user.twoFactorEnabled ? 'Disable two-step verification' : 'Set up authenticator'} onSubmit={async form => {
          const password = String(form.get('password') ?? '');
          if (session.data?.user.twoFactorEnabled) { checked(await auth.twoFactor.disable({ password })); setShowCodes([]); await session.refetch(); }
          else { const result = checked(await auth.twoFactor.enable({ password })); if (result?.method === 'totp') setMfa(result); }
        }}><Field label="Password for security change"><input name="password" type="password" autoComplete="current-password" required /></Field></ActionForm>}
      {!!showCodes.length && <div><p>Store these one-time recovery codes somewhere private.</p><ul>{showCodes.map(code => <li key={code}><code>{code}</code></li>)}</ul><button className="button secondary" onClick={() => setShowCodes([])}>Hide recovery codes</button></div>}
    </Panel></div>
  </Page>;
}

export function Notifications() {
  const [offset, setOffset] = useState(0);
  const history = useRecords<Notice[]>(`notifications?take=30&offset=${offset}`);
  const write = useWrite();
  return <Page title="WhatsApp receipts" description="Track queue, provider acceptance and delivery separately from the payment ledger.">
    <Panel title="Receipt history"><Result busy={history.isPending} error={history.error} empty={!history.data?.length}><Table headers={['Payment', 'Created (IST)', 'Status', 'Details', 'Actions']}>{history.data?.map(row => <tr key={row.id}>
      <td><Link to={`/payments/${row.paymentId}`}>Open payment</Link></td><td>{localInstant(row.createdAt)}</td><td><Badge value={row.status} /></td><td>{row.reason?.toLowerCase().replaceAll('_', ' ') || '—'}</td>
      <td>{row.status === 'FAILED' && row.retryable && row.manualRetries < 2 && <ActionForm label="Retry" secondary onSubmit={() => write(`notifications/${row.id}/retry`)} />}</td>
    </tr>)}</Table></Result><Pager count={history.data?.length ?? 0} offset={offset} onChange={setOffset} /></Panel>
  </Page>;
}
