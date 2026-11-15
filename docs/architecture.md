# Architecture

The root `AGENTS.md` governs implementation. The repository began with a two-line README and no runtime or schema. The application is a modular monolith with a React/Vite frontend, a Bun/Hono API, Better Auth, Prisma ORM 7 with `@prisma/adapter-pg`, and PostgreSQL. A separate persistent worker runs ledger and messaging jobs. An independent backup runner uses PostgreSQL client tools and private S3-compatible storage. There is no Redis or browser-based scheduling.

The UI uses Tailwind, Lucide, React Router, TanStack Query, React Hook Form and Zod. Shared native forms, status badges and tables cover the current interface without generated shadcn/ui components. The API uses Zod validation and versioned receipt data. An OpenAPI contract is a follow-on deliverable.

## Implementation sequence

| Phase | Deliverable and verification gate |
| --- | --- |
| 1 | Architecture, threat boundaries, billing rules and official references |
| 2 | Bun workspace, validated configuration, Better Auth, database migrations, local PostgreSQL and build checks |
| 3 | Owner-scoped rental records, ledger, receipts, reversals, reports and CSV, verified with two organizations and concurrent writers |
| 4 | Consent-aware outbox, Meta adapter and signed webhooks, with retry and crash tests |
| 5 | Independent encrypted daily/monthly backups, monitoring and a fresh PostgreSQL restore rehearsal |
| 6 | Adversarial integration tests and mobile browser flows |
| 7 | CI, production images, operator runbooks and launch gates |

## Trust boundaries

- The browser is untrusted. Better Auth authenticates a server-backed session, and the API checks the verified email and owner membership for each scoped request. Organization IDs are selectors. Scope all reads, writes and exports and return a uniform 404 for inaccessible IDs. Writes require an exact trusted Origin. The browser and API share an origin in both development and deployment.
- The database enforces same-organization relationships with composite keys. Application services enforce scoped reads. Initial rollout uses restricted application and worker roles, with migration and backup roles kept separate. RLS was evaluated and deferred because Better Auth and cross-organization workers use shared tables and separate privilege paths. Revisit transaction-local RLS before expanding staff or adding alternate query surfaces. Runtime roles cannot mutate confirmed payments, adjustments, or audit events.
- Lock the organization row for business mutations affecting rent or occupancy. At the initial workload this keeps idempotency, archive checks, allocations, reversals and lease transitions deterministic. PostgreSQL also excludes overlapping room lease intervals. Hot organizations may later use ordered per-lease locks after demonstrating the same invariants.
- A payment transaction inserts the payment, allocations, audit event and receipt outbox. Workers claim committed jobs with a durable lease. An expired send claim or ambiguous provider result becomes `UNCERTAIN` and requires operator reconciliation. Provider acceptance, delivery, read and local simulation are distinct. Callbacks authenticate the raw body with HMAC and correlate by sender and provider message ID or an opaque dispatch token.
- User-facing backup status contains only coarse platform health. Full archives contain all organizations. Storage, encryption and restore credentials remain in an independent operator boundary.

## WhatsApp template compatibility (13 November 2026)

The shared sender can explicitly select `META_TEMPLATE_LAYOUT=receipt_v1` for the
approved `rent_receipt_cash` and `rent_receipt_online` bodies. Their six/seven
positional values are tenant, numeric INR amount, owner/property/billing coverage,
room, committed payment ID, optional online reference, and actual IST payment
time. The template already supplies the `INR` prefix. Payment IDs come from the
claimed outbox row's existing relation, never from a dispatch claim token or an
invented receipt number. Receipt snapshots and financial records are unchanged.

The default `detailed_v1` layout retains the existing seven/eight-field contract.
Owner-connected senders continue to use that contract; selecting the shared
sender's layout cannot change another organization's template parameters. Local
configuration stays disabled until signed webhooks and controlled real delivery
are verified.

## Ledger rules

- Positive integer paise are used end to end. Per-record amounts are capped at ₹1,00,00,000 and aggregates use PostgreSQL bigint or JavaScript BigInt. API report totals use decimal strings when aggregated.
- UTC stores instants. Asia/Kolkata defines business dates and cash reporting months. Lease start is inclusive and move-out exclusive. A lease touching a month incurs the full monthly rent. The due date is the later of move-in and the agreed day clamped to that month. The due date itself is payable without overdue status.
- New rent terms apply from a future billing month without a generated charge. Existing obligations retain their amount and due date. Occupancy derives from lease dates. Security deposits are recorded as contract terms separately from rent.
- Advance payments can cover generated future months. An explicitly selected advance can retain unused value as a lease-scoped credit. Applying credit is audited, and a full reversal removes the effects of all allocations and remaining credit. Allocations cannot overpay a charge, cross leases, or exceed a payment. A fully reversed payment is retained with its original values. To replace a payment, reverse it and record a new one.
- Ending a lease preserves existing obligations. If advance charges fall outside the shortened lease, first reverse affected payments and void the unused charges with a reason. Voids preserve original rows. Monthly generation never recreates voided obligations.
- Idempotency keys identify submissions within an organization and are bound to a canonical request hash. Online references preserve leading zeroes. Reusing an active lease reference is flagged and requires explicit acknowledgement. Payment records indicate manual verification status. Cash received and amounts applied to a billing month are shown separately.

## Reliability hardening (7 November 2026)

The existing financial services and organization-scoped routes are retained. Verification uses a separate disposable local PostgreSQL cluster, never the configured Neon database. The initial audit baseline passed 18 tests with restricted API/worker roles, lint, typecheck, and the web build; current results are in [implementation status](implementation-status.md). The pinned Prisma 7 migration workflow remains in use; a Prisma 8 release candidate is not a reason to change a working major version.

