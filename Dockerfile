FROM oven/bun:1.4.4 AS bun

FROM node:24-bookworm-slim AS dependencies
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN bun install --frozen-lockfile

FROM dependencies AS build
COPY . .
RUN bun run db:generate && bun run typecheck && bun run build

FROM build AS app
ENV NODE_ENV=production
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD bun -e 'process.exit((await fetch("http://127.0.0.1:" + (process.env.API_PORT || "3000") + "/ready")).ok ? 0 : 1)'
CMD ["bun", "apps/api/src/server.ts"]

FROM postgres:17-bookworm AS backup
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=build /app /app
WORKDIR /app
ENV NODE_ENV=production
USER postgres
ENTRYPOINT ["bun", "scripts/backup/index.ts"]
CMD ["run"]
