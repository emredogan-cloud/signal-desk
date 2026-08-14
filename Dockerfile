# The deployed unit: worker + dashboard, one process tree, one SQLite file.
#
# ARCHITECTURE.md §2 said "the monolith is containerised from Phase 1, so moving to a
# €4/month VPS or a free tier is a deployment change, not a rewrite." 2026-08-14 is
# when that claim was cashed. It was **almost** true: the image built the worker only,
# because until the dashboard was opened nobody knew it had to travel with it.
#
# It has to. The dashboard reads the database the worker writes, by file path, through
# a native SQLite binding. That is not a service boundary that can be stretched across
# two machines — see `apps/worker/src/cli/supervise.ts` for why one volume forces one
# machine.

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

# `tsc -b` emits every package's dist/. The dashboard resolves the workspace packages
# through their `react-server` export condition, which points at dist/ — so this step
# is not merely a type check, it produces what `next build` will import.
RUN pnpm run typecheck
RUN pnpm --filter @signal-desk/web run build

# ─── runtime ───────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    DATA_MODE=MOCK \
    AI_MODE=MOCK \
    X_MODE=MOCK \
    DATABASE_URL=file:/data/signal-desk.db \
    SIGNAL_DESK_ROOT=/app \
    TZ=Europe/Istanbul \
    PORT=3000 \
    HOSTNAME=0.0.0.0

COPY --from=build /app/node_modules                  ./node_modules
COPY --from=build /app/package.json                  ./package.json
COPY --from=build /app/pnpm-workspace.yaml           ./pnpm-workspace.yaml
COPY --from=build /app/packages                      ./packages
COPY --from=build /app/apps/worker/dist              ./apps/worker/dist
COPY --from=build /app/apps/worker/package.json      ./apps/worker/package.json
COPY --from=build /app/apps/worker/node_modules      ./apps/worker/node_modules

# The dashboard. `.next` is the build output; `next` itself is needed to serve it.
COPY --from=build /app/apps/web/.next                ./apps/web/.next
COPY --from=build /app/apps/web/package.json         ./apps/web/package.json
COPY --from=build /app/apps/web/next.config.ts       ./apps/web/next.config.ts
COPY --from=build /app/apps/web/node_modules         ./apps/web/node_modules

# Fixtures travel with the image: MOCK mode is a first-class citizen (ARCHITECTURE §8)
# and a deployed system that cannot fall back to fixtures cannot be debugged in place.
COPY --from=build /app/fixtures                      ./fixtures

# The embedding weights are NOT in this image. 128MB of ONNX made the build context
# 310MB and every deploy a ten-minute upload from a domestic uplink. They live on the
# volume at `MODEL_CACHE_DIR=/data/.models`, fetched once by `pnpm embeddings:warm`
# and surviving both restarts and deploys — which baking them in does not, and
# re-downloading them per boot does not either.

# `pnpm-workspace.yaml` above is what makes `findRepoRoot()` resolve to /app inside the
# container — the same anchor the dashboard uses to locate the database.

# The database lives on a volume. Losing it costs weeks of accumulated scoring signal
# (THREAT-MODEL.md asset A4) even though feeds can be re-read.
VOLUME ["/data"]

# Untrusted content is parsed inside this container. It has no reason to be root.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 3000

CMD ["node", "apps/worker/dist/cli/supervise.js"]
