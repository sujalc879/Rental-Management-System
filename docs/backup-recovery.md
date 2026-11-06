# Backup and recovery

## Production setup

Use an independent private Cloudflare R2 or S3-compatible bucket. Disable public access and public domains. Restrict the backup runner's credentials to the backup bucket. Keep restore credentials separate where the provider supports a separate read-only role. Store the encryption key in a separate secret manager or KMS. Generate a 32-byte hex `BACKUP_KEY`, set a unique `BACKUP_KEY_VERSION` and retain each prior key separately until its last archive expires. An old archive's key is supplied as `BACKUP_KEY_<version>` during recovery. Protect the manifest, operator logs, checksums and archive names from public access.

Configure independent lifecycle rules on `daily/` and `monthly/`. Keep daily copies for 35 days and monthly copies for at least 400 days, with prefix-scoped bucket locks if available. Test both rules and monitor the number and dates of retained monthly objects. The job has no archive deletion route or cleanup credentials. [Cloudflare R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) · [Cloudflare R2 bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/)

Set `BACKUP_ENABLED=true`, `BACKUP_DIRECT_URL`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, scoped `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, the key/version, and `BACKUP_HEARTBEAT_URL` and `BACKUP_ALERT_URL` in the scheduled job. Use a direct connection with TLS and PostgreSQL client tools at least as new as the database. Run `bun run backup run` hourly via a scheduler independent of the app, or schedule the backup image with its default `run` command. A database advisory lock prevents overlapping runs. An interrupted run is marked failed on the next invocation. Bounded attempts back off within a run, and the next scheduler invocation can retry. A successful run creates a daily object and, once per IST month, a separate monthly object.

The process exports a repeatable PostgreSQL snapshot and records verification counts and a deterministic ledger sample from that snapshot. It streams `pg_dump` in custom format through AES-256-GCM, verifies the uploaded ciphertext by metadata and full SHA-256 readback, and records success only after all required objects pass. Configure the external heartbeat alert to fire after 25 hours and route failure events to a trusted operator. `bun run backup monitor` checks recent verified off-site runs. `BACKUP_LOCAL_DIR` selects a development-only adapter whose runs cannot mark off-site health as successful. The current upload path has a 4 GiB archive limit. Plan and test multipart storage before reaching it. [PostgreSQL pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html)

## Isolated restore

1. Select an approved recovery object and its recorded SHA-256 from trusted `BackupRun` data or retained operator logs. Preserve the live database and record the incident, recovery point and responsible operator.
2. Create a new isolated PostgreSQL database whose name begins with `rental_restore_`. In production use a separate endpoint. Restrict network and user access and avoid connecting the application or worker to it during the drill. The restore credential needs schema ownership and permission to install the supported `btree_gist` extension.
3. Supply `RESTORE_DATABASE_URL` and `RESTORE_CONFIRM_DATABASE` with the exact new database name. Keep `BACKUP_DIRECT_URL` set to the source connection for the guard. Supply download credentials and the appropriate key. Use private encrypted scratch storage with room for ciphertext and the decrypted dump. The operator-only scratch directory is removed after the run. After a forced process termination, check the scratch location for any leftovers and remove them under the operating procedure.
4. Run `bun run backup restore 'daily/<object>.rentbk' '<sha256>'`. The script requires an empty target, confirms the checksum and authenticated encryption before passing the dump to `pg_restore`, restores in a single transaction and checks representative payment and allocation data, constraints, and authenticated row counts. Preserve the result in the incident record and compare it with the source verification criteria before any cutover. [PostgreSQL pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html)
5. Rotate credentials and reapply runtime grants in the recovery environment. For an accidental deletion or a single-owner incident, review the isolated data and use an explicitly authorized, scoped repair. For a full cutover, freeze writes, validate the target, reconcile payments and in-flight messages since the recovery point, and obtain operator approval before changing production connection strings. Deployments with a bad migration should preserve the source and follow the same verified recovery process when a forward fix cannot safely recover it.

## Rehearsal

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

The local PostgreSQL 17 rehearsal on 5 November 2026 wrote and read back a daily and a monthly encrypted object using the development storage adapter. A second rehearsal used the restricted backup role and restored the monthly copy into a fresh database. It verified six organizations, eight payments, ten allocations and one reversal. Repeat the drill from an actual off-site archive before launch.
