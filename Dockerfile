# Multi-stage build for the worker.
#
# ARCHITECTURE.md §2: "the monolith is containerised from Phase 1, so moving to a
# €4/month VPS or a free tier is a deployment change, not a rewrite." Nothing is
# deployed yet and the deployment decision is deliberately deferred to Phase 10,
# where it is made with measured data about missed detections. This file exists so
# that decision stays cheap.

# ─── deps ──────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# better-sqlite3 compiles a native binding when no prebuild matches the platform.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.33.4 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json    packages/shared/
COPY packages/db/package.json        packages/db/
COPY packages/core/package.json      packages/core/
COPY packages/adapters/package.json  packages/adapters/
COPY packages/ai/package.json        packages/ai/
COPY apps/worker/package.json        apps/worker/
COPY apps/web/package.json           apps/web/

RUN pnpm install --frozen-lockfile

# ─── build ─────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app
COPY . .
RUN pnpm run typecheck

# ─── runtime ───────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    DATA_MODE=MOCK \
    AI_MODE=MOCK \
    X_MODE=MOCK \
    DATABASE_URL=file:/data/signal-desk.db \
    TZ=Europe/Istanbul

RUN corepack enable && corepack prepare pnpm@10.33.4 --activate

COPY --from=build /app/node_modules                  ./node_modules
COPY --from=build /app/package.json                  ./package.json
COPY --from=build /app/pnpm-workspace.yaml           ./pnpm-workspace.yaml
COPY --from=build /app/packages                      ./packages
COPY --from=build /app/apps/worker/dist              ./apps/worker/dist
COPY --from=build /app/apps/worker/package.json      ./apps/worker/package.json
COPY --from=build /app/apps/worker/node_modules      ./apps/worker/node_modules

# The database lives on a volume. Losing it costs weeks of accumulated scoring
# signal (THREAT-MODEL.md asset A4) even though feeds can be re-read.
VOLUME ["/data"]

# Untrusted content is parsed inside this container. It has no reason to be root.
USER node

CMD ["node", "apps/worker/dist/index.js"]
