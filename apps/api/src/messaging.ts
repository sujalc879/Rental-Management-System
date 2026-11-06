import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { MessageStatus, NotificationOutbox } from '../../../packages/db/generated/client';
import type { Database } from '../../../packages/db/src/index';
import { businessTimeZone, inr } from '../../../packages/shared/src/ledger';
import { atomic, audit, conflict, hash, missing, type Scope, type Tx } from './domain';
import { receiptSchema, senderFor, type Receipt } from './receipt';
import type { MessagingConfig } from './config';

const maximumAttempts = 5;
const maximumManualRetries = 2;
const localTime = new Intl.DateTimeFormat('en-IN', { timeZone: businessTimeZone, dateStyle: 'medium', timeStyle: 'short' });
const safeText = (value: string) => value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim();

export function receiptParameters(receipt: Receipt) {
  const months = receipt.months.map(row => `${row.period} ${inr(row.amountPaise)}`).join(', ');
  const coverage = [months, receipt.creditPaise ? `Advance credit ${inr(receipt.creditPaise)}` : ''].filter(Boolean).join(' · ');
  return [receipt.tenant, receipt.owner, receipt.property, receipt.room, coverage, inr(receipt.amountPaise),
    `${localTime.format(new Date(receipt.paidAt))} IST`, ...(receipt.mode === 'ONLINE' ? [receipt.reference!] : []),
  ].map(safeText);
}

export function signed(secret: string, payload: Uint8Array, signature: string | null) {
  if (!signature || !/^sha256=[a-f\d]{64}$/i.test(signature)) return false;
  return timingSafeEqual(createHmac('sha256', secret).update(payload).digest(), Buffer.from(signature.slice(7), 'hex'));
}

export function verifyWebhook(config: MessagingConfig, url: URL) {
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  if (config.WHATSAPP_MODE === 'meta' && config.META_VERIFY_TOKEN && token && url.searchParams.get('hub.mode') === 'subscribe' && challenge &&
    timingSafeEqual(Buffer.from(hash(config.META_VERIFY_TOKEN), 'hex'), Buffer.from(hash(token), 'hex'))) return new Response(challenge);
  return new Response(null, { status: 403 });
}

const delivery = z.object({ id: z.string().min(1).max(300), status: z.enum(['sent', 'delivered', 'read', 'failed']),
  timestamp: z.string().max(30).optional(), biz_opaque_callback_data: z.uuid().optional(),
  errors: z.array(z.object({ code: z.number().int() })).optional(),
});
const webhook = z.object({ object: z.literal('whatsapp_business_account'), entry: z.array(z.object({ changes: z.array(z.object({
  field: z.string(), value: z.object({ metadata: z.object({ phone_number_id: z.string().regex(/^\d+$/) }).optional(), statuses: z.array(z.unknown()).optional() }),
})) })) });
const weights: Partial<Record<MessageStatus, number>> = { SENDING: 0, UNCERTAIN: 0, ACCEPTED: 1, SENT: 2, FAILED: 3, DELIVERED: 4, READ: 5 };

async function reconcile(tx: Tx, phoneId: string, event: z.infer<typeof delivery>) {
  const opaque = event.biz_opaque_callback_data;
  const targets = await tx.$queryRaw<NotificationOutbox[]>`SELECT * FROM "NotificationOutbox"
    WHERE "senderNumberId" = ${phoneId} AND ("providerId" = ${event.id} OR (${opaque ?? null}::uuid IS NOT NULL
      AND "claimToken" = ${opaque ?? null}::uuid AND "providerId" IS NULL)) FOR UPDATE`;
  if (targets.length !== 1) return;
  const [row] = targets;
  const fingerprint = hash(JSON.stringify([phoneId, event.id, event.status, event.timestamp ?? null]));
  if (!(await tx.webhookEvent.createMany({ data: { fingerprint }, skipDuplicates: true })).count) return;
  const status = event.status.toUpperCase() as MessageStatus;
  const weight = weights[row.status];
  if (weight === undefined || weights[status]! <= weight) return;
  const reason = status === 'FAILED' ? `META_DELIVERY_${event.errors?.[0]?.code ?? 'FAILED'}` : null;
  await tx.notificationOutbox.update({ where: { id: row.id, organizationId: row.organizationId }, data: {
    status, reason, providerId: event.id, retryable: false, claimUntil: null,
  } });
  await audit(tx, { organizationId: row.organizationId, actorId: null }, 'notification.status', row.id, { status });
}

