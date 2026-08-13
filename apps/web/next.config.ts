import type { NextConfig } from 'next';

/**
 * Dashboard configuration.
 *
 * THREAT-MODEL.md §T-7 lands the full security posture here in Phase 10 (strict CSP
 * with no `unsafe-inline`, link-host display, localhost binding). The binding is
 * already enforced by the `--hostname 127.0.0.1` flag in this package's scripts.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source; Next compiles them in-place rather
  // than requiring a separate build step before `next dev` works.
  transpilePackages: ['@signal-desk/shared', '@signal-desk/db'],
  poweredByHeader: false,
};

export default nextConfig;
