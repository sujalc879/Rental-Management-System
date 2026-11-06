import { z } from 'zod';
import type { WhatsAppSender } from '../../../packages/db/generated/client';
import type { MessagingConfig } from './config';

export const receiptSchema = z.object({
  version: z.literal(1), tenant: z.string(), owner: z.string(), property: z.string(), room: z.string(),
  whatsapp: z.string().nullable(), consentAt: z.string().nullable(),
  paidAt: z.iso.datetime(), mode: z.enum(['CASH', 'ONLINE']), reference: z.string().nullable(), amountPaise: z.number().int(),
  months: z.array(z.object({ period: z.string(), amountPaise: z.number().int() })), creditPaise: z.number().int(),
});
export type Receipt = z.infer<typeof receiptSchema>;

export function senderFor(config: MessagingConfig, sender: WhatsAppSender | null, mode: Receipt['mode']) {
  if (config.WHATSAPP_MODE !== 'meta' || !config.META_GRAPH_VERSION || !config.META_APP_SECRET || !config.META_VERIFY_TOKEN) return null;
  if (sender) {
    if (!config.META_OWNER_SENDERS_ENABLED || !sender.enabled || sender.phoneNumberId === config.META_PHONE_NUMBER_ID || !/^META_OWNER_TOKEN_[A-Z0-9_]+$/.test(sender.secretRef)) return null;
    if (!/^\d+$/.test(sender.phoneNumberId) || !/^[a-z0-9_]+$/.test(sender.cashTemplate) || !/^[a-z0-9_]+$/.test(sender.onlineTemplate) || !/^[a-z]{2}(?:_[A-Z]{2})?$/.test(sender.language)) return null;
    const token = process.env[sender.secretRef];
    if (!token) return null;
    return { phoneId: sender.phoneNumberId, token, template: mode === 'CASH' ? sender.cashTemplate : sender.onlineTemplate, language: sender.language };
  }
  const { META_PHONE_NUMBER_ID: phoneId, META_ACCESS_TOKEN: token, META_CASH_TEMPLATE, META_ONLINE_TEMPLATE } = config;
  if (!phoneId || !token || !META_CASH_TEMPLATE || !META_ONLINE_TEMPLATE) return null;
  return { phoneId, token, template: mode === 'CASH' ? META_CASH_TEMPLATE : META_ONLINE_TEMPLATE, language: config.META_TEMPLATE_LANGUAGE };
}