export async function receiveWebhook(db: Database, config: MessagingConfig, request: Request) {
  const payload = new Uint8Array(await request.arrayBuffer());
  if (config.WHATSAPP_MODE !== 'meta' || !config.META_APP_SECRET || !signed(config.META_APP_SECRET, payload, request.headers.get('x-hub-signature-256'))) {
    return new Response(null, { status: 403 });
  }
  let decoded: unknown;
  try { decoded = JSON.parse(new TextDecoder().decode(payload)); } catch { return new Response(null, { status: 400 }); }
  const parsed = webhook.safeParse(decoded);
  if (!parsed.success) return new Response(null, { status: 400 });
  for (const entry of parsed.data.entry) for (const { field, value } of entry.changes) {
    if (field !== 'messages' || !value.metadata) continue;
    const phoneId = value.metadata.phone_number_id;
    for (const candidate of value.statuses ?? []) {
      const event = delivery.safeParse(candidate);
      if (event.success) await db.$transaction(tx => reconcile(tx, phoneId, event.data));
    }
  }
  return new Response(null, { status: 200 });
}

type SendResult = { status: 'ACCEPTED' | 'SIMULATED' | 'UNCERTAIN' | 'FAILED'; providerId?: string; reason?: string; retryable?: boolean };
type Sender = NonNullable<ReturnType<typeof senderFor>>;

export async function sendMeta(version: string, sender: Sender, receipt: Receipt, token: string, send = fetch): Promise<SendResult> {
  try {
    const response = await send(`https://graph.facebook.com/${version}/${sender.phoneId}/messages`, {
      method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${sender.token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(12_000),
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: receipt.whatsapp!.slice(1), type: 'template',
        biz_opaque_callback_data: token, template: { name: sender.template, language: { code: sender.language },
          components: [{ type: 'body', parameters: receiptParameters(receipt).map(text => ({ type: 'text', text })) }],
        },
      }),
    });
    if (response.status === 429) return { status: 'FAILED', reason: 'META_RATE_LIMIT', retryable: true };
    if (response.status >= 500) return { status: 'UNCERTAIN', reason: 'META_AMBIGUOUS_RESPONSE' };
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = z.object({ error: z.object({ code: z.number().int() }) }).safeParse(data);
      const code = error.success ? error.data.error.code : null;
      return { status: 'FAILED', reason: code ? `META_REJECTED_${code}` : 'META_REJECTED', retryable: code !== null && [4, 130429, 131056].includes(code) };
    }
    const result = z.object({ messages: z.array(z.object({ id: z.string().min(1).max(300) })).length(1) }).safeParse(data);
    return result.success ? { status: 'ACCEPTED', providerId: result.data.messages[0].id }
      : { status: 'UNCERTAIN', reason: 'META_MISSING_MESSAGE_ID' };
  } catch { return { status: 'UNCERTAIN', reason: 'META_CONNECTION_AMBIGUOUS' }; }
}

export async function retryNotification(db: Database, config: MessagingConfig, scope: Scope, id: string) {
  return atomic(db, scope, async tx => {
    const organizationId = scope.organizationId;
    const row = await tx.notificationOutbox.findFirst({ where: { id, organizationId }, include: { payment: { include: { reversal: true } } } });
    if (!row) throw missing();
    if (row.status !== 'FAILED' || !row.retryable || row.providerId || row.payment.reversal || row.manualRetries >= maximumManualRetries || row.attempts < maximumAttempts) {
      throw conflict('This receipt is not eligible for a manual retry');
    }
    const organization = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, include: { sender: true } });
    if (!organization.whatsappEnabled || (config.WHATSAPP_MODE !== 'mock' && !senderFor(config, organization.sender, row.payment.mode))) throw conflict('WhatsApp is unconfigured');
    const result = await tx.notificationOutbox.updateMany({ where: { id, organizationId, status: 'FAILED', retryable: true }, data: {
      status: 'PENDING', attempts: 0, manualRetries: { increment: 1 }, nextAt: new Date(), claimToken: null, claimUntil: null, retryable: false, reason: null,
    } });
    if (!result.count) throw conflict('This receipt changed. Refresh the history.');
    await audit(tx, scope, 'notification.retried', id);
    return { status: 'PENDING' };
  });
}

