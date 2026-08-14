/**
 * Load the repository `.env` **once, at server start** — before any request is served.
 *
 * ## The defect this fixes — 2026-08-14
 *
 * Authentication behaved differently on the first request than on every request after
 * it. Measured, with the proxy instrumented:
 *
 *   request 1 → user "operator" (the code default), 200
 *   request 2 → user "admin"    (the value in .env), 401
 *
 * Nothing about the request changed. What changed was `process.env`: `serverConfig()`
 * in `lib/env.ts` calls `process.loadEnvFile()` **lazily, during the first page
 * render**, and that mutates the environment shared with `proxy.ts`. The proxy runs
 * *before* the page, so on the very first request it read a `process.env` that had
 * never seen the file, and from the second request onward it read one that had.
 *
 * The password happened not to change (`loadEnvFile` does not overwrite values already
 * present, and the host had exported one) — but `DASHBOARD_USER` was absent from the
 * host environment, so the file *added* it, and the comparison started failing.
 *
 * This never reached production: the Fly image has no `.env` at all (`.dockerignore`
 * excludes it) and every value arrives as a real environment variable. That is worth
 * stating plainly rather than treating as luck — it means the bug was invisible in the
 * environment that matters and reproducible only in development, which is the harder
 * direction to notice.
 *
 * The fix is to stop the load being a side effect of rendering. `register()` runs once
 * when the server boots and before it accepts traffic, so by the time any proxy or any
 * page reads `process.env`, it is already whole and it never changes again.
 */
export function register(): void {
  // Node-only. The edge runtime has no filesystem, and this is a no-op there.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Imported lazily so the edge bundle never pulls in `node:fs`.
  void import('./lib/env')
    .then((module) => {
      module.loadRootEnv();
    })
    .catch(() => {
      // A missing or unreadable .env is the normal case in production. Every value has
      // a defined behaviour when absent, and `DASHBOARD_PASSWORD` fails closed.
    });
}
