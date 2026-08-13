import { createHash } from 'node:crypto';

/**
 * Stable content hash. Deduplication **stage 1** (ARCHITECTURE.md §5).
 *
 * Hashes the *normalised* title, URL, and body so a publisher re-serialising the
 * same item with different whitespace does not read as a change. Deliberately
 * excludes timestamps: several feeds rewrite `pubDate` on every build, and including
 * it would make every poll look like new content and defeat stage 1 entirely.
 *
 * Lives in `core` because clustering is the consumer, and is used by
 * `packages/adapters` at ingest time so both sides compute the same value. Two
 * implementations that drift apart would silently stop deduplicating.
 */
export function contentHash(parts: { title: string; url: string; body: string }): string {
  const normalise = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
  return createHash('sha256')
    .update(`${normalise(parts.title)}\n${normalise(parts.url)}\n${normalise(parts.body)}`)
    .digest('hex');
}
