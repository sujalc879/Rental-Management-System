# Implementation and launch status

Originally verified 7 November 2026 against the requirements in `AGENTS.md`; the latest local product verification is recorded below for 15 November 2026. This is a working local implementation with production integrations unconfigured. It is not a production-readiness declaration.

## What is implemented

| Area | Implementation and evidence |
| --- | --- |
| Identity and tenancy | Controlled owner provisioning, verified email, password reset/change, secure server-backed sessions, TOTP and revocation; verified owner membership on scoped routes and transactional writes. Two-owner adversarial tests cover resources, reports, exports, notifications and billing retries. |
| Rental records | Multiple properties/rooms, normalized tenant contacts and opt-in, leases, occupancy derived from dates, overlap prevention, archives and historical records. Room rent changes do not rewrite agreed terms or monthly charges. |
| Accounting | Integer paise, idempotent monthly obligations, partial/multiple-month payments, advance credits, actual UTC payment instants presented in IST, required string online references, duplicate warnings, auditable reversals and database immutability/balance constraints. Cash received and rent attributed to a billing month have separate report totals. |
| Owner interface | Mobile navigation, guided initial setup, rental forms/history, ledger, payment entry and printable receipt, reports/CSV, notification history/retry, organization/account/MFA settings and coarse backup/processing health. |
| Messaging | Atomic payment/allocation/audit/outbox writes; durable claims, bounded safe retries, consent rechecks, genuine Meta adapter, signed/idempotent callbacks and separate accepted/sent/delivered/read/uncertain/simulated states. Shared and operator-managed organization sender configuration are supported. Test-account delivery was confirmed on 13 November; production sender activation remains unverified. |
| Jobs and monitoring | Durable successful-cycle heartbeat, owner-scoped failed billing visibility and audited retry, a read-only operator monitor role and alert command. Production workers require an external HTTPS heartbeat destination. Linux service/timer templates provide persistent worker, independent backup scheduling and monitors. |
| Recovery | Consistent snapshot and custom-format dump, streaming AES-256-GCM, checksum/readback, private storage interface, separate daily/monthly keys and destination-specific scheduling. Restores authenticate counts for all 25 application tables, inspect constraints/triggers/balances, hold potentially dispatched receipts for reconciliation and expire restored sessions/one-time tokens. |
| Delivery tooling | Four reviewed Prisma migrations, explicit production frontend build, API/worker/backup Docker targets, CI checks, environment example, grant scripts, operations runbooks and a reproducible isolated verification command. |

## Messaging follow-up (13 November 2026)

The Meta developer test account's cash and online utility templates were verified
as approved, and a backward-compatible shared-sender layout was added for their
six/seven positional values. Six payload tests and fourteen isolated PostgreSQL
integration tests passed, along with lint and TypeScript checks. A separate live
test sent two clearly labelled receipts to the operator's verified test number;
signed Meta callbacks confirmed both as `READ`. Test payments existed only in a
disposable local database. The temporary tunnel was stopped, normal messaging
remains disabled, and production sender credentials, stable hosting/webhooks and
real tenant consent remain launch requirements. See [WhatsApp setup](whatsapp-setup.md).

## Local product completion (15 November 2026)

Deployment work is deferred at the operator's request. This pass completes and
verifies remaining local v1 product flows without changing the configured Neon
database or enabling real messages, mail, off-site backups or cloud resources.

| Addition | Result |
| --- | --- |
| Payment entry | Exact allocation/remaining/advance-credit preview, explicit oldest-unpaid-rent allocation, over-allocation and precision checks, and cleared allocations when switching leases. |
| Owner activity log | Read-only screen with category, record, text and inclusive IST date filters; stable pagination; fixed organization-scoped response and scalar metadata allowlist. |
| Account-security audit | Password reset now uses Better Auth's dedicated completion callback rather than treating a bulk update count as an account. Regression checks require exactly one reset event, no duplicate event for a reused token, a change-password event and no unrelated organization events. Hook actor IDs are validated before membership queries. |
| WhatsApp history | Tenant/room/property/payment search, all delivery-state filters, manual refresh and coarse setup status. No phone numbers, snapshots, tokens or provider IDs are returned by the list. Configuration is never reported as delivery. |
| Occupancy reports | Month-end/today snapshots based on recorded room availability, historical leases, exclusive move-out and archival; no future history. Tenant/lease filters cannot turn unrelated occupants into apparent vacancies. |
| Backup storage | Explicit AWS S3 signing region with the existing R2 `auto` default; malformed and credential-bearing endpoints fail without printing the supplied secrets. Metadata and full readback checks are retained. |
| Container verification | New `bun run verify:containers` creates only a private temporary PostgreSQL 17 environment, refuses remote Docker engines, checks runtime roles/API/worker/frontend, runs Linux tests and rehearses encrypted recovery. Cleanup targets only its own resources. |

