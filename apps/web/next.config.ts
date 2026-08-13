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
  // Workspace packages ship TypeScript source; Next compiles them in-place rather
  // than requiring a separate build step before `next dev` works.
  transpilePackages: ['@signal-desk/shared', '@signal-desk/db', '@signal-desk/core'],
  poweredByHeader: false,
};

export default nextConfig;
