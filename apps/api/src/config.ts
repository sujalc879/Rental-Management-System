import { z } from 'zod';

const messagingSchema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    WHATSAPP_MODE: z.enum(['disabled', 'mock', 'meta']).default('disabled'),
    META_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).optional(),
    META_PHONE_NUMBER_ID: z.string().regex(/^\d+$/).optional(),
    META_ACCESS_TOKEN: z.string().min(1).optional(),
    META_APP_SECRET: z.string().min(1).optional(),
    META_VERIFY_TOKEN: z.string().min(24).optional(),
    META_CASH_TEMPLATE: z.string().regex(/^[a-z0-9_]+$/).optional(),
    META_ONLINE_TEMPLATE: z.string().regex(/^[a-z0-9_]+$/).optional(),
    META_TEMPLATE_LANGUAGE: z.string().regex(/^[a-z]{2}(?:_[A-Z]{2})?$/).default('en'),
    META_OWNER_SENDERS_ENABLED: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
});

function validated<T>(schema: z.ZodType<T>, env: NodeJS.ProcessEnv) {
  const parsed = schema.safeParse(Object.fromEntries(Object.entries(env).filter(([, value]) => value !== '')));
  if (!parsed.success) throw new Error(`Invalid configuration fields: ${parsed.error.issues.map(issue => issue.path.join('.')).join(', ')}`);
  return parsed.data;
}

export function readMessagingConfig(env = process.env) {
  const config = validated(messagingSchema, env);
  if (config.NODE_ENV === 'production' && config.WHATSAPP_MODE === 'mock') throw new Error('Production requires a non-mock messaging mode');
  return config;
}

export function readConfig(env = process.env) {
  const messaging = readMessagingConfig(env);
  const config = { ...messaging, ...validated(z.object({
    APP_ORIGIN: z.url().default('http://localhost:5173'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    BETTER_AUTH_SECRET: z.string().min(32),
    TRUSTED_PROXY_IP_HEADER: z.string().regex(/^[a-z0-9-]+$/).optional(),
    SMTP_URL: z.url().optional(),
    MAIL_FROM: z.string().min(3).optional(),
    DEV_MAIL_DIR: z.string().default('.local/mail'),
    BACKUP_ENABLED: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  }), env) };
  const origin = new URL(config.APP_ORIGIN);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== config.APP_ORIGIN) {
    throw new Error('APP_ORIGIN must be an HTTP origin without a trailing slash');
  }
  if (config.NODE_ENV === 'production' && (
    origin.protocol !== 'https:' || !config.SMTP_URL || !config.MAIL_FROM ||
    !/^smtps?:\/\//.test(config.SMTP_URL) || !config.TRUSTED_PROXY_IP_HEADER
  )) throw new Error('Production requires HTTPS, SMTP and a trusted proxy IP header');
  return config;
}

export type Config = ReturnType<typeof readConfig>;
export type MessagingConfig = ReturnType<typeof readMessagingConfig>;
