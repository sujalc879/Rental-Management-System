# WhatsApp receipt setup

Production starts with `WHATSAPP_MODE=disabled`. An organization can enable queueing in Settings once the platform operator has an approved sender. `UNCONFIGURED` indicates that the organization or sender is unavailable. `SIMULATED` is available only in development or tests and records no delivery.

1. Register a Meta business portfolio, WhatsApp Business Account, Meta app and approved Cloud API number. Complete applicable business and display name checks and confirm the shared sender arrangement is permitted for the organizations it represents. A personal WhatsApp number alone cannot send through this adapter. Create a least-privileged system user token and store it in the worker secret store. [Meta WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api/)
2. Submit distinct cash and online utility templates in the selected language. Use positional text fields in this order. Recipient name, owner or business name, property, room, billing months with amounts or advance credit, total INR amount, actual payment date and time in IST, and online reference for the online template only. The static template text identifies the method. Verify long and multiple-month receipts against the template's approved examples and message limits. [Meta template documentation](https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates/)
3. Set `WHATSAPP_MODE=meta`, `META_GRAPH_VERSION`, `META_PHONE_NUMBER_ID`, `META_CASH_TEMPLATE`, `META_ONLINE_TEMPLATE`, `META_TEMPLATE_LANGUAGE`, `META_APP_SECRET`, and `META_VERIFY_TOKEN`. The worker needs `META_ACCESS_TOKEN`. The API currently validates shared-sender availability at payment time and also needs the shared token or the owner-sender secret reference to resolve. Keep secrets server-side. Use a version currently supported by your app.
4. Subscribe the app's `messages` field to `https://your-domain/api/webhooks/whatsapp`. Meta verifies the subscription via challenge. Subsequent requests must carry a valid raw-body `X-Hub-Signature-256`. Use controlled recipients who opted in and confirm accepted, sent, delivered, read, and failure outcomes in staging.
5. Record each tenant's opt-in and its source in Tenants. Record opt-outs promptly. The worker rechecks the current number, consent record, lease-linked tenant, and payment reversal immediately before dispatch. A receipt already in flight can still complete after an opt-out or reversal. [WhatsApp Business Messaging Policy](https://business.whatsapp.com/policy)

Per-owner onboarding is operator-managed. Once approved, insert a disabled `WhatsAppSender` referencing the organization, sender number, language, template names, and a worker/API environment key named `META_OWNER_TOKEN_<NAME>`. Keep the actual token in the secret store. Enable the sender and `META_OWNER_SENDERS_ENABLED` only after staging verification. A registered owner sender that is disabled or unavailable prevents fallback to the platform sender.

| State | Meaning |
| --- | --- |
| Pending / Sending | Waiting for a worker or held by a current claim. |
| Accepted | Meta returned a provider message ID. Delivery is tracked separately. |
| Sent / Delivered / Read | Signed provider status updates. |
| Failed | A confirmed rejection or provider failure. A bounded manual retry is available only for retryable rejections without a provider ID. |
| Uncertain | The request may have reached Meta. Reconcile provider records before considering a resend. Signed callbacks can still resolve this state. |

Dispatch is conservatively rate-limited across workers. Clear rate rejections retry with bounded backoff. An ambiguous response or expired in-flight claim requires reconciliation to avoid duplicate messages. Exactly-once external delivery cannot be guaranteed. Monitor worker heartbeat, failed or uncertain receipts, template approval, rate limits, and token expiry. Verify current India utility pricing and any account-specific terms directly before launch. [WhatsApp Business Platform pricing](https://business.whatsapp.com/products/platform-pricing)
