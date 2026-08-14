import 'server-only';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { parseConfig, databaseFilePath, findRepoRoot, type Config } from '@signal-desk/shared';

/**
 * The dashboard's view of the environment. **Server-only.**
 *
 * ### The defect this fixes — 2026-08-14
 *
 * The dashboard rendered, and everything on it was wrong in the same quiet way:
 * a permanent **MOCK MODE** banner over a **"database has no schema yet"** empty
 * state, while the worker was writing a 64 MB database three directories up.
 *
 * Both symptoms are one cause. `next dev` and `next start` run with the working
 * directory set to `apps/web`, so:
 *
 *   - the repository's `.env` — which is at the root — was never read, leaving every
 *     mode at its `MOCK` default, and
 *   - `DATABASE_URL=file:./data/signal-desk.db` resolved against `apps/web`, so
 *     `openDatabase` **created** `apps/web/data/signal-desk.db`, 4 KB and empty, and
 *     read from that.
 *
 * The second is the dangerous one. It fails as an empty screen rather than an error,
 * and an empty screen on an intelligence console is indistinguishable from a quiet
 * day. ARCHITECTURE.md §8 requires the MOCK badge to be unmissable; nothing required
 * the badge to be *true*, and a LIVE system displaying MOCK is the same class of lie
 * in the other direction.
 *
 * So the dashboard anchors on the repository root — the same anchor
 * `apps/worker/src/bootstrap.ts` uses — instead of on wherever `next` happened to be
 * started from.
 */

let cached: Config | undefined;
let envLoaded = false;

/**
 * Load the root `.env` into `process.env`. Idempotent.
 *
 * **Called from `instrumentation.ts` at server start, not lazily from a render.** That
 * ordering is load-bearing rather than tidy: `proxy.ts` runs before any page and reads
 * the same `process.env`, so a lazy load during the first render meant the proxy
 * authenticated against a different configuration on request 1 than on request 2. See
 * the note in `instrumentation.ts` for the measurement.
 *
 * `process.loadEnvFile` never overwrites a variable already present in `process.env`
 * (verified, not assumed), so a value injected by the host — systemd, a container, a
 * Fly secret — still wins over the file. That is what production depends on, and it is
 * why the production image ships no `.env` at all.
 */
export function loadRootEnv(): void {
  if (envLoaded) return;
  envLoaded = true;

  const envFile = resolve(findRepoRoot(), '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

export function serverConfig(): Config {
  if (cached !== undefined) return cached;

  // Defensive: `register()` should already have run. Calling again is a no-op, and
  // relying on it alone is what produced the request-1-differs bug.
  loadRootEnv();

  const root = findRepoRoot();
  const parsed = parseConfig(process.env);

  // A relative `file:` URL means "relative to the repository", not "relative to
  // whichever directory this process was launched from". The worker and the dashboard
  // must land on the same bytes or the dashboard is reporting on a database nobody
  // writes to.
  const path = databaseFilePath(parsed.DATABASE_URL);
  const absolute =
    parsed.DATABASE_URL.startsWith('file:') && !isAbsolute(path)
      ? `file:${resolve(root, path)}`
      : parsed.DATABASE_URL;

  cached = { ...parsed, DATABASE_URL: absolute };
  return cached;
}

/** The resolved database file, for the health panel to display. */
export function databaseLocation(): string {
  return databaseFilePath(serverConfig().DATABASE_URL);
}
