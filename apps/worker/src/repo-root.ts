import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locate the repository root by walking up for `pnpm-workspace.yaml`.
 *
 * CLIs are invoked from the root via pnpm scripts, from `apps/worker/dist` after a
 * build, and from a Docker image with a different layout. Anchoring on a file that
 * only exists at the root works in all three; `process.cwd()` works in one.
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
