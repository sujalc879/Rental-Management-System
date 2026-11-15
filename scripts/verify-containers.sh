#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
(( $# == 0 )) || { echo 'Usage: bun run verify:containers' >&2; exit 1; }
command -v docker >/dev/null || { echo 'Install Docker before running container verification.' >&2; exit 1; }
if [[ -n "${DOCKER_CONTEXT:-}" || -z "${DOCKER_HOST:-}" ]]; then
  task_context="${DOCKER_CONTEXT:-$(docker context show)}"
  task_host=$(docker context inspect "$task_context" --format '{{.Endpoints.docker.Host}}')
else
  task_host="$DOCKER_HOST"
fi
case "$task_host" in unix://*|npipe://*) ;; *) echo 'Container verification requires a local Docker engine; remote contexts are refused.' >&2; exit 1 ;; esac
docker info >/dev/null

task_id="rentledger-verify-$(date +%s)-$$"
task_network="$task_id"
task_pg="$task_id-db"
task_api="$task_id-api"
task_worker="$task_id-worker"
task_containers=()
task_images=()
task_network_created=false
cleanup() {
  if (( ${#task_containers[@]} )); then docker rm -f -v "${task_containers[@]}" >/dev/null 2>&1 || true; fi
  if [[ "$task_network_created" == true ]]; then docker network rm "$task_network" >/dev/null 2>&1 || true; fi
  if (( ${#task_images[@]} )); then docker image rm "${task_images[@]}" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

for target in app worker backup; do
  echo "Building the local $target image."
  task_images+=("$task_id-$target")
  docker build --quiet --target "$target" --tag "$task_id-$target" .
done
docker network create --label rentledger.local-verification="$task_id" "$task_network" >/dev/null
task_network_created=true
task_containers+=("$task_pg")
docker run -d --name "$task_pg" --label rentledger.local-verification="$task_id" \
  --network "$task_network" --network-alias db --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_USER=rental_test -e POSTGRES_DB=rental_test \
  postgres:17-bookworm >/dev/null
task_ready=false
for (( attempt=0; attempt<40; attempt++ )); do
  if docker exec "$task_pg" pg_isready -U rental_test -d rental_test >/dev/null 2>&1; then task_ready=true; break; fi
  sleep 0.5
done
[[ "$task_ready" == true ]] || { docker logs "$task_pg"; exit 1; }

task_admin_url='postgresql://rental_test@db:5432/rental_test'
task_api_url='postgresql://rental_api@db:5432/rental_test'
task_worker_url='postgresql://rental_worker@db:5432/rental_test'
task_common=(--network "$task_network" -e NODE_ENV=test -e WHATSAPP_MODE=disabled -e BACKUP_ENABLED=false)
docker run --rm "${task_common[@]}" -e DIRECT_URL="$task_admin_url" "$task_id-app" bun run db:deploy
docker exec "$task_pg" psql -X -U rental_test -d rental_test -v ON_ERROR_STOP=1 -c \
  'CREATE ROLE rental_api LOGIN; CREATE ROLE rental_worker LOGIN; CREATE ROLE rental_backup LOGIN; CREATE ROLE rental_monitor LOGIN;'
docker exec -i "$task_pg" psql -X -U rental_test -d rental_test \
  -v api_role=rental_api -v worker_role=rental_worker -v backup_role=rental_backup -f - < scripts/db/grants.sql
docker exec -i "$task_pg" psql -X -U rental_test -d rental_test \
  -v monitor_role=rental_monitor -f - < scripts/db/monitor-grants.sql

task_secret=$(docker run --rm --entrypoint bun "$task_id-app" -e 'console.log(crypto.randomUUID() + crypto.randomUUID())')
task_containers+=("$task_api" "$task_worker")
docker run -d --name "$task_api" --label rentledger.local-verification="$task_id" "${task_common[@]}" \
  -e DATABASE_URL="$task_api_url" -e APP_ORIGIN=http://localhost:3000 -e BETTER_AUTH_SECRET="$task_secret" "$task_id-app" >/dev/null
docker run -d --name "$task_worker" --label rentledger.local-verification="$task_id" "${task_common[@]}" \
  -e DATABASE_URL="$task_worker_url" "$task_id-worker" >/dev/null
task_ready=false
for (( attempt=0; attempt<30; attempt++ )); do
  if docker exec "$task_api" bun -e 'const response = await fetch("http://127.0.0.1:3000/ready", { signal: AbortSignal.timeout(2000) }); process.exit(response.ok ? 0 : 1);' >/dev/null 2>&1 && \
    [[ $(docker exec "$task_pg" psql -X -U rental_test -d rental_test -Atc 'SELECT EXISTS (SELECT 1 FROM "WorkerHeartbeat")') == t ]]; then task_ready=true; break; fi
  sleep 0.5
done
[[ "$task_ready" == true ]] || { docker logs "$task_api"; docker logs "$task_worker"; exit 1; }
docker exec "$task_api" bun -e '
  import { existsSync } from "node:fs";
  if (existsSync(".env") || existsSync(".local") || existsSync(".git")) throw new Error("Private development files entered the image");
  const response = await fetch("http://127.0.0.1:3000/");
  const html = await response.text();
  const asset = html.match(/src="(\/assets\/[^\"]+\.js)"/);
  if (!response.ok || !asset || !(await fetch("http://127.0.0.1:3000" + asset[1])).ok) throw new Error("Built frontend was not served");
  if ((await fetch("http://127.0.0.1:3000/api/organizations")).status !== 401) throw new Error("API authentication was not enforced");
  console.log(JSON.stringify({ event: "containers.api.verified" }));'
docker run --rm "${task_common[@]}" -e DATABASE_URL=postgresql://rental_monitor@db:5432/rental_test \
  "$task_id-app" bun run worker:monitor
docker stop --time 35 "$task_api" "$task_worker" >/dev/null

docker run --rm "${task_common[@]}" -e TEST_DATABASE_URL="$task_admin_url" \
  -e TEST_API_DATABASE_URL="$task_api_url" -e TEST_WORKER_DATABASE_URL="$task_worker_url" \
  "$task_id-app" bun run test --configLoader native --fsModuleCachePath /tmp/rentledger-vitest-cache
docker run --rm "${task_common[@]}" -e TEST_DATABASE_URL="$task_admin_url" \
  -e TEST_BACKUP_DATABASE_URL=postgresql://rental_backup@db:5432/rental_test \
  --entrypoint bun "$task_id-backup" scripts/verify-recovery.ts
echo 'Local container verification passed. Its containers, network and image tags will be removed.'
