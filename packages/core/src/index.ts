/**
 * `@signal-desk/core` — domain logic. **This package performs no I/O.**
 *
 * ARCHITECTURE.md §3: everything core needs is passed in. That constraint is what
 * makes scoring and clustering testable without a network, and it is what makes MOCK
 * mode a first-class citizen rather than a bolt-on. A `fetch`, an `fs` import, or a
 * database handle appearing in this package is a design error, not a shortcut.
 *
 * Contents by phase:
 *   Phase 2 — entities/    the entity + alias registry and resolver
 *   Phase 4 — normalize/   sanitisation, artifact extraction, CanonicalEvent drafts
 *   Phase 4 — cluster/     three-stage deduplication, embedder contract
 *   Phase 5 — score/       importance, brand relevance, confidence, the rule gate
 *   Phase 6 — analyze/     prompt assembly and AI orchestration
 *   Phase 7 — strategy/    X options, DON'T POST, experiment generator
 *   Phase 9 — trends/      trend lifecycle model
 */

export * from './entities/registry.js';
export * from './normalize/sanitize.js';
export * from './normalize/artifacts.js';
export * from './normalize/url.js';
export { contentHash as contentHashFor } from './normalize/content-hash.js';
export * from './normalize/normalize.js';
export * from './cluster/dedup.js';
export * from './cluster/embedder.js';
export * from './cluster/labelled-fixtures.js';
export * from './cluster/measure.js';
export * from './score/index.js';
export * from './security/injection-corpus.js';
export * from './strategy/index.js';
