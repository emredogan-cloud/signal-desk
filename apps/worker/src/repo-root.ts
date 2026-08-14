/**
 * Moved to `@signal-desk/shared` on 2026-08-14 — the dashboard needs the same answer
 * about where the repository root is, and two implementations of "where does the
 * database live" is exactly the kind of drift that produces a dashboard reading an
 * empty file next to a worker writing a full one. That is not hypothetical: it is the
 * defect this move was made to fix.
 *
 * Re-exported here so the fourteen existing call sites keep their import path.
 */
export { findRepoRoot } from '@signal-desk/shared';
