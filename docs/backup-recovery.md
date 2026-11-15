# Backup and recovery

## Production setup

Use an independent private Cloudflare R2 or S3-compatible bucket. Disable public access and public domains. Restrict the backup runner's credentials to the backup bucket. Keep restore credentials separate where the provider supports a separate read-only role. Store the encryption key in a separate secret manager or KMS. Generate a 32-byte hex `BACKUP_KEY`, set a unique `BACKUP_KEY_VERSION` and retain each prior key separately until its last archive expires. An old archive's key is supplied as `BACKUP_KEY_<version>` during recovery. Protect the manifest, operator logs, checksums and archive names from public access.

Configure independent lifecycle rules on `daily/` and `monthly/`. Keep daily copies for 35 days and monthly copies for at least 400 days, with prefix-scoped bucket locks if available. Test both rules and monitor the number and dates of retained monthly objects. The job has no archive deletion route or cleanup credentials. [Cloudflare R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) · [Cloudflare R2 bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/)

Set `BACKUP_ENABLED=true`, `BACKUP_DIRECT_URL`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, scoped `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, the key/version, and `BACKUP_HEARTBEAT_URL` and `BACKUP_ALERT_URL` in the scheduled job. Use a direct connection with TLS and PostgreSQL client tools at least as new as the database. Run `bun run backup run` hourly via a scheduler independent of the app, or schedule the backup image with its default `run` command. A database advisory lock prevents overlapping runs. An interrupted run is marked failed on the next invocation. Bounded attempts back off within a run, and the next scheduler invocation can retry. A successful run creates a daily object and, once per IST month, a separate monthly object.

Set `BACKUP_S3_REGION=auto` for R2 (the backward-compatible default). AWS S3 requires the bucket's actual signing region: for a Mumbai bucket use `BACKUP_S3_ENDPOINT=https://s3.ap-south-1.amazonaws.com` and `BACKUP_S3_REGION=ap-south-1`. The bucket name is supplied separately. Endpoint URLs must use HTTPS and cannot contain embedded credentials, query parameters or fragments; invalid endpoint errors do not print the supplied URL. Credentials remain in the SDK's server-side credential provider chain. A configured region is not proof of a working bucket: verify an actual upload, readback and isolated restore before enabling production protection. [AWS SDK region configuration](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-region.html)

The process exports a repeatable PostgreSQL snapshot and records verification counts and a deterministic ledger sample from that snapshot. It streams `pg_dump` in custom format through AES-256-GCM, verifies the uploaded ciphertext by metadata and full SHA-256 readback, and records success only after all required objects pass. Configure the external heartbeat alert to fire after 25 hours and route failure events to a trusted operator. `bun run backup monitor` checks recent verified off-site runs. `BACKUP_LOCAL_DIR` selects a development-only adapter whose runs cannot mark off-site health as successful. The current upload path has a 4 GiB archive limit. Plan and test multipart storage before reaching it. [PostgreSQL pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html)

New manifests authenticate row counts for all 25 application/authentication tables, including users, credential accounts, sessions, MFA, lease terms, credit applications and job state. Restore verifies composite financial foreign keys, the room-overlap constraint, enabled financial/audit immutability triggers and effective balances. Older manifests remain verifiable through their fixed allowed table subset. Migration metadata is restored by the dump but is not included in these 25 application-table counts.

Daily/monthly scheduling records a SHA-256 identifier of the storage destination in `BackupRun.storageId`. A different local folder, S3 endpoint or bucket must establish its own daily and monthly recovery points. Pre-upgrade records without this identifier do not suppress the next backup. This identifier is not a substitute for bucket retention rules, restricted credentials, or integrity verification. Object keys are validated before any storage read or write.

## Isolated restore

