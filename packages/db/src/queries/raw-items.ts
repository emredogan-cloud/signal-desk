import { desc, eq, sql, gte } from 'drizzle-orm';
import type { Db } from '../client.js';
import { rawItems, fetchLog, sources, type RawItemRow, type NewFetchLogRow } from '../schema.js';

/**
 * Writes into `raw_items`. **Insert only** — nothing here updates or deletes.
 *
 * That is the property Phase 4's re-clusterable events and Phase 12's zero-cost
 * offline replay are built on (ARCHITECTURE.md §7). An update path added here later
 * would silently remove both, so there isn't one.
 */

export type RawItemInput = {
  readonly sourceId: string;
  readonly externalId: string;
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly author: string | undefined;
  readonly publishedAt: Date | undefined;
  readonly contentHash: string;
  readonly rawPayload: string;
};

export type InsertResult = {
  readonly inserted: number;
  readonly duplicates: number;
};

/**
 * Insert items, skipping ones already stored.
 *
 * `onConflictDoNothing` on `(source_id, external_id)` is the whole deduplication
 * story at this layer: most feeds re-serve their entire window on every poll, so the
 * steady state is "20 items found, 0 new" and that must cost one statement rather
 * than a read-then-write race.
 */
export function insertRawItems(
  db: Db,
  items: readonly RawItemInput[],
  meta: { fetchedAt: Date; traceId: string; httpStatus: number | undefined },
): InsertResult {
  if (items.length === 0) return { inserted: 0, duplicates: 0 };

  let inserted = 0;

  // One transaction per fetch: either the batch lands or none of it does, so a crash
  // mid-write cannot leave a source looking half-ingested.
  db.transaction((tx) => {
    for (const item of items) {
      const result = tx
        .insert(rawItems)
        .values({
          sourceId: item.sourceId,
          externalId: item.externalId,
          url: item.url,
          title: item.title,
          body: item.body,
          author: item.author ?? null,
          publishedAt: item.publishedAt ?? null,
          fetchedAt: meta.fetchedAt,
          contentHash: item.contentHash,
          rawPayload: item.rawPayload,
          traceId: meta.traceId,
          httpStatus: meta.httpStatus ?? null,
        })
        .onConflictDoNothing()
        .run();

      if (result.changes > 0) inserted += 1;
    }
  });

  return { inserted, duplicates: items.length - inserted };
}

export function recordFetchLog(db: Db, entry: NewFetchLogRow): void {
  db.insert(fetchLog).values(entry).run();
}

export function countRawItems(db: Db, sourceId?: string): number {
  const query = db.select({ n: sql<number>`count(*)` }).from(rawItems);
  const row =
    sourceId === undefined ? query.get() : query.where(eq(rawItems.sourceId, sourceId)).get();
  return row?.n ?? 0;
}

export function recentRawItems(db: Db, limit = 50): RawItemRow[] {
  return db.select().from(rawItems).orderBy(desc(rawItems.fetchedAt)).limit(limit).all();
}

/**
 * Duplicate `(source_id, external_id)` pairs.
 *
 * ROADMAP.md Phase 3 acceptance: "a plausible item count with no duplicates in
 * `raw_items`". The unique index makes this structurally impossible, so this query
 * exists to *prove* it rather than to find problems — a check that can only return
 * zero is still worth running when the claim it backs is an acceptance criterion.
 */
export function duplicateExternalIds(
  db: Db,
): { sourceId: string; externalId: string; n: number }[] {
  return db
    .select({
      sourceId: rawItems.sourceId,
      externalId: rawItems.externalId,
      n: sql<number>`count(*)`,
    })
    .from(rawItems)
    .groupBy(rawItems.sourceId, rawItems.externalId)
    .having(sql`count(*) > 1`)
    .all();
}

export type IngestSummary = {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly priority: number;
  readonly fetches: number;
  readonly notModified: number;
  readonly itemsFound: number;
  readonly itemsNew: number;
  readonly failures: number;
  readonly lastOutcome: string | null;
};

/** Per-source ingestion telemetry over a window. Feeds the health panel. */
export function ingestSummary(db: Db, since: Date): IngestSummary[] {
  return db
    .select({
      sourceId: sources.id,
      sourceName: sources.name,
      priority: sources.priority,
      fetches: sql<number>`count(${fetchLog.id})`,
      notModified: sql<number>`sum(case when ${fetchLog.notModified} then 1 else 0 end)`,
      itemsFound: sql<number>`coalesce(sum(${fetchLog.itemsFound}), 0)`,
      itemsNew: sql<number>`coalesce(sum(${fetchLog.itemsNew}), 0)`,
      failures: sql<number>`sum(case when ${fetchLog.error} is not null then 1 else 0 end)`,
      lastOutcome: sql<string | null>`max(${fetchLog.outcome})`,
    })
    .from(sources)
    .leftJoin(
      fetchLog,
      sql`${fetchLog.sourceId} = ${sources.id} and ${fetchLog.startedAt} >= ${since}`,
    )
    .groupBy(sources.id)
    .orderBy(sources.priority, sources.id)
    .all();
}

/** Fetches recorded since `since`, newest first. */
export function recentFetches(db: Db, since: Date, limit = 200) {
  return db
    .select()
    .from(fetchLog)
    .where(gte(fetchLog.startedAt, since))
    .orderBy(desc(fetchLog.startedAt))
    .limit(limit)
    .all();
}
