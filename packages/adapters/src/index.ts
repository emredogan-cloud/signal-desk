/**
 * `@signal-desk/adapters` — one module per ingestion mechanism.
 *
 * This is the only package that talks to the outside world, which makes it the one
 * place the resource limits, the SSRF guards, `robots.txt` compliance, and the
 * per-source circuit breaker from THREAT-MODEL.md §T-6, §T-8, and §T-10 have to live.
 *
 * Every adapter ships with its `Mock*` twin (WORKING-DISCIPLINE.md, "When credentials
 * are missing"). The twin reads `fixtures/` — recorded real payloads — and runs the
 * *same parser* over them, so a full pipeline run is reproducible with networking
 * disabled and a mock proves something about the code that runs in production.
 *
 * Contents by phase:
 *   Phase 2 — safeFetch, source probing
 *   Phase 3 — feed adapters, HTML diffing, robots.txt, SSRF guards, resilience policy,
 *             GitHub REST enrichment with an explicit budget
 *   Phase 12 — XOwnedReadsAdapter (analytics only; X is never an ingestion source —
 *             SOURCE-INTELLIGENCE.md §0)
 */

export * from './types.js';
export * from './http.js';
export * from './ssrf.js';
export * from './robots.js';
export * from './resilience.js';
export * from './feed-parse.js';
export * from './feed-adapter.js';
export * from './html-diff.js';
export * from './github-api.js';
export * from './mock.js';
export * from './probe.js';
export * from './registry.js';
