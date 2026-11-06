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

Set `TEST_DATABASE_URL` to a separate, migrated, local `rental_test` database. Run `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`, `bunx playwright install chromium`, and `bun run test:e2e`. Read the backup runbook for the isolated restore procedure.

- [Architecture and phase plan](docs/architecture.md)
- [Database and integrity constraints](docs/database.md)
- [Security and privacy](docs/security.md)
- [WhatsApp setup](docs/whatsapp-setup.md)
- [Backup and recovery](docs/backup-recovery.md)
- [Deployment and launch gates](docs/deployment.md)
