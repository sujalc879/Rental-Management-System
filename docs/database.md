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

The additive `20261107000000_worker_health` migration creates `WorkerHeartbeat` and adds a nullable hashed `BackupRun.storageId` plus its lookup index. Existing financial and authentication records are unchanged. Worker health is platform-wide coarse operational metadata; billing jobs and retries remain organization-scoped. The API can read the heartbeat and retry failed billing jobs but cannot change the heartbeat. Reapply runtime grants after this migration. `scripts/db/monitor-grants.sql` gives a separate operator monitor only health/status columns, without tenant contact details, receipt snapshots, credentials, or financial history.

PostgreSQL connection targets must appear in the URL authority and database path. Query parameters that override host, database, user or service are rejected so runtime, migration, test and recovery guards all identify the actual destination. TLS and channel-binding parameters remain supported. Invalid URL errors do not print connection credentials.

## Owner activity and occupancy reporting

The activity endpoint scopes every query to the validated organization and selects a fixed response shape. Filter dates represent inclusive Asia/Kolkata business days, converted to an inclusive UTC start and exclusive next-day end. Activity metadata is restricted to an allowlist of scalar financial/security details; arbitrary nested values and credentials are not returned. The UI has no write or delete operation for audit history.

Occupancy reports join organization keys throughout and use actual lease intervals (inclusive move-in, exclusive move-out). Past months are snapshots on their final calendar day; the current month uses today's IST date; future snapshots are omitted. A room enters observable history on the earlier of its IST registration date and its first recorded lease, supporting historical lease entry without inventing earlier room availability. Rooms archived by the end of the snapshot day are excluded. Tenant and lease filters include rooms with matching active leases at that snapshot, so other occupants are not misreported as vacant rooms. Rent/payment filters do not change occupancy counts. These read-only additions require no schema migration.

Use `bun run db:validate`, `bun run db:generate`, and `bun run db:deploy`. Create reviewed SQL migrations on a disposable database with `prisma migrate dev --create-only`. Custom SQL in the integrity migration installs `btree_gist`, checks and triggers outside Prisma's schema language. Apply and verify every migration on staging and re-run a restore before promoting changes. [Prisma 7 PostgreSQL setup](https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/postgresql)
