# Rental Management SaaS

> **Codex implementation specification — production-grade, multi-tenant rental management platform**  
> **Project status:** Build specification; implementation and external integrations must be verified in the repository.  
> **Primary market:** India · **Display currency:** INR (₹) · **Business timezone:** Asia/Kolkata

This `README.md` is the **source-of-truth product and engineering specification** for the repository. It is intended to live at the project root and be read **before Codex makes architectural or implementation decisions**.

**Mission:** Build, test, document, and prepare to deploy a reliable SaaS application that helps property owners manage rooms, tenants, leases, monthly rent, cash/online payment records, WhatsApp receipts, reports, and encrypted recoverable backups. The initial customer has **4 rented rooms**, but the architecture must support **many independent property owners** without mixing their data.

> **Important:** This document defines requirements; it does **not** imply the features have already been implemented, the backups are active, WhatsApp is connected, or the system is ready for production. Codex must verify and report actual implementation status.

## Contents

1. [Instructions to Codex](#1-instructions-to-codex)
2. [Product context and scope](#2-product-context-and-scope)
3. [Non-negotiable invariants](#3-non-negotiable-invariants)
4. [Preferred stack and system architecture](#4-preferred-stack-and-system-architecture)
5. [Multi-tenant isolation and authentication](#5-multi-tenant-isolation-and-authentication)
6. [Properties, rooms, tenants, and leases](#6-properties-rooms-tenants-and-leases)
7. [Monthly rent ledger](#7-monthly-rent-ledger)
8. [Payment recording and financial integrity](#8-payment-recording-and-financial-integrity)
9. [WhatsApp payment notifications](#9-whatsapp-payment-notifications)
10. [Dashboards, reporting, and UX](#10-dashboards-reporting-and-ux)
11. [Database design requirements](#11-database-design-requirements)
12. [Backups and disaster recovery](#12-backups-and-disaster-recovery)
13. [Audit logging and security](#13-audit-logging-and-security)
14. [Background jobs and operational reliability](#14-background-jobs-and-operational-reliability)
15. [Testing and acceptance scenarios](#15-testing-and-acceptance-scenarios)
16. [Repository structure](#16-repository-structure)
17. [Deployment and operations](#17-deployment-and-operations)
18. [Implementation phases](#18-implementation-phases)
19. [Definition of done](#19-definition-of-done)
20. [External setup, assumptions, and deliverables](#20-external-setup-assumptions-and-deliverables)

---

## 1. Instructions to Codex

You are acting as a **Principal Software Architect, Senior Full-Stack Engineer, Database Architect, Security Engineer, and DevOps Engineer**.

Your job is to **research, design, implement, test, document, and prepare for deployment a production-grade application**, not a tutorial, basic CRUD demo, mock dashboard, or frontend-only prototype.

### Engineering priorities, in order

1. Security and strict separation between property owners.
2. Integrity and correctness of valuable financial records.
3. Automated backups, observability, and tested data recovery.
4. Accurate rent accounting and immutable financial history.
5. Reliable and compliant WhatsApp notifications.
6. Accessible, excellent mobile-first UX.
7. Maintainable architecture and scalability.
8. Reasonable setup and ongoing infrastructure costs.

### How to work in this repository

1. **Inspect the existing repository first.** Reuse sound code, respect existing structure when appropriate, and avoid destructive rewrites.
2. **Research up-to-date official documentation** for the latest stable, mutually compatible stack versions, including Bun, Hono, Prisma, Better Auth, Neon, Meta WhatsApp Cloud API, and PostgreSQL backup tooling. Do not guess APIs or use outdated Prisma setup/migration commands.
3. Document the architecture, threat boundaries, core financial rules, key decisions, and trade-offs in `docs/architecture.md` **before** implementing major features.
4. Implement in the phases specified in this README. **Do not stop after planning or scaffolding.** Deliver working features and meaningful tests.
5. Run relevant lint, typecheck, tests, migrations, and build steps after each phase. Fix errors; do not hide, skip, or suppress failing tests.
6. If real service credentials or approvals are unavailable, build a **clearly labeled local development adapter**, document the missing configuration, and leave production integration **unconfigured**, not falsely “successful.”
7. For a genuinely blocking business/security decision, ask a focused question. Otherwise choose a conservative default, document it, and continue.
8. Avoid irreversible operations on production data, production resources, or infrastructure without explicit authorization. Never seed or reset production databases.
9. Before completion, provide an accurate report of what was implemented, what tests passed, what could not be verified, all required external actions, and operational risks.

**Research topics:** OWASP multi-tenancy and application security; Prisma/PostgreSQL migration and pooling strategy; Neon backup/PITR features and retention; official Meta messaging templates, recipient consent, webhook authentication, delivery statuses, billing and rate limits; durable jobs and disaster recovery.

---

## 2. Product context and scope

### The problem

One property owner has four rented rooms. They need to track, for every room:

- Current occupant and agreed monthly rent.
- Rent due date and payment status for each billing month.
- Fully paid, partially paid, unpaid, and overdue months.
- Amount collected, outstanding balance, and complete rent/payment history.
- Actual payment **date and time**.
- Payment mode: **Cash** or **Online**.
- Online transaction/reference ID when the mode is Online.
- WhatsApp confirmation to the right tenant after the owner records a valid payment.

### The future product

The same website will serve multiple unrelated property owners:

| Example organization | Rooms | Data visibility |
|---|---:|---|
| Owner A | 4 | Only Owner A's properties, tenants, finances, and messages |
| Owner B | 12 | Only Owner B's properties, tenants, finances, and messages |
| Owner C | 30 | Only Owner C's properties, tenants, finances, and messages |

Every owner uses the same application but has **independent organization-scoped records**. Do not cap owners at four rooms. Support owners managing **multiple properties/buildings**.

### Vocabulary

- **Organization:** An independent property-owner account/business boundary. This is a SaaS tenant.
- **Owner:** An authenticated person authorized to manage their organization.
- **Tenant / occupant:** A person renting a physical room. **Not** an authenticated SaaS organization.
- **Lease:** Time-bounded agreement connecting a tenant to a room, including rent terms.
- **Rent charge:** A monthly amount owed for a lease and billing period.
- **Payment:** Money the owner reports receiving; may cover one or several charges.
- **Payment allocation:** Amount of a payment applied toward a specific rent charge.

### Version 1 scope

- Owner-only web accounts. **Tenants do not need accounts** in v1.
- Multi-organization platform, properties, rooms, tenants, leases, charges, payments, notifications, and reports.
- Owners **record** cash/online payments. The website does **not** automatically collect money or verify a manually entered UPI/reference ID. Payment gateway integration is a future feature.
- A hybrid WhatsApp sender architecture: **shared platform business sender initially**, with support for owner-connected senders later. Actual sending depends on Meta's permissions, consent, and approved templates.

---

## 3. Non-negotiable invariants

These rules take precedence over convenience, aesthetics, and feature speed.

1. **Organization isolation:** Owner A must never view, update, delete, export, or trigger notifications for Owner B's records—not via changed URLs, IDs, API payloads, searches, charts, files, background jobs, or caches.
2. **Server-side authorization:** An incoming `organizationId` is never proof of access. Determine access through authenticated session + verified organization membership, then enforce it for every operation.
3. **Financial correctness:** Use integer **paise** or a properly constrained database Decimal, **never floating-point money**. Maintain exact allocations and totals.
4. **Preserved history:** Never silently overwrite or destructively delete confirmed financial records. Use explicit, auditable reversals/corrections.
5. **Atomic payment handling:** Save payment, allocations, audit event, and WhatsApp notification-outbox entry in **one database transaction**.
6. **Independent messaging:** A WhatsApp outage may delay receipt delivery but must **never** roll back, erase, or duplicate an otherwise valid payment.
7. **No phantom messaging:** An API acceptance is not proof of delivery. Mocked notifications cannot be reported as delivered. Never send a receipt for an uncommitted payment.
8. **Recoverability:** At least daily encrypted independent off-site backups, separately preserved monthly recovery points, automated health monitoring, and a **tested restore** before production launch.
9. **Least privilege:** No hardcoded secrets, no public database backups, no admin cross-organization access by default, no production seed/reset shortcuts.
10. **Honest operational state:** Do not present unconfigured integrations, untested restores, or incomplete features as production-ready.

---

## 4. Preferred stack and system architecture

Use the following unless current official documentation reveals a clearly better compatible alternative. Explain material deviations in `docs/architecture.md`.

| Layer | Preference |
|---|---|
| Frontend | React, TypeScript strict mode, Vite |
| Styling | Tailwind CSS, shadcn/ui, Lucide icons |
| Client routing/data | React Router, TanStack Query |
| Forms/validation | React Hook Form, Zod |
| Backend | Bun runtime, Hono, TypeScript, Zod; OpenAPI where practical |
| Database | PostgreSQL; Neon preferred in production, local Docker PostgreSQL |
| ORM/migrations | Prisma with version-correct setup and production migration workflow |
| Authentication | Better Auth + Prisma, secure server-backed session handling, email verification/recovery, MFA support |
| WhatsApp | Official Meta WhatsApp Business Cloud API |
| Backups | Consistent encrypted PostgreSQL backup archives + private Cloudflare R2 (or independently secured S3-compatible storage) |
| Testing | Vitest, Playwright, PostgreSQL-backed integration tests |
| Deployment | Docker-compatible infrastructure, CI, separate persistent worker/scheduler when needed |

Prefer **a modular monolith and durable worker**, not early microservices. Avoid adding Redis if PostgreSQL can safely support the modest initial job volume. Consider connection pooling, migration connections, and the hosting provider's lifecycle when selecting job infrastructure.

### Conceptual architecture

```text
Owner's Browser (React + Vite)
             |
     HTTPS / secure session
             |
       Hono API (Bun)
        |       |    \
   Better Auth  |     \--> Organization-scoped exports
        |       |
        +--> PostgreSQL (Prisma)
                |-- Organizations / memberships
                |-- Properties / rooms / tenants / leases
                |-- Monthly charges / payments / allocations
                |-- Audit log / notification outbox
                |
                +--> Durable notification worker
                         |--> Official Meta WhatsApp Cloud API
                         +<-- Signed delivery-status webhooks

Independent scheduled backup process
     |--> Consistent PostgreSQL backup
     |--> Authenticated encryption + checksum
     +--> Private independent off-site object storage (R2)

Operations: monitoring, failures/alerts, backups, restore drills, CI
```

---

## 5. Multi-tenant isolation and authentication

### Organization model

- Each organization has an immutable UUID-like identifier.
- Each user is associated with an organization via a verified membership; structure this to support future staff roles.
- Every organization-owned entity has explicit organization ownership, including rooms, tenants, leases, charges, payments, allocations where appropriate, receipts, notification history, and exports.
- A request's effective organization is derived from **server-validated membership/session**. On organization switching, validate the requested membership rather than trusting client state.
- Scope reads, writes, aggregates, counts, reports, exports, notification operations, and job execution.
- Verify IDs supplied for related records all belong to the same organization.
- Apply composite foreign keys/constraints and transactional checks to prevent cross-organization relationships.
- Consider PostgreSQL Row-Level Security as defense in depth. If used, define a restricted runtime role and safe transaction-scoped tenant context, avoiding leaked session state through pooled connections. RLS does **not** replace application authorization.
- UUIDs or opaque IDs do **not** replace authorization.

### Authentication and account features

- Controlled owner registration/invitations initially, with a path to verified self-service registration.
- Login/logout; email verification; password recovery/reset; password change.
- Session expiration/revocation and account settings.
- Secure HttpOnly, Secure, SameSite session cookies in production.
- CSRF protection for relevant session-authenticated requests.
- Correct trusted-origin/CORS and HTTPS setup.
- Authentication endpoint rate limiting, generic anti-enumeration responses, and secure password hashing through the auth library.
- Configurable/optional MFA, ideally TOTP, with a sensible path to mandate it later.
- Security-sensitive actions must be authorized on the server.

**Required adversarial test:** Seed Owner A and Owner B with different organizations. Verify Owner A cannot read, create, edit, reverse, delete/archive, export, or send notifications for any Owner B resource, even after manipulating IDs in routes, request bodies, queries, or batch payloads. Check jobs and exports as well as ordinary CRUD.

---

## 6. Properties, rooms, tenants, and leases

### Properties

Allow an owner to create and manage one or multiple buildings/properties, including optional display name, address, and notes. All belong to the current organization.

### Rooms

Owners must be able to:

- Create, edit, view, list, filter, and **archive** rooms.
- See occupancy and current lease.
- View room history and all historical tenants/payments for authorized records.

Suggested fields: room ID, organization/property ID, room name/number, optional address/notes, current suggested rent, suggested due day, lifecycle status, and created/updated timestamps. Occupancy must follow actual valid leases, not an easily desynchronized manual flag.

Prevent overlapping active leases on the same room. Archiving a room must not remove its historical ledger.

### Tenants (occupants)

Store tenant ID, organization ID, full name, normalized phone and WhatsApp contact, optional email, notes, lifecycle status, consent status/timestamp/source, and timestamps.

A tenant may change rooms or leave; their history must remain visible to the authorized owner. Avoid unnecessary collection of sensitive identity documents in v1.

### Leases

Separate leases from rooms and tenants. Include organization ID, room ID, tenant ID, move-in date, optional move-out date, monthly agreed rent, due day, optional security deposit, status, and effective contractual terms.

**Historical agreement values are snapshots.** Changing a room's displayed rent later must not rewrite amounts from an old lease or its prior monthly charges. Handle rent changes prospectively through auditable agreement updates/new effective terms.

---

## 7. Monthly rent ledger

Create monthly obligations per active lease for applicable billing periods.

For example, for Room 101, agreed rent ₹8,000:

| Rent month | Status |
|---|---|
| January 2026 | Paid |
| February 2026 | Paid |
| March 2026 | Partially paid |
| April 2026 | Unpaid |
| May 2026 | Overdue |

Requirements:

- Period identifier like `2026-11`; model year/month explicitly or with an unambiguous normalized period.
- Due date, charge amount, amount allocated, and derived outstanding balance.
- Paid/partial/unpaid/overdue status computed consistently from ledger amounts and due dates.
- Support partial, late, advance, and multiple-month payments.
- One payment may be allocated across multiple monthly charges; one charge may receive multiple payments.
- Generate monthly charges idempotently, with database uniqueness for `(lease, billing month, charge type)` as appropriate.
- Document default treatment for mid-month move-ins/outs, due dates that fall on 29th–31st, advance payments, overpayments, and security deposits; use conservative rules and do not silently invent fees.
- Preserve historical charges and allocated payments after move-out or lease termination.
- Use database transactions for ledger-affecting mutations.
- Record operational instants in UTC, but render business dates in **Asia/Kolkata**, with clearly defined month-boundary and billing policies.
- Never use floating-point arithmetic for currency.

The source of truth is the **financial ledger**, not a mutable `isPaid` flag.

---

## 8. Payment recording and financial integrity

### Required payment data

- Stable payment ID, organization ID, tenant, lease/room relationship.
- Exact amount received, in INR-compatible exact numeric representation.
- **Actual payment date and time** separately from creation timestamp.
- Payment mode: `CASH` or `ONLINE`.
- **Required string** transaction/reference ID for online payments (preserve leading zeros).
- Allocations to one or more rent months.
- Optional owner notes, recording user ID, timestamps, audit trail.
- Explicit source/verification status: manual records are **not** independently bank-verified.

Avoid accidentally treating a manual reference as a trustworthy bank settlement. Normalize reference strings carefully; avoid global uniqueness constraints that would reject legitimate different-provider transactions unless justified.

### Payment workflow

1. Owner chooses tenant or room; backend verifies organization access.
2. Owner selects one or more rent months.
3. UI shows due, allocated, and remaining amounts.
4. Owner enters the amount and payment method.
5. Online method requires a payment reference ID.
6. Owner enters/confirms actual date/time (IST display).
7. Owner confirms the receipt.
8. Backend validates amounts, IDs, permissions, business rules, and an idempotency key.
9. **One database transaction** records the payment, allocations, audit event, and notification outbox entry.
10. UI confirms the financial record immediately and **separately** shows pending/failed/successful notification status.

### Guarantees

- Handle double-clicks, retries, and concurrency without duplicate charges or payments.
- Validate and transactionally enforce that sum of payment allocations equals the applicable allocated portion, with documented treatment of any unallocated advance/credit.
- Prevent negative balances and over-allocation unless an explicit, well-defined credit mechanism exists.
- Use controlled, **auditable reversal/adjustment** operations rather than deleting or overwriting confirmed payment records.
- Correct totals and ledger states after reversal; do not double-count reversed payments.
- Prevent accidentally duplicate online/manual entries using idempotency and appropriate duplicate warnings/constraints.
- Never tie payment success to the availability of WhatsApp.

---

## 9. WhatsApp payment notifications

### Provider and strategy

Use the **official Meta WhatsApp Business Cloud API**. Never use unofficial WhatsApp Web scraping, Selenium, or unapproved account/session automation.

**Chosen architecture: HYBRID sender model.**

- **Initial rollout:** One verified **platform-owned WhatsApp Business sender** for authorized owners, if Meta policies and customer consent permit. Every template clearly identifies the property owner/business and property.
- **Future rollout:** Each organization may connect its **own approved WhatsApp Business sender** through a compliant onboarding process. The database and provider layer must support per-organization sender credentials/configuration without rewriting payment logic.
- Maintain tenant organization isolation for sender configuration, templates, logs, and webhooks. Where a sender is not legally/technically configured, mark messaging unavailable rather than switching to an unauthorized fallback.

The implementation must **not assume** a normal personal WhatsApp number can automatically send messages via the Cloud API. Document the real Meta account/number/business verification and template prerequisites.

### Example utility receipt content

```text
Hello Rahul,

We have received your rent payment successfully.

Property: Shree Residency
Room: 101
Rent Month: November 2026
Amount Received: ₹8,000
Payment Mode: Online
Transaction ID: UPI123456789
Payment Date: 05 November 2026
Payment Time: 11:30 AM IST

Thank you for your payment.
Regards,
Shree Residency
```

For cash, omit online reference fields. For a payment covering several months, represent covered months/amounts accurately. Actual production content must follow **approved utility templates**, not arbitrary unrestricted messages.

### Mandatory messaging behavior

- Obtain/document applicable **WhatsApp recipient opt-in**; retain consent timestamp/source and honor opt-out.
- Validate and normalize phone numbers to **E.164**, using a maintained library.
- Keep provider access tokens, signing secrets, phone-number IDs, and other credentials **server-side and appropriately encrypted/secret-managed**.
- Use template parameters and a versioned snapshot of the receipt data.
- Verify incoming webhook subscription challenge and signature; associate webhook events with the correct sender and organization.
- Track queue status, API accepted/sent, delivered, read (when supported), and failed states separately; **provider acceptance != delivery**.
- Store provider message ID and error details safely.
- Rate-limit dispatch and use bounded retries with exponential backoff and dead-letter/failure state.
- Allow explicit retry of retryable failed messages, with authorization checks.
- Handle duplicate webhook events and repeated provider callbacks idempotently.
- Do not create duplicate notifications for a payment due to retries.

### Transactional outbox

Create a `NotificationOutbox` row **inside the same database transaction** as the payment and audit event. A **durable, independent worker** claims/dispatches messages, safely resumes after crashes, and persists state. Do not use fire-and-forget promises or a process-local timer for critical messages.

Document that exact-once delivery at an external provider cannot be guaranteed merely by local job deduplication. Use provider capabilities and reconciliation to minimize duplicates, and make uncertain delivery states visible.

### Local development and production activation

- Implement a **clearly labeled mock provider** for dev/test, never reported as real delivery.
- Implement the genuine Meta integration behind a provider interface.
- When real credentials, templates, or opt-in are missing, display **Unconfigured** or equivalent state; never simulate successful production sending.
- Include `docs/whatsapp-setup.md` with setup steps, sender onboarding, privacy/consent constraints, current pricing verification, and failure diagnosis.

---

## 10. Dashboards, reporting, and UX

### Owner dashboard

Show figures based **only on real authorized database records**:

- Total, occupied, and vacant rooms; active tenants.
- Expected monthly rent and actual payments received.
- Outstanding balances and overdue rent.
- Upcoming due dates, recent payments, pending/failed WhatsApp notifications.
- Month/year selectors; trend chart; paid-vs-pending and per-room summaries.
- Search, filters, quick actions, loading/skeleton, empty, and error states.

Define clear report semantics: **cash received during a month** and **rent attributed to a billing month** are different measures; label them distinctly and avoid mixing them.

### Main screens

1. Login, invitation/registration, and account recovery.
2. Main dashboard.
3. Properties/buildings list and details.
4. Rooms list/detail/create/edit/archive.
5. Tenants list/detail/create/edit.
6. Lease creation, history, termination.
7. Monthly rent ledger.
8. Record payment.
9. Payment history and details/receipt.
10. WhatsApp notification history/status/retry.
11. Reports and exports.
12. Organization settings and account settings.
13. Backup/security status (health information only for ordinary owners).

### Reporting

Provide monthly/yearly collections, room-wise/tenant-wise history, unpaid and overdue balances, partial payments, payment-mode split, and occupancy history. Support filters by month, year, room, property, tenant, payment status/mode.

Support private, organization-scoped **CSV exports**; PDF receipts/reports are desirable if practical. Protect generated files from public/other-organization access; avoid leaking temporary export links.

### UX rules

- Mobile-first, responsive, accessible, and fast; simple enough for owners with limited technical knowledge.
- Polished UI using Tailwind + shadcn/ui, readable rupee amounts, consistent colors/status labels.
- Easy payment entry, good form validation, clear success/failure distinctions, and confirmations for destructive actions.
- Loading/skeleton, empty, and error states; light/dark mode if practical.
- No fabricated dashboard statistics and no placeholder production data.

---

## 11. Database design requirements

Build a normalized Prisma/PostgreSQL schema. Expected entities (adapt where justified):

| Entity | Purpose |
|---|---|
| `User`, auth tables | Identity and secure sessions |
| `Organization` | Isolation boundary, business profile |
| `OrganizationMembership` | Verified user access/roles |
| `Property` | Building/property belonging to an organization |
| `Room` | Physical rentable unit |
| `Tenant` | Occupant/person who pays rent |
| `Lease` | Agreement binding tenant to room and financial terms |
| `RentCharge` | Monthly amount due for a particular lease/period |
| `Payment` | Received-money record |
| `PaymentAllocation` | Portion of a payment assigned to a charge |
| `PaymentAdjustment` / reversal | Auditable financial correction |
| `Notification`, `NotificationOutbox` | Messaging state and durable delivery jobs |
| `WhatsAppSender` / sender config | Shared platform or approved org-specific sender |
| `AuditLog` | Immutable-ish change trail |
| `BackupRun` | Infrastructure backup audit/health status |
| `OrganizationSettings` | Owner-specific preferences |

Ensure:

- UUID or comparable non-guessable primary IDs, real foreign keys, appropriate indexes/uniques.
- Organization-scoped uniqueness and cross-organization relation enforcement.
- Correct restrictive/cascade behaviors; **do not cascade-delete financial history**.
- Precise monetary types, timezone-aware instant fields, and explicit billing periods.
- Rent/lease changes don't retroactively alter historic charges.
- Concurrency-safe and idempotent monthly generation/payment writes.
- Production-safe, version-correct **Prisma migrations**; never treat `db push` as the deployment migration strategy.
- Seed scripts create multiple example organizations/leases/payment histories for **development/tests only**.
- Document schema and key database constraints in `docs/database.md`.

---

## 12. Backups and disaster recovery

> **Critical business requirement:** This system holds valuable financial records. Backups must be automated, independently stored, encrypted, monitored, and **restorable in practice**. Implement and test this before claiming production readiness.

### Backup schedule and retention

- **Daily:** At least one automated, consistent, encrypted backup every 24 hours.
- **Monthly:** A separate recovery point, retained for **at least 12 months**. Monthly retention must not be silently removed by a short daily retention policy.
- Use an independent persistent scheduler/managed scheduled task; backups must work when no owner is logged in and when the web container restarts.
- Prevent overlapping jobs; define retry/backoff and retention cleanup with safety checks.
- Prefer `pg_dump` custom-format **logical backups** via a compatible **direct/unpooled PostgreSQL connection** as required by the provider. Verify privileges and support against the chosen Neon plan.
- Evaluate and enable provider **point-in-time recovery (PITR)** where feasible; document plan-dependent retention and how PITR complements—not replaces—independent backups.

### Private off-site storage

- Use private **Cloudflare R2** or other appropriately isolated S3-compatible storage.
- Do not keep the only copy inside the app container, on ephemeral disks, or in the running DB provider's same failure/security boundary.
- Encrypt archives with authenticated encryption **before/during upload**; keep keys separately in secret/KMS storage, outside the DB and backup bucket.
- Minimize access with dedicated credentials, bucket policy, retention/immutability controls where available, and private networking if practical.
- Do not expose cross-organization DB archives to ordinary owners.

### Backup job verification and alerting

Each run must:

1. Start on schedule and establish a consistent database snapshot.
2. Produce and encrypt the backup archive.
3. Calculate and retain checksum/integrity metadata.
4. Upload to private off-site storage.
5. Validate upload completion/object metadata and check integrity where possible.
6. Persist outcome, timestamps, archive size, key version/metadata, and failure reason without leaking secrets.
7. Retry transient failures safely, with no overlapping jobs.
8. Alert an authorized platform operator on backup failure or overdue backup.

**An uploaded file is not proof of a recoverable database.**

### Restore and recovery

Create tested scripts/runbooks for:

- Generate backup.
- Download a selected private archive.
- Verify integrity and decrypt with authorized key material.
- Restore using `pg_restore` (or provider-appropriate tooling) into a **new isolated PostgreSQL database**.
- Confirm restored tables, constraints, row counts, and representative organization/payment/allocation data.
- Rehearse a recovery with seeded data as part of development/integration testing.
- Explain accidental deletion, database corruption, provider outage, and deployment-failure recovery.
- Document quarterly restore drills and responsible operator actions.

A production restore must never casually overwrite a live shared database. Require explicit operational safeguards and confirmation before destructive steps.

### Recovery objectives and risks

- Document **RPO** (maximum acceptable data loss) and **RTO** (target recovery time) as operational decisions; do not claim guarantees that have not been tested.
- Daily logical backups alone can lose **up to approximately 24 hours** of changes, depending on schedule. Financial records may warrant a tighter RPO with PITR or additional backups.
- Ensure alerting exists if backups stop succeeding.
- Provide a **read-only owner-facing backup-health/status indicator**. Restrict backup archives, restore controls, and cross-organization operations to trusted platform operators.

Create `docs/backup-recovery.md` with exact tested commands and prerequisites. If credentials or infrastructure are missing, mark off-site backup as **not configured** and clearly block production-readiness claims.

---

## 13. Audit logging and security

### Auditable operations

Log sensitive operations such as:

- Payment creation, reversal, and adjustment.
- Monthly charge creation/correction and lease rent changes.
- Tenant, lease, and room changes/archiving.
- Account, membership, and security-setting changes.
- Unauthorized access attempts and administrative actions.
- Important notification state and manual retry actions.

Where useful record organization ID, actor ID, action, entity type/ID, timestamp, reason, and **minimal redacted** before/after details. Ordinary users may view permitted audit details but must not tamper with or delete audit history. Avoid storing secrets or unnecessary personal data in logs.

### Mandatory security controls

- Follow current **OWASP** guidance for authentication, authorization, multi-tenancy, and secure application design.
- Validate all inputs at boundaries; safe parameterized ORM/database queries.
- Prevent IDOR/BOLA, CSRF, XSS, injection, and cross-organization aggregation/export leaks.
- Secure session cookies, trusted origins, rate limiting, HTTPS, security headers, and correct CORS.
- Restrict DB roles/privileges, background jobs, storage credentials, webhook secrets, and platform admin functions.
- Validate external callbacks/webhooks cryptographically and protect against replay/duplication as feasible.
- Centralized structured logging with redaction; no passwords, tokens, secret keys, or raw sensitive payloads.
- Secret injection by environment/secret management, **never credentials in Git**.
- `.env.example` contains variable names and harmless placeholders only.
- Separate dev/staging/production environments; do not leak debug stack traces to production clients.
- Run dependency/security checks in CI.
- Document privacy, WhatsApp consent, retention and deletion considerations for intended Indian users in `docs/security.md`.

---

## 14. Background jobs and operational reliability

Use persistent, idempotent jobs for:

1. Generating monthly rent obligations.
2. Sending queued WhatsApp notifications.
3. Handling/reconciling delivery events as needed.
4. Scheduling backups or monitoring independently scheduled backups.
5. Other critical recurring maintenance.

Requirements: persistent job records, worker identity/lease or claim mechanism, transactionally safe scheduling, bounded retries, visibility timeout/crash recovery, idempotency keys, monitoring, failed/dead-letter state, and safe concurrent workers.

Do **not** rely on an in-memory timer in the web server, a user's browser tab, an unawaited promise, or ephemeral serverless processes for critical work.

Use PostgreSQL-backed jobs when appropriate for the modest initial size; justify any added Redis/queue infrastructure.

---

## 15. Testing and acceptance scenarios

Testing is a release gate, not an optional polish phase. Use unit tests, PostgreSQL-backed integration tests, API authorization tests, and Playwright end-to-end tests.

### Authentication and authorization

- Protected endpoints reject unauthenticated requests.
- Invalid credentials fail safely; login/logout, verification, password reset, and session expiration work.
- Owner A cannot read/edit/create/reverse/archive/export/send for Owner B, even with Owner B's IDs and hand-crafted requests.
- Background jobs, exports, summaries, file access, and cross-resource references respect verified organization membership.

### Rent accounting

- Monthly due creation is unique/idempotent.
- Full and partial payments, multiple payments, one payment for multiple months, and advance credits work accurately.
- Overdue computation and due-date policies behave consistently.
- Lease termination, occupant changes, and agreed-rent changes preserve historical financial records.
- Online payment reference validation and retention work.
- Concurrent requests and repeated submissions do not double-charge or double-record payments.
- Adjustments/reversals produce correct totals and audit entries.

### WhatsApp

- A confirmed payment atomically creates one logical outbox record.
- A failed/uncommitted payment creates **no** successful receipt job.
- Missing consent/config blocks sending rather than faking delivery.
- Worker retries, deduplication, crash recovery, manual retry rules, and rate limits work.
- Webhook challenge/signatures, duplicate callbacks, and organization association are tested.
- Mock delivery is labeled as such; API acceptance and delivered states are not confused.

### Backups and infrastructure

- Consistent dump, encryption, checksum, upload success/failure, monitoring, and retention logic are tested.
- A backup can be decrypted and restored into a fresh **isolated PostgreSQL database**, with seeded records checked for integrity.
- No cross-organization archive download through owner-facing routes.
- Docker setup, migration flow, build, and CI checks work.

### End-to-end user stories

- Owner signs in, adds a property/room, creates a tenant and lease, and sees the corresponding monthly charge.
- Owner records a Cash payment; ledger/dashboard update correctly; notification is queued.
- Owner records an Online payment with reference; a duplicate submission is safely handled.
- Owner sees month-by-month paid/partial/overdue status and exports only own history.
- Second owner cannot access any of the first owner's resources.
- UI is usable on mobile and clearly distinguishes payment recording from WhatsApp delivery.

Never create tests that trivially pass, skip failing suites, or claim external integration success without real verification.

---

## 16. Repository structure

Suggested monorepo (adapt if existing repository structure makes another arrangement more maintainable):

```text
rental-management/
├── README.md                    # This master specification
├── apps/
│   ├── web/                     # React/Vite frontend
│   ├── api/                     # Hono/Bun API
│   └── worker/                  # Optional standalone persistent jobs worker
├── packages/
│   ├── db/                      # Prisma schema, migrations, data access
│   ├── shared/                  # Shared types, Zod schemas, helpers
│   └── config/                  # Shared tooling configuration
├── scripts/
│   ├── backup/                  # Encrypted backup + verification
│   └── restore/                 # Isolated restore + integrity checks
├── docs/
│   ├── architecture.md
│   ├── database.md
│   ├── security.md
│   ├── whatsapp-setup.md
│   ├── backup-recovery.md
│   └── deployment.md
├── .github/workflows/          # CI and vetted scheduled tasks if suitable
├── docker-compose.yml
├── .env.example
└── package.json
```

Keep business logic outside HTTP route handlers, share validated DTOs safely, and use service/repository abstractions only where they genuinely improve clarity. Prefer maintainable modular TypeScript over unnecessary ceremony.

---

## 17. Deployment and operations

Provide and verify:

- Dockerfiles and local Docker Compose with PostgreSQL.
- Bun workspace/project scripts and dependency installation instructions.
- Environment validation and an accurate `.env.example`.
- Production build, Prisma migration/deploy flow, startup/health-check endpoint, and graceful shutdown.
- Separate deployment requirements for the API, web frontend, durable worker, and backup scheduler.
- Structured logs, job/backup monitoring, and notification failure visibility.
- CI for lint, typecheck, tests, migration checks, build, and dependency scanning.
- Safe secrets handling and staging-vs-production isolation.
- A low-cost initial hosting proposal suitable for four rooms and a migration path to hundreds of organizations.
- Database pooling/indexing/pagination and report query efficiency; avoid premature microservices.

**Hosting caveat:** Do not deploy background jobs or backups on infrastructure that may suspend/restart them without a durable scheduling/processing design. Verify actual hosting guarantees.

**Production-readiness checklist:** All critical environment variables, verified authentication, organization boundary tests, production DB migrations, working Meta templates/consent, functioning encryption keys/storage, backup monitoring, and successfully tested restore must be accounted for. Any missing item is a documented blocker or explicit limited release mode.

---

## 18. Implementation phases

Work sequentially but do not stop after phase 1. Maintain a checklist of completed work, tests, blockers, and decisions.

### Phase 1 — Research and architecture

- Inspect repository and validate current official docs/version compatibility.
- Define financial policies, authorization boundaries, and schema.
- Write `docs/architecture.md` with trade-offs; prepare threat model and migration strategy.

### Phase 2 — Foundation

- Configure monorepo, Bun, React/Vite, Hono, Prisma/PostgreSQL, auth, local Docker, shared validation, CI scaffolding, lint/typecheck/test tooling.

### Phase 3 — Core rental system

- Organizations/memberships, properties, rooms, tenants, leases, month-by-month charges, payment transactions/allocations, dashboard, reporting, corrections, audit log.

### Phase 4 — Messaging

- Shared-platform sender configuration, future per-org sender model, Meta adapter, templates/consent, transactionally created outbox, persistent worker, signed webhooks, status history, retry UX.

### Phase 5 — Backup/recovery

- Daily independent encrypted backups, 12-month monthly retention, checksum verification, off-site upload, scheduler/alerts, isolated restore validation, docs, PITR assessment.

### Phase 6 — Hardening

- Cross-organization adversarial tests, accounting concurrency tests, WhatsApp failure tests, end-to-end tests, performance and security review, responsive UX polish.

### Phase 7 — Deployment readiness

- Production config, CI, deployment/operations/recovery runbooks, accurate launch checklist, remaining external approval/credential list.

After each phase run relevant checks and record actual results. Do not present unchecked checkboxes as completed work.

---

## 19. Definition of done

Consider the system complete only when **all verifiable requirements below pass**:

- [ ] An owner can be onboarded, verify email, log in, and log out securely.
- [ ] Owner can create multiple properties and any number of rooms.
- [ ] Owner can create tenants and leases without overlapping active occupancy.
- [ ] Charges are created correctly for each applicable rent month.
- [ ] Owner can record Cash and Online payments with actual date/time, and Online requires a reference ID.
- [ ] Full, partial, advance, and multiple-month payments yield correct balances.
- [ ] Financial reversals/corrections are auditable and historical data stays accurate.
- [ ] Dashboard, history, reports, and exports use real, organization-scoped data.
- [ ] A successful payment atomically queues a WhatsApp receipt; payment persistence does not depend on messaging success.
- [ ] Real Meta messaging works **when legitimately configured** with consent and approved templates; otherwise the UI is explicitly unconfigured.
- [ ] Shared sender initially and future owner-specific sender architecture are supported.
- [ ] Extensive security tests prove different owners cannot access each other's records.
- [ ] Daily encrypted independent off-site backups run automatically and are monitored.
- [ ] At least 12 monthly backup recovery points are retained independently.
- [ ] A restore into an isolated database was tested and documented.
- [ ] Local Docker development, Prisma migrations, builds, and automated tests work.
- [ ] Documentation and external setup requirements are accurate.
- [ ] No hardcoded production secrets, fake delivery statuses, fabricated figures, or destructive history edits.

**If a production-only dependency is missing, say “implemented but not verified/activated” and state the blocker. Do not mark it complete.**

---

## 20. External setup, assumptions, and deliverables

### Required external setup

Codex must document how to obtain and safely configure, as needed:

- Production PostgreSQL/Neon database and suitable connection/pooling URLs.
- Production hosting and domain/HTTPS.
- Auth secrets and transactional email service for account verification/reset.
- Meta WhatsApp Business Platform sender, tokens, webhook configuration, approved templates, and tenant consent.
- Independent Cloudflare R2 storage, restricted access keys, encryption keys, scheduler, alert destination, and restore credentials.
- Optional PITR feature and its real retention guarantees on the selected provider plan.

Never invent credentials, force private credentials into Git, or suggest that the app is live merely because it can run locally.

### Initial assumptions

- INR currency; India-first phone number and date formatting.
- Asia/Kolkata presentation timezone; UTC for timestamp storage.
- Property owners use the web application; occupants receive WhatsApp receipts but do not have accounts in v1.
- Owners manually record received funds; this is **recordkeeping, not integrated payment processing**.
- One platform WhatsApp sender initially, only if compliant; schema supports authorized owner-linked senders later.
- Billing/proration and overpayment policies must be explicitly documented and tested rather than guessed silently.
- Public self-signup, complex staff RBAC, payment gateways, tenant portals, and elaborate subscriptions are future enhancements unless required for a sound foundation.

### Final deliverables

1. Working full-stack source code and production-safe Prisma schema/migrations.
2. Owner UI, backend API, authentication/authorization, and financial business logic.
3. Official Meta integration and durable messaging pipeline (real activation documented separately).
4. Automated backup/restore code and operational setup with tested recovery.
5. Meaningful unit/integration/security/end-to-end tests.
6. Docker and CI setup, `.env.example`, run and deploy guides.
7. `docs/architecture.md`, `docs/database.md`, `docs/security.md`, `docs/whatsapp-setup.md`, `docs/backup-recovery.md`, `docs/deployment.md`.
8. Accurate final summary: implemented functions, passing/failing tests, unverified integrations, required credentials/approvals, deployment steps, restoration steps, and residual risks.

### Final directive to Codex

**Treat this as a real financial-record system with a small starting audience, not as a toy project.** Start with repo inspection and current official documentation; build a robust, low-cost, modular monolith; implement and test the entire specification in phases. Strict tenant isolation, reliable rent accounting, auditable payments, WhatsApp integrity, and demonstrably recoverable backups are mandatory.
