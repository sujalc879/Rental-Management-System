# RentLedger

Owner software for managing properties, rooms, occupants, leases, monthly rent and cash or online payment records. It uses INR and Asia/Kolkata business dates. The governing specification is [AGENTS.md](AGENTS.md).

## Run locally

Install Bun 1.4.4 and Node.js 24 LTS. Start disposable PostgreSQL with `docker compose up -d --wait db`, or point the app to a dedicated development database. Copy `.env.example` to `.env`. For Docker development, set `DATABASE_URL` and `DIRECT_URL` to `postgresql://rental_dev:local_only@127.0.0.1:5432/rental_dev`. For Neon, use the pooled connection for `DATABASE_URL` and the direct connection for `DIRECT_URL`. Set `BETTER_AUTH_SECRET` to a new random value of at least 32 characters. `bun -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'` generates one.

```sh
bun install --frozen-lockfile
bun run db:generate
bun run db:deploy
bun run onboard owner@example.com "Owner name" "My Rentals"
```

Open the verification and password setup URLs from `.local/mail` when using the development mail adapter. Run `bun run dev:api`, `bun run dev:web`, and `bun run worker` in separate terminals. Open `http://localhost:5173`. The development seed requires an explicitly local disposable database and `DEV_OWNER_PASSWORD`.

## Verify and operate

For a complete local verification on macOS/Linux with PostgreSQL tools installed, run `bun run verify:local --with-browser`. This starts a disposable loopback-only database, applies migrations and restricted roles, checks worker monitoring, runs lint/typecheck/tests/build and mobile browser acceptance, and rehearses encrypted backup/restore. It removes its temporary database cluster afterward and never uses the Neon URLs in `.env`. Set `TEST_PG_PORT` or `E2E_PORT` if the default ports are occupied. Chromium installation requires network access on the first run. Without `--with-browser`, the browser step is omitted explicitly.

For an existing disposable test database, supply `TEST_DATABASE_URL`, `TEST_API_DATABASE_URL` and `TEST_WORKER_DATABASE_URL` with the matching grants from `scripts/db/grants.sql`. Run `bun run test`, `bun run build`, and `bun run test:e2e`. `bun run verify:recovery` additionally accepts `TEST_BACKUP_DATABASE_URL` for a restricted backup role and restores only to a new local test database. Read the backup runbook before any operational restore.

With Docker running, `bun run verify:containers` builds the app, worker and backup images and checks them against a private, disposable PostgreSQL 17 container. It verifies API authentication, built frontend assets, worker health, the Linux test suite and an encrypted restore. It publishes no ports, uses no real provider credentials and removes only its own test containers, network and image tags. Set `DOCKER_DEFAULT_PLATFORM=linux/amd64` when verifying an x86 deployment image from another architecture.

## First owner workflow

Create a property, add its rooms, add tenants, then create a lease connecting each occupied room to its tenant. Enter the actual move-in date, agreed rent and due day. Past move-in dates create historical monthly charges; record historical payments too. In Rent ledger, check obligations and generate advance months when needed. Record received money with its actual IST date/time, Cash/Online mode, online reference when applicable, and allocations to rent months. Open the receipt to print it or make an auditable reversal. Reports provide scoped CSV exports. Settings shows backup and background-processing health. WhatsApp remains explicitly unconfigured until an approved sender and opt-in are available.

Payment entry previews the exact rent allocations and any explicit advance credit; the oldest-unpaid-rent button fills the selected lease's outstanding months without saving a payment. Switching leases clears the allocations. Activity log provides a read-only history with category, record and IST date filters. WhatsApp history can be searched by tenant, property, room or payment and filtered by actual delivery status; its setup badge distinguishes disabled, simulated, configured and unconfigured messaging. Reports includes month-end occupancy history, with the current month shown as of today and no future snapshots.

- [Architecture and phase plan](docs/architecture.md)
- [Database and integrity constraints](docs/database.md)
- [Security and privacy](docs/security.md)
- [WhatsApp setup](docs/whatsapp-setup.md)
- [Backup and recovery](docs/backup-recovery.md)
- [Deployment and launch gates](docs/deployment.md)
- [Verified implementation status and remaining launch work](docs/implementation-status.md)
