/**
 * `@signal-desk/adapters` — one module per ingestion mechanism.
 *
 * This is the only package that talks to the outside world, which makes it the one
 * place the resource limits and — from Phase 3 — the SSRF guards, `robots.txt`
 * compliance, and conditional-request handling from THREAT-MODEL.md §T-6 and §T-8
 * have to live.
 *
 * Every adapter ships with its `Mock*` twin in the same change (WORKING-DISCIPLINE.md,
 * "When credentials are missing"). The twin reads `fixtures/` — recorded real
 * payloads — so a full pipeline run is reproducible with networking disabled.
 *
 * Contents by phase:
 *   Phase 2 — safeFetch (timeout, size cap, redirect cap), source probing
 *   Phase 3 — RssAdapter, GithubAtomAdapter, GithubApiAdapter, StatusPageAdapter,
 *             HtmlDiffAdapter, the SSRF host allowlist, per-source circuit breaker
 *   Phase 12 — XOwnedReadsAdapter (analytics only; X is never an ingestion source —
 *             SOURCE-INTELLIGENCE.md §0)
 */

export * from './http.js';
export * from './probe.js';
