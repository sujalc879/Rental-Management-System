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

## Ledger rules

- Positive integer paise are used end to end. Per-record amounts are capped at ₹1,00,00,000 and aggregates use PostgreSQL bigint or JavaScript BigInt. API report totals use decimal strings when aggregated.
- UTC stores instants. Asia/Kolkata defines business dates and cash reporting months. Lease start is inclusive and move-out exclusive. A lease touching a month incurs the full monthly rent. The due date is the later of move-in and the agreed day clamped to that month. The due date itself is payable without overdue status.
- New rent terms apply from a future billing month without a generated charge. Existing obligations retain their amount and due date. Occupancy derives from lease dates. Security deposits are recorded as contract terms separately from rent.
- Advance payments can cover generated future months. An explicitly selected advance can retain unused value as a lease-scoped credit. Applying credit is audited, and a full reversal removes the effects of all allocations and remaining credit. Allocations cannot overpay a charge, cross leases, or exceed a payment. A fully reversed payment is retained with its original values. To replace a payment, reverse it and record a new one.
- Ending a lease preserves existing obligations. If advance charges fall outside the shortened lease, first reverse affected payments and void the unused charges with a reason. Voids preserve original rows. Monthly generation never recreates voided obligations.
- Idempotency keys identify submissions within an organization and are bound to a canonical request hash. Online references preserve leading zeroes. Reusing an active lease reference is flagged and requires explicit acknowledgement. Payment records indicate manual verification status. Cash received and amounts applied to a billing month are shown separately.

## Sources and migration policy

Prisma 7 reads the direct migration URL from `prisma.config.ts` and uses a runtime adapter with a separate pooled URL. Commit SQL migrations and add PostgreSQL-specific constraints in SQL. Production uses `prisma migrate deploy` for the pinned Prisma major. Backups use direct connections and custom-format dumps. Apply new migrations to a disposable database and verify a restore before deploying with live records.

- [Bun workspaces](https://bun.com/docs/pm/workspaces) · [Hono on Bun](https://hono.dev/docs/getting-started/bun) · [Hono CSRF scope](https://hono.dev/docs/middleware/builtin/csrf)
- [Prisma 7 and PostgreSQL](https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/postgresql) · [Better Auth Hono integration](https://better-auth.com/docs/integrations/hono) · [Better Auth rate limiting](https://better-auth.com/docs/concepts/rate-limit)
- [OWASP multi-tenant security](https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html) · [PostgreSQL locking](https://www.postgresql.org/docs/current/explicit-locking.html) · [PostgreSQL pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html)
- [Meta WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api/) · [Neon restore window](https://neon.com/docs/introduction/restore-window) · [Cloudflare R2 bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/)
