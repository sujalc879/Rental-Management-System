import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { twoFactor } from 'better-auth/plugins';
import nodemailer from 'nodemailer';
import type { Database } from '../../../packages/db/src/index';
import type { Config } from './config';

export function createAuth(db: Database, config: Config) {
  const production = config.NODE_ENV === 'production';
  const smtpUrl = config.SMTP_URL && config.MAIL_FROM ? new URL(config.SMTP_URL) : undefined;
  const smtp = smtpUrl && nodemailer.createTransport({ host: smtpUrl.hostname, port: Number(smtpUrl.port) || (smtpUrl.protocol === 'smtps:' ? 465 : 587),
    secure: smtpUrl.protocol === 'smtps:', requireTLS: true, socketTimeout: 15_000,
    auth: smtpUrl.username ? { user: decodeURIComponent(smtpUrl.username), pass: decodeURIComponent(smtpUrl.password) } : undefined,
  });

  async function send(to: string, subject: string, url: string) {
    if (smtp) {
      await smtp.sendMail({ to, from: config.MAIL_FROM, subject, text: `${subject}\n\n${url}\n` });
      return;
    }
    if (production) throw new Error('Mail provider unavailable');
    await mkdir(config.DEV_MAIL_DIR, { recursive: true, mode: 0o700 });
    await writeFile(join(config.DEV_MAIL_DIR, `${Date.now()}-${crypto.randomUUID()}.json`),
      JSON.stringify({ adapter: 'LOCAL DEVELOPMENT MAIL', to, subject, url }), { mode: 0o600, flag: 'wx' });
  }

  async function accountAudit(userId: string, action: string) {
    try {
      const memberships = await db.membership.findMany({ where: { userId, role: 'OWNER' }, select: { organizationId: true } });
      if (memberships.length) await db.auditLog.createMany({ data: memberships.map(({ organizationId }) => ({ organizationId, actorId: userId, action, entityId: userId })) });
    } catch { console.error(JSON.stringify({ event: 'account.audit_write_failed', action })); }
  }

  return betterAuth({
    appName: 'RentLedger',
    baseURL: config.APP_ORIGIN,
    secret: config.BETTER_AUTH_SECRET,
    database: prismaAdapter(db, { provider: 'postgresql', transaction: true }),
    trustedOrigins: [config.APP_ORIGIN],
    advanced: {
      database: { generateId: 'uuid' },
      useSecureCookies: production,
      defaultCookieAttributes: { sameSite: 'lax', httpOnly: true, secure: production },
      ipAddress: { ipAddressHeaders: config.TRUSTED_PROXY_IP_HEADER ? [config.TRUSTED_PROXY_IP_HEADER] : ['x-rental-client-ip'] },
    },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 80, customRules: {
      '/sign-in/email': { window: 60, max: 10 },
      '/request-password-reset': { window: 60, max: 5 },
      '/send-verification-email': { window: 60, max: 5 },
    } },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 12, cookieCache: { enabled: false } },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      requireEmailVerification: true,
      minPasswordLength: 12,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: ({ user, url }) => send(user.email, 'Set your RentLedger password', url),
    },
    emailVerification: {
      sendOnSignIn: false,
      autoSignInAfterVerification: false,
      sendVerificationEmail: ({ user, url }) => send(user.email, 'Verify your RentLedger email', url),
    },
    plugins: [twoFactor({ issuer: 'RentLedger' })],
    databaseHooks: {
      user: { update: { after: async (user, context) => {
        const path = context?.path;
        if (path === '/verify-email') await accountAudit(user.id, 'account.email_verified');
        if (path === '/two-factor/verify-totp' || path === '/two-factor/disable') {
          await accountAudit(user.id, user.twoFactorEnabled ? 'account.mfa_enabled' : 'account.mfa_disabled');
        }
      } } },
      account: { update: { after: async (account, context) => {
        if (context?.path === '/change-password' || context?.path === '/reset-password') await accountAudit(account.userId, 'account.password_updated');
      } } },
      session: {
        create: { after: session => accountAudit(session.userId, 'account.session_created') },
        delete: { after: session => accountAudit(session.userId, 'account.session_removed') },
      },
    },
    logger: { disabled: production },
  });
}

export type Auth = ReturnType<typeof createAuth>;
