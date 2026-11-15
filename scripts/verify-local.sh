#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
if (( $# > 1 )); then echo 'Usage: bun run verify:local [--with-browser]' >&2; exit 1; fi
case "${1:-}" in ''|--with-browser) ;; *) echo 'Usage: bun run verify:local [--with-browser]' >&2; exit 1 ;; esac
for program in bun node initdb pg_ctl psql createdb pg_dump pg_restore; do
  command -v "$program" >/dev/null || { echo "Install $program before running local verification." >&2; exit 1; }
done
task_pg_port="${TEST_PG_PORT:-55439}"
[[ "$task_pg_port" =~ ^[0-9]{4,5}$ ]] && (( task_pg_port >= 1024 && task_pg_port <= 65535 )) || { echo 'Invalid TEST_PG_PORT' >&2; exit 1; }
task_dir=$(mktemp -d "${TMPDIR:-/tmp}/rental-verify.XXXXXX")
task_pg_started=false
task_worker_pid=''
cleanup() {
  if [[ -n "$task_worker_pid" ]]; then kill -TERM "$task_worker_pid" 2>/dev/null || true; wait "$task_worker_pid" 2>/dev/null || true; fi
  if [[ "$task_pg_started" == true ]]; then
    if ! pg_ctl -D "$task_dir/data" -m fast -w stop > "$task_dir/stop.log" 2>&1; then
      echo "Test PostgreSQL could not stop; inspect $task_dir before removing it." >&2
      return
    fi
  fi
  rm -rf "$task_dir"
}
trap cleanup EXIT
export NODE_ENV=test
export DATABASE_URL="postgresql://rental_test@127.0.0.1:$task_pg_port/rental_test"
export DIRECT_URL="$DATABASE_URL"
export TEST_DATABASE_URL="$DATABASE_URL"
export TEST_API_DATABASE_URL="postgresql://rental_api@127.0.0.1:$task_pg_port/rental_test"
export TEST_WORKER_DATABASE_URL="postgresql://rental_worker@127.0.0.1:$task_pg_port/rental_test"
export TEST_BACKUP_DATABASE_URL="postgresql://rental_backup@127.0.0.1:$task_pg_port/rental_test"
export DEV_MAIL_DIR="$task_dir/mail"
export BETTER_AUTH_SECRET
BETTER_AUTH_SECRET=$(bun --no-env-file -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')
export SMTP_URL='' MAIL_FROM='' WHATSAPP_MODE=disabled BACKUP_ENABLED=false
export WORKER_HEARTBEAT_URL='' WORKER_ALERT_URL='' BACKUP_HEARTBEAT_URL='' BACKUP_ALERT_URL=''
initdb -D "$task_dir/data" -A trust -U rental_test --no-locale --encoding=UTF8 > "$task_dir/init.log"
pg_ctl -D "$task_dir/data" -l "$task_dir/postgres.log" -o "-h 127.0.0.1 -p $task_pg_port -k $task_dir" -w start
task_pg_started=true
createdb -h 127.0.0.1 -p "$task_pg_port" -U rental_test rental_test
bun run db:validate
bun run db:generate
bun run db:deploy
bunx prisma migrate diff --from-config-datasource --to-schema packages/db/prisma/schema.prisma --exit-code
psql -X -h 127.0.0.1 -p "$task_pg_port" -U rental_test -d rental_test -v ON_ERROR_STOP=1 -c 'CREATE ROLE rental_api LOGIN; CREATE ROLE rental_worker LOGIN; CREATE ROLE rental_backup LOGIN; CREATE ROLE rental_monitor LOGIN;'
psql -X -h 127.0.0.1 -p "$task_pg_port" -U rental_test -d rental_test -v api_role=rental_api -v worker_role=rental_worker -v backup_role=rental_backup -f scripts/db/grants.sql
psql -X -h 127.0.0.1 -p "$task_pg_port" -U rental_test -d rental_test -v monitor_role=rental_monitor -f scripts/db/monitor-grants.sql
DATABASE_URL="$TEST_WORKER_DATABASE_URL" bun apps/worker/src/index.ts > "$task_dir/worker.log" 2>&1 &
task_worker_pid=$!
task_healthy=false
for ((attempt=0; attempt<20; attempt++)); do
  if [[ $(psql -X -h 127.0.0.1 -p "$task_pg_port" -U rental_test -d rental_test -Atc 'SELECT EXISTS (SELECT 1 FROM "WorkerHeartbeat")') == t ]]; then task_healthy=true; break; fi
  sleep 0.25
done
[[ "$task_healthy" == true ]] || { cat "$task_dir/worker.log" >&2; exit 1; }
DATABASE_URL="postgresql://rental_monitor@127.0.0.1:$task_pg_port/rental_test" bun run worker:monitor
kill -TERM "$task_worker_pid"
wait "$task_worker_pid"
task_worker_pid=''
bun run lint
bun run typecheck
bun run test
bun run build
if [[ "${1:-}" == '--with-browser' ]]; then
  bunx playwright install chromium
  bun run test:e2e
else
  echo 'Browser acceptance was not requested. Use --with-browser for the complete verification flow.'
fi
bun run verify:recovery
echo 'Local verification passed. Disposable PostgreSQL and temporary archives will be removed.'
