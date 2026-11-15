import { afterEach, expect, test, vi } from 'vitest';
import { readMessagingConfig } from '../apps/api/src/config';
import { receiptParameters, sendMeta } from '../apps/api/src/messaging';
import { senderFor, type Receipt } from '../apps/api/src/receipt';

const paymentId = '11111111-1111-4111-8111-111111111111';
const claimId = '22222222-2222-4222-8222-222222222222';
const receipt: Receipt = {
  version: 1, tenant: 'Rahul', owner: 'Sujal', property: 'Shree Residency', room: '101',
  whatsapp: '+919876543210', consentAt: '2026-11-01T10:00:00.000Z',
  paidAt: '2026-11-12T21:00:00.000Z', mode: 'CASH', reference: null,
  amountPaise: 800_001, months: [{ period: '2026-11', amountPaise: 800_001 }], creditPaise: 0,
};
const config = readMessagingConfig({
  NODE_ENV: 'test', WHATSAPP_MODE: 'meta', META_GRAPH_VERSION: 'v25.0',
  META_PHONE_NUMBER_ID: '101', META_ACCESS_TOKEN: 'test-only-token', META_APP_SECRET: 'test-only-secret',
  META_VERIFY_TOKEN: 'test-only-verification-token-0123456', META_CASH_TEMPLATE: 'rent_receipt_cash',
  META_ONLINE_TEMPLATE: 'rent_receipt_online', META_TEMPLATE_LANGUAGE: 'en', META_TEMPLATE_LAYOUT: 'receipt_v1',
});
// Bodies retrieved from Meta after approval. Transport below is always stubbed.
const approvedBodies = {
  CASH: 'Hello {{1}},\n\nWe have received your cash rent payment of INR {{2}} for {{3}}.\n\nRoom: {{4}}\nReceipt Number: {{5}}\nPayment Date: {{6}}\n\nThank you,\nRentLedger',
  ONLINE: 'Hello {{1}},\n\nWe have received your online rent payment of INR {{2}} for {{3}}.\n\nRoom: {{4}}\nReceipt Number: {{5}}\nTransaction Reference: {{6}}\nPayment Date: {{7}}\n\nThank you,\nRentLedger',
};
afterEach(() => vi.unstubAllEnvs());

test.each(['CASH', 'ONLINE'] as const)('matches every approved %s template field without sending a real message', async mode => {
  const data: Receipt = { ...receipt, mode, reference: mode === 'ONLINE' ? '000UPI123' : null };
  const sender = senderFor(config, null, mode)!;
  const transport = vi.fn(async () => Response.json({ messages: [{ id: 'wamid.stub-only' }] }));
  const send = Object.assign(transport, { preconnect: fetch.preconnect });
  expect(await sendMeta('v25.0', sender, data, claimId, send, paymentId))
    .toEqual({ status: 'ACCEPTED', providerId: 'wamid.stub-only' });
  const options = transport.mock.calls[0] as unknown as [string, RequestInit];
  const payload = JSON.parse(String(options[1].body));
  const values: string[] = payload.template.components[0].parameters.map((value: { text: string }) => value.text);
  expect(values).toEqual([
    'Rahul', '8,000.01', 'Owner: Sujal; Property: Shree Residency; Rent: 2026-11 ₹8,000.01',
    '101', paymentId, ...(mode === 'ONLINE' ? ['000UPI123'] : []),
    expect.stringMatching(/13 Nov 2026.*2:30.*am.*IST/i),
  ]);
  expect(payload.template).toMatchObject({ name: mode === 'CASH' ? 'rent_receipt_cash' : 'rent_receipt_online', language: { code: 'en' } });
  expect(payload.biz_opaque_callback_data).toBe(claimId);
  const rendered = approvedBodies[mode].replace(/\{\{(\d+)\}\}/g, (_, index: string) => values[Number(index) - 1]);
  expect(rendered).toContain(`received your ${mode.toLowerCase()} rent payment of INR 8,000.01 for Owner: Sujal`);
  expect(rendered).toContain(`Receipt Number: ${paymentId}`);
  expect(rendered).not.toContain(claimId);
  expect(rendered).not.toContain('INR ₹');
  expect(rendered).not.toContain('{{');
  if (mode === 'ONLINE') expect(rendered).toContain('Transaction Reference: 000UPI123');
  else expect(rendered).not.toContain('Transaction Reference:');
});

test('retains exact multi-month allocations and advance credit without modifying the saved receipt', () => {
  const data: Receipt = { ...receipt, amountPaise: 900_001,
    months: [{ period: '2026-11', amountPaise: 500_000 }, { period: '2026-12', amountPaise: 300_001 }], creditPaise: 100_000 };
  const original = structuredClone(data);
  const values = receiptParameters(data, 'receipt_v1', paymentId);
  expect(values[1]).toBe('9,000.01');
  expect(values[2]).toBe('Owner: Sujal; Property: Shree Residency; Rent: 2026-11 ₹5,000.00, 2026-12 ₹3,000.01 · Advance credit ₹1,000.00');
  expect(data).toEqual(original);
});

test('rejects a missing or malformed payment ID before calling Meta', async () => {
  const sender = senderFor(config, null, 'CASH')!;
  const transport = vi.fn(async () => Response.json({ messages: [{ id: 'must-not-be-used' }] }));
  const send = Object.assign(transport, { preconnect: fetch.preconnect });
  for (const id of [undefined, 'invented-receipt-number']) {
    expect(await sendMeta('v25.0', sender, receipt, claimId, send, id))
      .toEqual({ status: 'FAILED', reason: 'META_INVALID_RECEIPT', retryable: false });
  }
  expect(transport).not.toHaveBeenCalled();
});

test('preserves the detailed template order for existing cash and online senders', () => {
  const cash = receiptParameters(receipt);
  expect(cash).toEqual(['Rahul', 'Sujal', 'Shree Residency', '101', '2026-11 ₹8,000.01', '₹8,000.01',
    expect.stringMatching(/13 Nov 2026.*2:30.*am.*IST/i)]);
  const online = receiptParameters({ ...receipt, mode: 'ONLINE', reference: '000UPI123' });
  expect(online).toEqual([...cash, '000UPI123']);
});

test('a shared receipt layout does not change another organization sender layout', () => {
  vi.stubEnv('META_OWNER_TOKEN_TEST', 'test-only-owner-token');
  const sender = senderFor({ ...config, META_OWNER_SENDERS_ENABLED: true }, {
    id: claimId, organizationId: paymentId, phoneNumberId: '202', secretRef: 'META_OWNER_TOKEN_TEST',
    cashTemplate: 'owner_cash', onlineTemplate: 'owner_online', language: 'en', enabled: true,
  }, 'CASH');
  expect(sender).toMatchObject({ phoneId: '202', template: 'owner_cash', templateLayout: 'detailed_v1' });
  expect(receiptParameters(receipt, sender!.templateLayout)).toHaveLength(7);
});
