import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locate the repository root by walking up for `pnpm-workspace.yaml`.
 *
 * CLIs are invoked from the root via pnpm scripts, from `apps/worker/dist` after a
 * build, and from a Docker image with a different layout. The dashboard is invoked
 * from `apps/web`, because that is where `next` runs. Anchoring on a file that only
 * exists at the root works in all four; `process.cwd()` works in one.
 *
 * Lives in `shared` rather than `apps/worker` since 2026-08-14: the dashboard needs
 * the same answer, and the alternative was a second copy that could disagree with the
 * first about where the database is.
 */
export function findRepoRoot(startFrom: string = fileURLToPath(import.meta.url)): string {
  let current = dirname(startFrom);

  for (let depth = 0; depth < 12; depth++) {
    if (existsSync(resolve(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // Fall back to the working directory rather than throwing: a CLI that cannot find
  // the repo root should still be able to report on the live environment.
  return process.cwd();
}

/**
 * Where the local ONNX embedding model lives.
 *
 * Repository-relative by default, which is right for development. Overridable because
 * a deployed container needs it on the **persistent volume**, not in the image:
 *
 *   - baking 128MB of weights into the image made the Docker build context 310MB and
 *     the upload from a domestic uplink took over ten minutes, per deploy;
 *   - re-downloading them into the container's ephemeral layer on every restart makes
 *     every restart depend on a third party being up.
 *
 * On the volume they are fetched once and survive both. `MODEL_CACHE_DIR=/data/.models`
 * in `fly.toml`.
 */
export function modelCacheDir(): string {
  const override = process.env.MODEL_CACHE_DIR;
  if (override !== undefined && override.trim() !== '') return override.trim();
  return `${findRepoRoot()}/.models`;
}
