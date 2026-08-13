import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../client.js';
import { sources, type NewSourceRow, type SourceRow } from '../schema.js';

/** Source-registry queries. Everything the probe CLI and, from Phase 3, the
 *  scheduler needs to read and write a source row. */

export function listSources(db: Db, options: { activeOnly?: boolean } = {}): SourceRow[] {
  const query = db.select().from(sources).orderBy(asc(sources.priority), asc(sources.id));
  const rows = query.all();
  return options.activeOnly === true ? rows.filter((r) => r.active) : rows;
}

export function getSource(db: Db, id: string): SourceRow | undefined {
  return db.select().from(sources).where(eq(sources.id, id)).get();
}

export function insertSource(db: Db, row: NewSourceRow): void {
  db.insert(sources).values(row).run();
}

export function setSourceActive(db: Db, id: string, active: boolean, now = new Date()): void {
  db.update(sources).set({ active, updatedAt: now }).where(eq(sources.id, id)).run();
}

/**
 * Record the result of a fetch attempt.
 *
 * Three timestamps move independently, and which ones move is the whole signal:
 *
 *   checked  always — proves the scheduler ran
 *   success  only on a successful fetch — a 500 loop leaves this stale while
 *            `checked` keeps advancing, which is what distinguishes "the feed is
 *            broken" from "the worker is dead"
 *   event    only when the fetch actually yielded items — a feed that parses to zero
 *            items has died in the way that matters (T-9) while still answering 200
 */
export function recordFetchAttempt(
  db: Db,
  id: string,
  result: {
    readonly succeeded: boolean;
    readonly itemCount: number;
    readonly etag?: string | undefined;
    readonly lastModified?: string | undefined;
    /** Set when the probe confirms the URL still serves a valid feed. */
    readonly verified?: boolean;
  },
  now: Date = new Date(),
): void {
  const patch: Partial<NewSourceRow> = {
    lastCheckedAt: now,
    updatedAt: now,
  };

  if (result.succeeded) {
    patch.lastSuccessAt = now;
    if (result.etag !== undefined) patch.etag = result.etag;
    if (result.lastModified !== undefined) patch.lastModified = result.lastModified;
    if (result.verified === true) patch.verifiedAt = now;
  }
  if (result.itemCount > 0) {
    patch.lastEventAt = now;
  }

  db.update(sources).set(patch).where(eq(sources.id, id)).run();
}

/**
 * Sources that have produced nothing for longer than their tier allows.
 *
 * THREAT-MODEL.md §T-9 sets the thresholds: Priority-1 silent for 6 hours,
 * Priority-2 for 24. This is the query behind the freshness panel and, in Phase 11,
 * the freshness alert.
 */
export function staleSources(
  db: Db,
  now: Date = new Date(),
  thresholdsSec: Record<number, number> = {
    1: 6 * 3600,
    2: 24 * 3600,
    3: 72 * 3600,
    4: 14 * 86400,
  },
): { source: SourceRow; silentForSec: number; thresholdSec: number }[] {
  const out: { source: SourceRow; silentForSec: number; thresholdSec: number }[] = [];

  for (const source of listSources(db, { activeOnly: true })) {
    const threshold = thresholdsSec[source.priority];
    if (threshold === undefined) continue;

    // A source that has never succeeded is measured from when it was created —
    // otherwise a feed that was wrong from the first minute never looks stale.
    const reference = source.lastSuccessAt ?? source.createdAt;
    const silentForSec = Math.floor((now.getTime() - reference.getTime()) / 1000);

    if (silentForSec > threshold) {
      out.push({ source, silentForSec, thresholdSec: threshold });
    }
  }

  return out.sort(
    (a, b) => a.source.priority - b.source.priority || b.silentForSec - a.silentForSec,
  );
}

export function countSourcesByPriority(db: Db): Record<number, number> {
  const rows = db
    .select({ priority: sources.priority, n: sql<number>`count(*)` })
    .from(sources)
    .where(and(eq(sources.active, true)))
    .groupBy(sources.priority)
    .all();

  return Object.fromEntries(rows.map((r) => [r.priority, r.n]));
}
