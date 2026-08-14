import { schemaReady } from '@/lib/data';

/**
 * Liveness and readiness for the platform's health check.
 *
 * Deliberately **unauthenticated** — see the matcher in `proxy.ts`. A health endpoint
 * behind Basic auth means the platform's checker gets a 401, marks the machine
 * unhealthy, and restarts a perfectly working system in a loop.
 *
 * Deliberately **almost empty**. It answers "is this process serving, and can it read
 * the database" — nothing else. Event counts and source names would make an
 * unauthenticated endpoint into a low-resolution copy of the console it sits in front
 * of, and the whole point of `proxy.ts` is that this console is not public.
 *
 * `schemaReady()` is a real read against SQLite, not a constant: a dashboard that
 * returns 200 while its volume is unmounted is the failure this exists to catch.
 */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  let database: 'readable' | 'no-schema' | 'unreachable';
  try {
    database = schemaReady() ? 'readable' : 'no-schema';
  } catch {
    database = 'unreachable';
  }

  // `no-schema` is healthy: the worker owns migrations, and the dashboard legitimately
  // starts first on a fresh volume. `unreachable` is not.
  const ok = database !== 'unreachable';

  return Response.json(
    { ok, database, at: new Date().toISOString() },
    { status: ok ? 200 : 503, headers: { 'cache-control': 'no-store' } },
  );
}