1. Select an approved recovery object and its recorded SHA-256 from trusted `BackupRun` data or retained operator logs. Preserve the live database and record the incident, recovery point and responsible operator.
2. Create a new isolated PostgreSQL database whose name begins with `rental_restore_`. In production use a separate endpoint. Restrict network and user access and avoid connecting the application or worker to it during the drill. The restore credential needs schema ownership and permission to install the supported `btree_gist` extension.
3. Supply `RESTORE_DATABASE_URL` and `RESTORE_CONFIRM_DATABASE` with the exact new database name. Keep `BACKUP_DIRECT_URL` set to the source connection for the guard. Supply download credentials and the appropriate key. Use private encrypted scratch storage with room for ciphertext and the decrypted dump. The operator-only scratch directory is removed after the run. After a forced process termination, check the scratch location for any leftovers and remove them under the operating procedure.
4. Run `bun run backup restore 'daily/<object>.rentbk' '<sha256>'`. The script requires an empty target, confirms the checksum and authenticated encryption before passing the dump to `pg_restore`, restores in a single transaction and checks representative payment and allocation data, constraints, and authenticated row counts. Preserve the result in the incident record and compare it with the source verification criteria before any cutover. [PostgreSQL pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html)
5. After source-manifest verification, the restore script puts `PENDING`, `SENDING`, `ACCEPTED`, `SENT` and `FAILED` receipt rows on an audited `UNCERTAIN` hold with reason `RESTORE_RECONCILIATION_REQUIRED`. A message might have been sent after the recovery point. The hold prevents automatic dispatch and owner retries while provider records are reconciled; it preserves provider IDs and correlation tokens for signed callbacks. Confirmed delivered/read, cancelled and development-simulated states are retained. The printed `counts` are the authenticated source-snapshot counts, before these additional recovery audit events; `quarantinedReceipts` reports the number held.
6. The script also invalidates all restored browser sessions and one-time verification/reset tokens, with system audit events, after verifying the authenticated source counts. Owners must sign in again and request fresh pending setup/reset links. Credential and MFA records are retained; review password, account, membership and MFA changes made after the recovery point before cutover. Do not blindly rotate the Better Auth encryption secret without a compatible plan for encrypted MFA data.
7. Rotate infrastructure credentials as required, apply reviewed forward migrations for the intended release, and reapply runtime grants in the recovery environment. For an accidental deletion or a single-owner incident, review the isolated data and use an explicitly authorized, scoped repair. For a full cutover, freeze writes, validate the target, reconcile payments and receipt/provider history since the recovery point, and obtain operator approval before changing production connection strings or activating messaging. Do not turn uncertain holds into retryable messages without a reviewed provider reconciliation and an operator audit record. Deployments with a bad migration should preserve the source and follow the same verified recovery process when a forward fix cannot safely recover it.

## Rehearsal

On macOS/Linux, `bun run verify:local --with-browser` builds a fresh, loopback-only test cluster, runs the security/accounting/browser suites and calls `bun run verify:recovery`. PostgreSQL client/server tools must be on `PATH`; they must match each other. This workflow never reads its database targets from the production/development Neon settings, and shuts down/removes only its own temporary cluster on exit. It provisions a read-only monitoring role and verifies a real worker heartbeat before running tests.

For an existing disposable migrated local database, run:

```sh
NODE_ENV=test \
TEST_DATABASE_URL=postgresql://rental_test@127.0.0.1:55439/rental_test \
TEST_BACKUP_DATABASE_URL=postgresql://rental_backup@127.0.0.1:55439/rental_test \
bun run verify:recovery
```

Use URLs appropriate to that local instance. The source test role needs `CREATEDB`; the backup role needs the reviewed backup grants. The command creates a new `rental_restore_<random>` database and reads back independent daily and monthly encrypted objects. It removes its temporary archive/key material on exit, leaving the isolated restored database for inspection until the test cluster is removed. It provides development recovery evidence, not an off-site backup or a tested production RTO. Remote test URLs and connection-target query overrides are refused.

Use a disposable migrated local `rental_test` database with two seeded organizations and representative payments. CI runs the unit/integration/browser tests to populate this data before the backup rehearsal. Use PostgreSQL 17 `pg_dump`, `pg_restore` and `createdb` from the same installation. For Windows set `PG_BIN_DIR` to its `bin` folder. An example local PowerShell procedure follows.

```powershell
$env:NODE_ENV = 'test'
$env:BACKUP_ENABLED = 'true'
$env:BACKUP_DIRECT_URL = $env:TEST_DATABASE_URL
$env:BACKUP_LOCAL_DIR = Join-Path (Get-Location) '.local/backup-rehearsal'
$env:BACKUP_KEY_VERSION = 'rehearsal'
$env:BACKUP_KEY = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$env:RESTORE_CONFIRM_DATABASE = 'rental_restore_drill'
# Create this fresh database with createdb on the local PostgreSQL test instance first.
$env:RESTORE_DATABASE_URL = 'postgresql://postgres@127.0.0.1:55432/rental_restore_drill'
$result = bun run backup run --force | ConvertFrom-Json
bun run backup restore $result.dailyKey $result.sha256
```

Rehearse at least quarterly and after material schema, provider, key or backup changes. Record the end-to-end elapsed time, rows and constraints verified, failed steps, the operator, and how much data could be missing. A daily-only design targets an RPO of 24 hours under normal scheduling and verified healthy backups. Aim for four hours RTO initially and validate it in staging. Enable and test a suitable Neon PITR window for a tighter objective and provider-side recovery. Independent off-site archives remain available for loss of access to the database provider. [Neon history window](https://neon.com/docs/postgres/backup-restore/history-window)

The prior local PostgreSQL 17 rehearsal on 5 November 2026 wrote and read back a daily and a monthly encrypted object using the development storage adapter. A second rehearsal used the restricted backup role and restored the monthly copy into a fresh database. It verified six organizations, eight payments, ten allocations and one reversal. Current verification is recorded in [implementation status](implementation-status.md). Repeat the drill from an actual off-site archive before launch.