- Add a durable, coarse worker heartbeat after a complete successful polling cycle. Owner health routes expose only the timestamp and their organization's billing jobs; worker identities, other organizations, and infrastructure secrets stay private. Failed billing retries require current owner membership, an organization lock, a reason, and an audit event. A separate operator monitor and deployable scheduler units detect stopped workers and overdue backups.
- Extend authenticated backup manifests to count every application/authentication table, preserving verification of older manifests through a fixed allowlist. Verify restored financial foreign keys, immutability triggers and balance constraints, and exercise storage corruption/failure handling. Daily/monthly scheduling is scoped to a hashed storage destination, so switching buckets cannot reuse an old destination's recovery point. Development adapter results never count as off-site protection.
- Reject PostgreSQL query parameters that override the connection target: runtime, migration, backup, restore and test guards must validate the exact host/database used by the driver. Invalid URLs must not expose embedded credentials through parser errors.
- After an isolated restore verifies the authenticated source manifest, quarantine potentially dispatched receipt rows as `UNCERTAIN` and append recovery audit events. Receipt reconciliation precedes worker activation: a historical `PENDING` state cannot prove that no message was sent after the recovery point. Financial records remain unchanged.
- Invalidate restored sessions and one-time verification/reset tokens after verifying the source snapshot. This prevents a restore from reviving previously revoked browser access or consumed links. Password/MFA records are preserved; operators must review security changes since the recovery point before cutover.
- Add regression coverage for historical lease changes, owner-scoped job visibility/retry, and backup storage failures. Re-run mobile browser acceptance and an encrypted isolated restore. External SMTP, Meta approval/delivery, private R2, hosting, alert delivery and provider PITR remain launch gates until exercised in their target environments.

### Official references checked

The OWASP multi-tenant guidance, pinned Prisma 7 PostgreSQL/driver adapter workflow, Better Auth security/session documentation, Hono origin protection, Bun environment/workspace documentation, PostgreSQL 18 dump/restore documentation, and Meta/Neon setup references were reviewed. Meta's documentation endpoint rate-limited retrieval in this session; live template approval, pricing and shared-sender eligibility must be verified by the operator. Provider docs do not prove that this project's account has a feature enabled.

## Product completion before deployment (14–15 November 2026)

Complete the existing v1 locally before resuming infrastructure activation. Keep
the current ledger, authentication, receipt snapshots and database constraints;
these additions require no financial-history rewrite or production migration.

- Expose the existing immutable audit trail through an owner-only, paginated
  screen. Category, record and IST date filters remain organization-scoped on the
  server, including when an owner supplies another organization's record ID.
  Never return provider credentials or authentication tokens in activity details.
  Password resets use Better Auth's dedicated post-reset callback: its bulk
  account-update database hook returns an update count rather than an account.
  Validate hook actor IDs before querying memberships, so missing IDs can never
  broaden an account audit to unrelated organizations.
- Show exact paise-based payment allocation totals before confirmation, including
  remaining money and explicitly retained advance credit. Changing the selected
  lease clears allocations. Backend validation and the existing transactional
  idempotency rules remain authoritative.
- Filter receipt history by delivery state and tenant/room search, provide an
  explicit refresh, and expose only coarse messaging configuration status.
  Configured, simulated, disabled and genuinely delivered states stay distinct.
- Report month-end occupancy (today for the current month), never future history.
  A room is observable from the earlier of its first recorded lease and its IST
  registration date, until archival. This supports backfilled leases without
  inventing vacancy before the room was recorded. Tenant/lease filters select
  active matching leases at each snapshot. All joins retain organization keys.
- Allow an explicit S3 signing region (`BACKUP_S3_REGION`, default `auto` for
  existing R2 setups). Validate endpoint URLs without echoing credentials and
  keep the storage destination identifier stable for existing valid endpoints.
  AWS/R2 upload verification continues to require both metadata and readback.

Container verification uses its own temporary Docker network and PostgreSQL 17
container, with no published ports or real service credentials. It applies the
same migrations and restricted grants, exercises API/worker health, runs the
Linux integration suite, and restores an encrypted backup inside the backup
image. Cleanup targets only the verification run's named resources. This is a
local development check and does not activate external infrastructure.

Verification uses disposable local PostgreSQL and mocked provider transport;
local results cannot establish off-site protection, email delivery or production
sender eligibility. Review the existing security boundaries against the
[OWASP multi-tenant guidance](https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html),
[PostgreSQL timezone semantics](https://www.postgresql.org/docs/current/functions-datetime.html),
[AWS SDK region configuration](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-region.html),
and [R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/).

## Sources and migration policy

Prisma 7 reads the direct migration URL from `prisma.config.ts` and uses a runtime adapter with a separate pooled URL. Commit SQL migrations and add PostgreSQL-specific constraints in SQL. Production uses `prisma migrate deploy` for the pinned Prisma major. Backups use direct connections and custom-format dumps. Apply new migrations to a disposable database and verify a restore before deploying with live records.

- [Bun workspaces](https://bun.com/docs/pm/workspaces) · [Hono on Bun](https://hono.dev/docs/getting-started/bun) · [Hono CSRF scope](https://hono.dev/docs/middleware/builtin/csrf)
- [Prisma 7 and PostgreSQL](https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/postgresql) · [Better Auth Hono integration](https://better-auth.com/docs/integrations/hono) · [Better Auth rate limiting](https://better-auth.com/docs/concepts/rate-limit)
- [OWASP multi-tenant security](https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html) · [PostgreSQL locking](https://www.postgresql.org/docs/current/explicit-locking.html) · [PostgreSQL pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html)
- [Meta WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api/) · [Neon restore window](https://neon.com/docs/introduction/restore-window) · [Cloudflare R2 bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/)