The complete local command passed:

```sh
TEST_PG_PORT=55446 E2E_PORT=4186 \
PLAYWRIGHT_BROWSERS_PATH=/private/tmp/rental-playwright-01a1b3f8 \
bun run verify:local --with-browser
```

- All four migrations applied with no schema drift, using restricted API/worker/backup roles.
- Lint, strict TypeScript checks and the production frontend build passed.
- **47 tests in 10 files passed**, including the new audit, receipt filtering,
  fractional allocation, occupancy, endpoint-validation and S3-region cases.
- The expanded mobile Playwright flow passed: two rooms and leases, allocation
  reset when switching leases, cash/online payments, payment activity, receipt
  filters, occupancy reports, private exports, settings and sign-out. Screenshots
  of the new views were inspected.
- An actual encrypted local restore verified all 25 application tables,
  including **17 organizations, 17 payments, 19 allocations and one reversal**.
  Five potentially dispatched receipts were quarantined; 15 restored sessions
  were invalidated. This tiny local rehearsal took about 0.3 seconds and does
  not establish a production RTO or off-site protection.
- `bun audit --audit-level moderate` reported no vulnerabilities among 394 packages.

The initial native Linux ARM64 container check passed with PostgreSQL 17. The
final source, including the password-audit regression, also passed the full
Linux amd64 check under Docker Desktop emulation:

```sh
DOCKER_DEFAULT_PLATFORM=linux/amd64 bun run verify:containers
```

All three image targets built. The API served the built frontend and enforced
authentication, and the worker passed monitoring using restricted roles. All
47 Linux tests passed. The backup image restored 15 organizations, 15 payments,
17 allocations and one reversal, verifying all 25 application tables before
quarantining five receipts and invalidating 15 sessions. The encrypted local
restore took about 2.4 seconds under emulation. Temporary test containers,
network and image tags were removed. This verifies the image architecture used
by `t3.small`, not an actual EC2 deployment. GitHub-hosted CI, native systemd
installation and real off-site storage remain separate checks.

The operator reports that an EC2 instance and Docker installation are prepared;
the application has not been deployed by this verification work. Production
SMTP, actual off-site storage/retention/restore, external alerts, HTTPS, Neon role
and migration configuration, PITR and the live WhatsApp sender/consent still need
their target-environment checks when deployment resumes.

## Phase checklist

- [x] Research/architecture: trust boundaries, financial policies, pinned compatible stack, migration and recovery decisions documented. Some Meta documentation retrieval was rate-limited; account-specific approval, pricing and policy verification remains external.
- [x] Foundation: Bun/React/Hono/Prisma/Better Auth/PostgreSQL, strict TypeScript, migrations and restricted role checks run locally.
- [x] Core rentals and financial records: working owner flows and security/accounting/history regression coverage.
- [x] Messaging implementation and local/provider-stub failure/callback tests.
- [x] Backup implementation, storage failure/tamper tests and an actual isolated local encrypted restore.
- [x] Hardening: authorization/rate-limit/immutability tests, mobile browser acceptance and production web build.
- [x] Deployment preparation: Docker targets, CI definition, independent scheduler/monitor templates and runbooks.
- [ ] Activate and verify real SMTP, Meta, private off-site storage, alert delivery, target hosting/PITR and off-site restore. Production launch is blocked on these checks.

## Earlier verification results (7 November 2026)

The complete command was run successfully with a fresh temporary PostgreSQL cluster on loopback port 55441 and a separate browser-test API on port 4179:

```sh
TEST_PG_PORT=55441 E2E_PORT=4179 \
PLAYWRIGHT_BROWSERS_PATH=/private/tmp/rental-playwright-01a1b3f8 \
bun run verify:local --with-browser
```

`PLAYWRIGHT_BROWSERS_PATH` selected the temporary browser installation for this session; it can be omitted on other machines. The verification command creates and removes only its own test cluster, including isolated restored databases. It does not migrate, seed, reset or change the configured Neon database.

