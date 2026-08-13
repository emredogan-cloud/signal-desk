/// <reference types="next" />
/// <reference types="next/image-types/global" />

/**
 * Committed companion to `next-env.d.ts`.
 *
 * Next rewrites `next-env.d.ts` on every build and points it at files under `.next/`
 * that do not exist on a clean clone. Since the verify chain lints and type-checks
 * *before* it builds, that generated file cannot be the only source of Next's
 * ambient types — CSS imports and route types would fail to resolve on a fresh
 * checkout. This file provides the stable half; `next-env.d.ts` stays generated and
 * gitignored.
 */
