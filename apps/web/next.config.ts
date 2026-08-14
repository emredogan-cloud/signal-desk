import type { NextConfig } from 'next';

/**
 * Dashboard configuration.
 *
 * THREAT-MODEL.md §T-7 lands the full security posture here in Phase 10 (strict CSP
 * with no `unsafe-inline`, link-host display, localhost binding). The binding is
 * already enforced by the `--hostname 127.0.0.1` flag in this package's scripts.
 */
/**
 * Content-Security-Policy. `ROADMAP.md` Phase 10 / `THREAT-MODEL.md` §T-7.
 *
 * No `unsafe-inline`, no `unsafe-eval`, and `default-src 'none'` so anything not
 * explicitly allowed is denied rather than accidentally permitted. This is only
 * affordable because the dashboard is server-rendered with no client JavaScript —
 * a page that hydrated would need `script-src 'self'` and a nonce pipeline.
 *
 * `connect-src 'none'` matters more than it looks: even if hostile content somehow
 * reached execution, it would have nowhere to send what it found.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

/**
 * The workspace packages are **runtime Node dependencies, not bundler input.**
 *
 * ### The defect this fixes — 2026-08-14
 *
 * `pnpm web:dev` returned HTTP 500 with 35 `Module not found` errors — one per relative
 * import inside `@signal-desk/{shared,db,core}`. `pnpm build` succeeded. That split is
 * the whole explanation:
 *
 * Every internal package exports `{ "development": "./src/index.ts", "default":
 * "./dist/index.js" }` (PROJECT-MEMORY §C — it exists so `tsx` CLIs never execute a
 * stale `dist/`). Turbopack applies the `development` condition under `next dev`, so it
 * bundled raw TypeScript whose relative specifiers end in `.js` — the extension
 * `module: NodeNext` requires and `tsc` rewrites at emit. **Turbopack does not perform
 * that `.js` → `.ts` rewrite for source outside the app directory**, so every one of
 * them missed. Verified by probe: changing a single specifier to extensionless removed
 * exactly that one error and nothing else. `next build` does not apply `development`,
 * resolves `dist/index.js`, where the `.js` files physically exist — which is why a
 * green build never revealed this and only opening the page did.
 *
 * `transpilePackages` was the cause, not the cure: it is what pulled the packages into
 * the bundle in the first place. Turbopack has no `extensionAlias` equivalent
 * (`next.config` exposes only `root`, `rules`, `resolveAlias`, `resolveExtensions`,
 * `debugIds`), and `turbopack.resolveAlias` was measured to have no effect on these
 * specifiers at all.
 *
 * `serverExternalPackages` is the right mechanism on the merits, independent of the
 * bug: `@signal-desk/db` opens SQLite through `better-sqlite3`, a **native binding**
 * that cannot be bundled, and this dashboard is server-components-only — no workspace
 * value ever crosses into a client bundle (`mock-badge.tsx` imports a *type*, which is
 * erased). Node's own resolver loads `dist/index.js` in dev and in production alike, so
 * the two paths can no longer disagree. A package may not appear in both lists; Next
 * throws at build start if it does.
 *
 * Consequence, stated plainly: **editing a package requires `tsc -b` before the
 * dashboard sees it.** `pnpm web:dev` runs it, so the stale-`dist/` trap PROJECT-MEMORY
 * §C records for `tsx` scripts cannot reappear here by forgetting a step.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,

  // An arrow property rather than a method: a method here trips the `unbound-method`
  // scoping rule, and there is no `this` for it to bind anyway.
  headers: () =>
    Promise.resolve([
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: CSP },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          // The dashboard is bound to 127.0.0.1 and needs none of these.
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ]),
  // See the block above `nextConfig`. These are loaded by Node from their compiled
  // `dist/`, never bundled — which is both the fix for the dev-mode resolution failure
  // and the only way `better-sqlite3`'s native binding can load at all.
  serverExternalPackages: ['@signal-desk/shared', '@signal-desk/db', '@signal-desk/core'],
  poweredByHeader: false,
};

export default nextConfig;
