# WhatsApp receipt setup

Production starts with `WHATSAPP_MODE=disabled`. An organization can enable queueing in Settings once the platform operator has an approved sender. `UNCONFIGURED` indicates that the organization or sender is unavailable. `SIMULATED` is available only in development or tests and records no delivery.

1. Register a Meta business portfolio, WhatsApp Business Account, Meta app and approved Cloud API number. Complete applicable business and display name checks and confirm the shared sender arrangement is permitted for the organizations it represents. A personal WhatsApp number alone cannot send through this adapter. Create a least-privileged system user token and store it in the worker secret store. [Meta WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api/)
2. Submit distinct cash and online utility templates in the selected language. The default `META_TEMPLATE_LAYOUT=detailed_v1` uses positional text fields in this order: recipient name, owner or business name, property, room, billing months with amounts or advance credit, total INR amount, actual payment date and time in IST, and online reference for the online template only. The static template text identifies the method. The shared sender also supports the approved `receipt_v1` layout described below. Verify long and multiple-month receipts against the template's approved examples and message limits. [Meta template documentation](https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates/)
3. Set `WHATSAPP_MODE=meta`, `META_GRAPH_VERSION`, `META_PHONE_NUMBER_ID`, `META_CASH_TEMPLATE`, `META_ONLINE_TEMPLATE`, `META_TEMPLATE_LANGUAGE`, `META_APP_SECRET`, and `META_VERIFY_TOKEN`. The worker needs `META_ACCESS_TOKEN`. The API currently validates shared-sender availability at payment time and also needs the shared token or the owner-sender secret reference to resolve. Keep secrets server-side. Use a version currently supported by your app.
4. Subscribe the app's `messages` field to `https://your-domain/api/webhooks/whatsapp`. Meta verifies the subscription via challenge. Subsequent requests must carry a valid raw-body `X-Hub-Signature-256`. Use controlled recipients who opted in and confirm accepted, sent, delivered, read, and failure outcomes in staging.
5. Record each tenant's opt-in and its source in Tenants. Record opt-outs promptly. The worker rechecks the current number, consent record, lease-linked tenant, and payment reversal immediately before dispatch. A receipt already in flight can still complete after an opt-out or reversal. [WhatsApp Business Messaging Policy](https://business.whatsapp.com/policy)

Per-owner onboarding is operator-managed. Once approved, insert a disabled `WhatsAppSender` referencing the organization, sender number, language, template names, and a worker/API environment key named `META_OWNER_TOKEN_<NAME>`. Keep the actual token in the secret store. Enable the sender and `META_OWNER_SENDERS_ENABLED` only after staging verification. A registered owner sender that is disabled or unavailable prevents fallback to the platform sender.

## Approved receipt template layout

Meta's read-only API confirmed on 13 November 2026 that the test account's
`rent_receipt_cash` and `rent_receipt_online` templates are `APPROVED`, category
`UTILITY`, language `en`. This establishes approval, not real receipt delivery or
production sender readiness. For these exact bodies set:

```ini
WHATSAPP_MODE=disabled
META_CASH_TEMPLATE=rent_receipt_cash
META_ONLINE_TEMPLATE=rent_receipt_online
META_TEMPLATE_LANGUAGE=en
META_TEMPLATE_LAYOUT=receipt_v1
```

| Field | Cash | Online |
| --- | --- | --- |
| Tenant name | 1 | 1 |
| Numeric rupee amount, without a currency prefix | 2 | 2 |
| Owner, property, covered months/amounts and any advance credit | 3 | 3 |
| Room | 4 | 4 |
| Existing committed payment ID as Receipt Number | 5 | 5 |
| Online transaction reference, preserving leading zeroes | Omitted | 6 |
| Actual payment date/time in IST | 6 | 7 |

The approved bodies already contain `INR`, so the amount parameter omits `₹`.
The date uses the actual payment instant, not the send time. The receipt number
uses the outbox's immutable payment relation, not its dispatch claim token.
Existing version-1 snapshots remain unchanged. Owner-connected senders retain
`detailed_v1`; the shared layout setting does not change another sender's
contract. Match the exact template body and language before enabling a sender.

Keep sending disabled until the verification token, public HTTPS callback,
signed status subscription and a controlled consented receipt test are ready.

Local verification on 13 November 2026 passed six receipt-layout tests and
fourteen PostgreSQL integration tests, plus lint and TypeScript checks. The
database tests used a new disposable local cluster and restricted API/worker
roles. These regression tests stubbed provider transport and did not migrate or
populate the configured Neon database.