| Check | Result |
| --- | --- |
| Prisma validate/generate | Passed with Prisma 7.10.1. |
| Migrations | All four applied successfully to a fresh local database. |
| Schema drift | No difference detected between migrated schema and Prisma schema. |
| Worker + monitor | Real worker successful-cycle heartbeat; monitor succeeded with a dedicated role limited to health/status columns. |
| Lint and strict typecheck | Passed. |
| Vitest | 32 tests passed in 8 files, including actual PostgreSQL integrations with restricted API/worker roles. |
| Production build | Passed; explicitly sets `NODE_ENV=production`, including when invoked by the test workflow. |
| Mobile Playwright | Passed: login, initial setup, property/room/tenant/lease, cash and online payments, receipt/reference, paid ledger, scoped export denial, processing settings and logout. |
| Dependency audit | No reported vulnerabilities among 394 checked packages. |
| Encrypted recovery | Daily and monthly objects verified; monthly archive restored to a new isolated database; all 25 application-table counts and representative ledger data validated. |

The final clean restore verified **10 organizations, 12 payments, 14 allocations and one reversal**. One receipt row was put on an audited reconciliation hold. Eight restored sessions were invalidated; no pending one-time tokens existed in that snapshot. A dedicated integration test creates a one-time token and verifies session/token invalidation and idempotency. The local backup/restore portion took approximately 0.3 seconds for this small dataset; this does not establish a production RTO. Temporary local archives were removed after the rehearsal, and development results do not report off-site protection.

Runtime verification used the workspace Bun 1.4.4, Node.js 24.19.0, PostgreSQL/pg_dump 18.3 and the matching Playwright Chromium build. The globally installed Bun launcher is 1.4.0. PostgreSQL 17 remains the supplied Docker/CI target. Docker execution could not be verified locally because the Docker daemon was not running; the CI definition includes builds for all three image targets. Linux systemd units have not been installed or exercised on this macOS host. `pg` emits a concurrent-query deprecation warning during integration/browser tests; it was not suppressed, and all checks pass on pinned pg 8. Review this before a pg 9 upgrade.

## Required external actions

1. **Upgrade the intended database deliberately.** Review `20261107000000_worker_health`, run `bun run db:generate` and `bun run db:deploy` with its direct migration URL, reapply runtime/monitor grants, then restart API and worker. This additive migration creates heartbeat metadata and a nullable backup storage identifier; it does not rewrite financial history. No migration was applied to the configured Neon database by this verification run.
2. **Production identity and HTTPS.** Configure the real origin, reverse proxy/IP header, SMTP sender and secure secrets. Verify actual email delivery, setup/reset links, session revocation and MFA in staging.
3. **Meta activation.** Complete legitimate business/sender onboarding, confirm the shared-sender arrangement, approve cash/online utility templates, obtain recipient opt-in and configure credentials plus signed public webhooks. Verify actual accepted, delivered/read and failure outcomes and current billing/rate limits. A personal WhatsApp number alone does not activate the integration.
4. **Off-site backup protection.** Configure an independent private R2/S3 bucket, scoped credentials and a separately managed encryption key. Set daily retention to 35 days and monthly retention to at least 400 days, with available prefix locks/immutability controls. Enable the independent scheduler, verify failure/overdue alerts and complete a restore from an actual off-site archive before accepting real financial records in production.
5. **Operational monitoring.** Configure external heartbeat and alert destinations using the documented JSON POST contract; verify actual operator notification delivery. Install the reviewed Linux units or equivalent persistent managed services/schedules, and exercise a missing-worker/missed-backup drill. Provide a read-only monitoring connection, not storage/encryption secrets, to monitor processes.
6. **Provider/deployment verification.** Confirm the selected Neon's actual PostgreSQL major, pooling/direct URLs, least-privilege roles, supported extensions and plan-specific PITR window. Match backup client versions, run Docker/CI in the target environment and rehearse cutover. Agree operational RPO/RTO and incident ownership; the documented 24-hour daily-backup RPO and four-hour RTO are targets, not measured production guarantees.

Current local configuration has SMTP unconfigured, WhatsApp disabled, backups disabled, no off-site destination/key and no external worker heartbeat/alert destinations. Local email and development storage adapters remain explicitly labeled. No production service was enabled, no real tenant messages were sent and no real off-site backup was claimed.