export async function dispatchOne(db: Database, config: MessagingConfig, send = fetch) {
  const token = crypto.randomUUID();
  const claimed = await db.$transaction(async tx => {
    // Serialize claims across replicas for a conservative platform-wide send rate.
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(62811477)`;
    const [recent] = await tx.$queryRaw<{ recent: boolean }[]>`SELECT EXISTS (SELECT 1 FROM "NotificationOutbox"
      WHERE "claimToken" IS NOT NULL AND "updatedAt" > now() - interval '1 second') AS recent`;
    if (recent.recent) return undefined;
    const [row] = await tx.$queryRaw<{ id: string; organizationId: string }[]>`SELECT id, "organizationId" FROM "NotificationOutbox"
      WHERE status = 'PENDING' AND "nextAt" <= now() ORDER BY "nextAt", id LIMIT 1 FOR UPDATE SKIP LOCKED`;
    if (!row) return undefined;
    await tx.notificationOutbox.update({ where: { id: row.id, organizationId: row.organizationId }, data: {
      status: 'SENDING', claimToken: token, claimUntil: new Date(Date.now() + 90_000), attempts: { increment: 1 },
    } });
    return row;
  });
  if (!claimed) return false;
  const scope = { organizationId: claimed.organizationId, actorId: null };
  const prepared = await atomic(db, scope, async tx => {
    const row = await tx.notificationOutbox.findFirst({ where: { ...claimed, status: 'SENDING', claimToken: token },
      include: { payment: { include: { reversal: true, lease: { include: { tenant: true } } } } },
    });
    if (!row) return null;
    const receipt = receiptSchema.parse(row.snapshot);
    const tenant = row.payment.lease.tenant;
    const organization = await tx.organization.findUniqueOrThrow({ where: { id: scope.organizationId }, include: { sender: true } });
    const sender = senderFor(config, organization.sender, receipt.mode);
    const mock = config.WHATSAPP_MODE === 'mock' && config.NODE_ENV !== 'production';
    const status = row.payment.reversal ? 'CANCELLED'
      : !organization.whatsappEnabled || (!mock && !sender) ? 'UNCONFIGURED'
      : !receipt.whatsapp || tenant.whatsapp !== receipt.whatsapp || !receipt.consentAt || tenant.consentAt?.toISOString() !== receipt.consentAt || tenant.optedOutAt || tenant.archivedAt ? 'NO_CONSENT' : null;
    if (status) {
      await tx.notificationOutbox.updateMany({ where: { ...claimed, status: 'SENDING', claimToken: token }, data: { status, claimUntil: null, retryable: false } });
      await audit(tx, scope, 'notification.status', row.id, { status });
      return null;
    }
    if (sender && row.senderNumberId && row.senderNumberId !== sender.phoneId) {
      await tx.notificationOutbox.updateMany({ where: { ...claimed, status: 'SENDING', claimToken: token }, data: { status: 'UNCONFIGURED', claimUntil: null, reason: 'SENDER_CHANGED' } });
      return null;
    }
    const changed = await tx.notificationOutbox.updateMany({ where: { ...claimed, status: 'SENDING', claimToken: token, claimUntil: { gt: new Date() } },
      data: { senderNumberId: sender?.phoneId ?? null },
    });
    return changed.count ? { receipt, sender, mock, attempts: row.attempts } : null;
  });
  if (!prepared) return true;
  const result: SendResult = prepared.mock ? { status: 'SIMULATED', reason: 'LOCAL_MOCK_NO_DELIVERY' }
    : await sendMeta(config.META_GRAPH_VERSION!, prepared.sender!, prepared.receipt, token, send);
  const automaticRetry = result.retryable && prepared.attempts < maximumAttempts;
  const status = automaticRetry ? 'PENDING' : result.status;
  await db.$transaction(async tx => {
    const updated = await tx.notificationOutbox.updateMany({ where: { ...claimed, status: 'SENDING', claimToken: token }, data: {
      status, providerId: result.providerId, reason: result.reason ?? null, retryable: result.retryable ?? false, claimUntil: null,
      nextAt: automaticRetry ? new Date(Date.now() + 30_000 * 2 ** (prepared.attempts - 1)) : undefined,
    } });
    if (updated.count) await audit(tx, scope, 'notification.status', claimed.id, { status });
  });
  return true;
}

export async function recoverExpiredClaims(db: Database) {
  return db.$transaction(async tx => {
    const rows = await tx.$queryRaw<{ id: string; organizationId: string }[]>`UPDATE "NotificationOutbox" SET status = 'UNCERTAIN',
      reason = 'WORKER_CLAIM_EXPIRED', "claimUntil" = NULL, "updatedAt" = now(), retryable = false
      WHERE status = 'SENDING' AND "claimUntil" < now() RETURNING id, "organizationId"`;
    if (rows.length) await tx.auditLog.createMany({ data: rows.map(row => ({ organizationId: row.organizationId, entityId: row.id, action: 'notification.status', details: { status: 'UNCERTAIN' } })) });
    return rows.length;
  });
}
