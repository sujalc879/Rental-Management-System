# Database

PostgreSQL uses UUID identifiers and Prisma ORM 7. Better Auth owns `User`, `Session`, `Account`, `Verification`, `TwoFactor`, and `RateLimit`. The operator provisions a user, credential account, organization, owner membership and audit event in one transaction. Session and verification tables are independent of owner-scoped business routes.

| Area | Tables and constraints |
| --- | --- |
| Tenancy | `Organization`, `Membership`, `Property`, `Room`, `Tenant`, `Lease`. Scoped foreign keys enforce organization ownership along each parent chain. Room names are unique per property. A GiST exclusion constraint prohibits overlapping half-open leases on a room. |
| Billing | `LeaseTerm`, `RentCharge`, `BillingJob`. Terms and charges use the first day of a month as the period. Per-lease uniqueness prevents duplicate obligations. A charge can only be voided once while its effective allocations are zero. |
| Payments | `Payment`, `Allocation`, `PaymentReversal`, `CreditApplication`. Allocations have same-organization and same-lease foreign keys in both directions. A SQL trigger rejects over-allocation of either the payment or the charge and disallows allocations to voided charges or reversed payments. Unique idempotency keys and fingerprints bind requests. |
| Messaging | `NotificationOutbox`, `WhatsAppSender`, `WebhookEvent`. One logical receipt per payment, unique dispatch correlation token, and unique provider message ID per sender. Status and scheduling indexes support polling and history. |
| Operations | `AuditLog`, `BackupRun`. Audit and financial rows are append-only. Backup rows retain verified ciphertext size, checksum and storage keys for operators. The API role reads only backup status and timestamps. |

Application writers serialize rent mutations per organization through a row lock. Payment balances derive from immutable allocations excluding reversed payments. A separate reversal retains its actor, time and reason. Report rollups use integer or bigint arithmetic. Room and tenant archive operations retain all links. `scripts/db/grants.sql` limits runtime writes independently of the application routes.

Use `bun run db:validate`, `bun run db:generate`, and `bun run db:deploy`. Create reviewed SQL migrations on a disposable database with `prisma migrate dev --create-only`. Custom SQL in the integrity migration installs `btree_gist`, checks and triggers outside Prisma's schema language. Apply and verify every migration on staging and re-run a restore before promoting changes. [Prisma 7 PostgreSQL setup](https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/postgresql)