A separate controlled Meta test on 13 November 2026 sent one cash and one online
receipt to the operator's verified test recipient. Both were confirmed `READ`
through authenticated Meta callbacks and persisted outbox state. These were
committed, explicitly labelled TEST payments in an isolated local database; no
real money or rental records were created in Neon. The temporary callback and
database were closed after verification. This establishes developer test-sender
delivery, not production activation. A permanent HTTPS callback, production
sender/token configuration and real tenant opt-in still require verification.

## Production activation checkpoint — 15 November 2026

A read-only local configuration check still identifies the Meta test sender and
test Messaging account. Normal sending remains disabled. Meta rejected both the
sender and template lookup with HTTP 401, code 190, subcode 463 (expired access
token), so the earlier template approval could not be rechecked today. The root
configuration has no verification token and still uses a localhost app origin;
no permanent production callback has been verified. No messages or tenant
consent changes were made during this check.

The operator currently has only a personal WhatsApp number. Choose a production
sender before activation. A separate owned SIM/eSIM that can receive SMS or
voice verification is the recommended direct Cloud API route. Keep personal
WhatsApp unchanged. Meta also documents coexistence for eligible **WhatsApp
Business app** accounts through separate Embedded Signup onboarding; this
project does not implement that onboarding flow. Do not assume that entering a
personal number in `.env` connects it to the API.

- [Meta business phone number requirements](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers)
- [Meta Business app coexistence onboarding](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users)

### Collect and record tenant permission

Ask each tenant individually, identifying the actual owner/property. Suggested
wording to adapt and send manually:

> May [owner/property name] send your rent-payment receipts through RentLedger
> on WhatsApp at this number? Reply YES if you agree. You can contact
> [owner/contact method] at any time to stop these messages.

Keep evidence of the tenant's affirmative response privately. Then open
**Tenants → select tenant → WhatsApp consent**, choose **Record explicit
opt-in**, enter the actual consent source/date, and select **Save consent**.
The backend records the timestamp. Do not treat an existing lease, saved phone
number, test receipt, or lack of objection as consent. For a withdrawal, choose
**Record opt-out** and save the reason promptly.

This implementation processes delivery callbacks, not an incoming-message
inbox or automatic STOP replies. Provide and monitor the stated owner contact
method for withdrawals. Do not promise that replying STOP is handled
automatically. See [Meta's messaging policy](https://business.whatsapp.com/policy).

### Finish activation after selecting the sender

1. Register and verify the production business number and resolve any applicable
   account, display-name, billing or business checks shown by Meta.
2. Verify the production Messaging account's own cash/online template approvals,
   exact bodies, parameter layout and language. Test-account approval does not
   establish approval in another account.
3. Configure the production number/account IDs, a valid least-privileged system
   user token, app secret and private verification token in the server secret
   store. Keep `WHATSAPP_MODE=disabled` for ordinary payments during setup.
4. When hosting is available, verify a permanent public HTTPS callback, subscribe
   the correct app/account to `messages`, and confirm signature verification.
   The earlier temporary tunnel is closed; its URL is not a production endpoint.
5. Use an isolated database and an explicitly consented controlled recipient for
   one clearly labelled test cash receipt and one online receipt. Confirm signed
   **DELIVERED** or **READ** callbacks in persisted state, not just API acceptance.
   The old local helper is intentionally limited to the Meta test sender and
   must not be reused unchanged for production-number testing.
6. Only after those checks pass, enable the verified sender and the intended
   organization's receipt setting, then test an authorized real payment flow.
   Existing `UNCONFIGURED` / `NO_CONSENT` rows are not automatically backfilled.

## Delivery states

| State | Meaning |
| --- | --- |
| Pending / Sending | Waiting for a worker or held by a current claim. |
| Accepted | Meta returned a provider message ID. Delivery is tracked separately. |
| Sent / Delivered / Read | Signed provider status updates. |
| Failed | A confirmed rejection or provider failure. A bounded manual retry is available only for retryable rejections without a provider ID. |
| Uncertain | The request may have reached Meta. Reconcile provider records before considering a resend. Signed callbacks can still resolve this state. |

Dispatch is conservatively rate-limited across workers. Clear rate rejections retry with bounded backoff. An ambiguous response or expired in-flight claim requires reconciliation to avoid duplicate messages. Exactly-once external delivery cannot be guaranteed. Monitor worker heartbeat, failed or uncertain receipts, template approval, rate limits, and token expiry. Verify current India utility pricing and any account-specific terms directly before launch. [WhatsApp Business Platform pricing](https://business.whatsapp.com/products/platform-pricing)

After disaster recovery, potentially dispatched receipts are held as `UNCERTAIN` with reason `RESTORE_RECONCILIATION_REQUIRED`. Reconcile provider history before enabling messaging on the recovered database. The worker does not automatically resend these holds and owner retry is blocked. See the [recovery runbook](backup-recovery.md).
