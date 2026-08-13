import { and, desc, eq, gt, gte, isNull, sql, inArray } from 'drizzle-orm';
import type { EventCategory } from '@signal-desk/shared';
import type { Db } from '../client.js';
import {
  events,
  evidence,
  eventEmbeddings,
  mergeAudit,
  rawItems,
  sources,
  type EventRow,
  type EvidenceRow,
} from '../schema.js';

/**
 * Event and evidence persistence.
 *
 * `events` is derived from `raw_items` and may be rebuilt at any time. The one thing
 * that must survive a rebuild is **operator intent** — an unmerge the operator
 * performed by hand. That is why `merge_audit` records an `actor`, and why
 * `rebuildEvents` does not exist in this file: dropping and recomputing must be a
 * deliberate, named operation, not something a query helper can do by accident.
 */

export type CandidateRow = {
  readonly eventId: number;
  readonly category: EventCategory;
  readonly entities: string[];
  readonly artifacts: {
    models: string[];
    versions: string[];
    repos: string[];
    titleModels: string[];
    titleVersions: string[];
  };
  readonly eventOccurredAt: Date;
  readonly primarySourceCategory: string;
  readonly canonicalUrls: string[];
  readonly contentHashes: string[];
  readonly embedding: Buffer | null;
};

/**
 * Clustering candidates: canonical events near this one in time.
 *
 * Bounded by the window rather than loading every event, because stage 2 and stage 3
 * are both window-restricted anyway and the table grows without bound. Stage 1 is
 * *not* window-restricted, which is handled by also matching on URL and hash
 * regardless of age — see `findByUrlOrHash`.
 */
export function clusterCandidates(db: Db, since: Date, limit = 500): CandidateRow[] {
  const rows = db
    .select({
      eventId: events.id,
      category: events.category,
      entities: events.entities,
      artifacts: events.artifacts,
      eventOccurredAt: events.eventOccurredAt,
      primarySourceCategory: sources.category,
      embedding: eventEmbeddings.embedding,
    })
    .from(events)
    .innerJoin(sources, eq(sources.id, events.primarySourceId))
    .leftJoin(eventEmbeddings, eq(eventEmbeddings.eventId, events.id))
    .where(and(gte(events.eventOccurredAt, since), isNull(events.mergedIntoEventId)))
    .orderBy(desc(events.eventOccurredAt))
    .limit(limit)
    .all();

  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.eventId);
  const evidenceRows = db
    .select({
      eventId: evidence.eventId,
      canonicalUrl: evidence.canonicalUrl,
      contentHash: evidence.contentHash,
    })
    .from(evidence)
    .where(inArray(evidence.eventId, ids))
    .all();

  const urlsByEvent = new Map<number, string[]>();
  const hashesByEvent = new Map<number, string[]>();
  for (const row of evidenceRows) {
    (urlsByEvent.get(row.eventId) ?? urlsByEvent.set(row.eventId, []).get(row.eventId)!).push(
      row.canonicalUrl,
    );
    (hashesByEvent.get(row.eventId) ?? hashesByEvent.set(row.eventId, []).get(row.eventId)!).push(
      row.contentHash,
    );
  }

  return rows.map((row) => ({
    ...row,
    canonicalUrls: urlsByEvent.get(row.eventId) ?? [],
    contentHashes: hashesByEvent.get(row.eventId) ?? [],
  }));
}

/**
 * Stage-1 lookup, unbounded by time.
 *
 * A re-fetch of a two-year-old post is still the same post. Applying the clustering
 * window here would create a duplicate event for anything older than 48 hours, which
 * is the opposite of what stage 1 is for.
 */
export function findEventByUrlOrHash(
  db: Db,
  canonicalUrl: string,
  contentHash: string,
): number | undefined {
  const row = db
    .select({ eventId: evidence.eventId })
    .from(evidence)
    .where(
      sql`${evidence.canonicalUrl} = ${canonicalUrl} or ${evidence.contentHash} = ${contentHash}`,
    )
    .limit(1)
    .get();

  return row?.eventId;
}

export type CreateEventInput = {
  readonly title: string;
  readonly summary: string;
  readonly category: EventCategory;
  readonly entities: string[];
  readonly artifacts: {
    models: string[];
    versions: string[];
    repos: string[];
    titleModels: string[];
    titleVersions: string[];
  };
  readonly firstSeenAt: Date;
  readonly eventOccurredAt: Date;
  readonly occurredAtIsEstimated: boolean;
  readonly primarySourceId: string;
  readonly primaryRawItemId: number;
  readonly hasOfficialSource: boolean;
  readonly injectionFlagged: boolean;
};

export function createEvent(db: Db, input: CreateEventInput, now: Date): number {
  const result = db
    .insert(events)
    .values({
      ...input,
      updatedAt: now,
      evidenceCount: 0,
      distinctSourceCount: 0,
      status: 'new',
    })
    .run();

  return Number(result.lastInsertRowid);
}

export type AttachEvidenceInput = {
  readonly eventId: number;
  readonly rawItemId: number;
  readonly sourceId: string;
  readonly role: 'primary' | 'corroborating' | 'reaction';
  readonly mergeStage: number | null;
  readonly similarity: number | null;
  readonly canonicalUrl: string;
  readonly contentHash: string;
};

export function attachEvidence(db: Db, input: AttachEvidenceInput, now: Date): boolean {
  const result = db
    .insert(evidence)
    .values({ ...input, attachedAt: now })
    .onConflictDoNothing()
    .run();

  return result.changes > 0;
}

/**
 * Recompute the denormalised counts on an event from its evidence.
 *
 * Recomputed rather than incremented: an increment that runs twice, or that runs on
 * a row the unique index rejected, drifts from reality and there is no way to notice.
 * The counts are small and the query is indexed.
 */
export function refreshEventAggregates(db: Db, eventId: number, now: Date): void {
  const stats = db
    .select({
      evidenceCount: sql<number>`count(*)`,
      distinctSourceCount: sql<number>`count(distinct ${evidence.sourceId})`,
      hasOfficial: sql<number>`max(case when ${sources.isOfficial} then 1 else 0 end)`,
    })
    .from(evidence)
    .innerJoin(sources, eq(sources.id, evidence.sourceId))
    .where(eq(evidence.eventId, eventId))
    .get();

  db.update(events)
    .set({
      evidenceCount: stats?.evidenceCount ?? 0,
      distinctSourceCount: stats?.distinctSourceCount ?? 0,
      hasOfficialSource: (stats?.hasOfficial ?? 0) === 1,
      updatedAt: now,
    })
    .where(eq(events.id, eventId))
    .run();
}

export function setPrimarySource(
  db: Db,
  eventId: number,
  sourceId: string,
  rawItemId: number,
  now: Date,
): void {
  db.transaction((tx) => {
    // Demote whoever held the role. Two primaries is a state nothing downstream
    // expects, and it is silently produced by promoting without demoting.
    tx.update(evidence)
      .set({ role: 'corroborating' })
      .where(and(eq(evidence.eventId, eventId), eq(evidence.role, 'primary')))
      .run();

    tx.update(evidence)
      .set({ role: 'primary' })
      .where(and(eq(evidence.eventId, eventId), eq(evidence.rawItemId, rawItemId)))
      .run();

    tx.update(events)
      .set({ primarySourceId: sourceId, primaryRawItemId: rawItemId, updatedAt: now })
      .where(eq(events.id, eventId))
      .run();
  });
}

export function upsertEventEmbedding(
  db: Db,
  input: {
    eventId: number;
    model: string;
    dimensions: number;
    embedding: Buffer;
    sourceText: string;
  },
  now: Date,
): void {
  db.insert(eventEmbeddings)
    .values({ ...input, createdAt: now })
    .onConflictDoUpdate({
      target: eventEmbeddings.eventId,
      set: {
        model: input.model,
        dimensions: input.dimensions,
        embedding: input.embedding,
        sourceText: input.sourceText,
        createdAt: now,
      },
    })
    .run();
}

export function recordMergeAudit(
  db: Db,
  entry: {
    action: 'merge' | 'unmerge' | 'split';
    rawItemId: number;
    fromEventId: number | null;
    toEventId: number | null;
    stage: number | null;
    similarity: number | null;
    reason: string;
    actor: 'pipeline' | 'operator';
  },
  now: Date,
): void {
  db.insert(mergeAudit)
    .values({ ...entry, createdAt: now })
    .run();
}

// ─────────────────────────── unmerge ───────────────────────────

export type UnmergeResult = {
  readonly movedRawItemId: number;
  readonly fromEventId: number;
  readonly toEventId: number;
  readonly sourceEventDeleted: boolean;
};

/**
 * Detach one evidence item into an event of its own. **The reverse of a merge.**
 *
 * ARCHITECTURE.md §5 requires this to restore prior state exactly, and the acceptance
 * criterion tests it. Three things have to happen together or none of them:
 *
 *  1. the item moves to a new event carrying its own title, category, and timestamps
 *  2. both events' aggregates are recomputed
 *  3. an audit row records it as an **operator** action, so the pipeline does not
 *     helpfully re-merge it on the next pass
 *
 * If the item was the last evidence on its event, the now-empty event is deleted
 * rather than left as a ghost with zero evidence.
 */
export function unmergeEvidence(
  db: Db,
  rawItemId: number,
  actor: 'pipeline' | 'operator',
  reason: string,
  now: Date,
): UnmergeResult | undefined {
  return db.transaction((tx) => {
    const row = tx
      .select({
        id: evidence.id,
        eventId: evidence.eventId,
        sourceId: evidence.sourceId,
        canonicalUrl: evidence.canonicalUrl,
        contentHash: evidence.contentHash,
        role: evidence.role,
      })
      .from(evidence)
      .where(eq(evidence.rawItemId, rawItemId))
      .get();

    if (row === undefined) return undefined;

    const item = tx
      .select({
        title: rawItems.title,
        body: rawItems.body,
        publishedAt: rawItems.publishedAt,
        fetchedAt: rawItems.fetchedAt,
      })
      .from(rawItems)
      .where(eq(rawItems.id, rawItemId))
      .get();

    if (item === undefined) return undefined;

    const parent = tx.select().from(events).where(eq(events.id, row.eventId)).get();
    if (parent === undefined) return undefined;

    const newEventId = Number(
      tx
        .insert(events)
        .values({
          title: item.title,
          summary: item.body.slice(0, 2000),
          // Category and entities are inherited: they were computed by the pipeline
          // from this item among others, and recomputing them here would need the
          // normaliser, which this layer must not depend on.
          category: parent.category,
          entities: parent.entities,
          artifacts: parent.artifacts,
          firstSeenAt: item.fetchedAt,
          eventOccurredAt: item.publishedAt ?? item.fetchedAt,
          occurredAtIsEstimated: item.publishedAt === null,
          updatedAt: now,
          primarySourceId: row.sourceId,
          primaryRawItemId: rawItemId,
          status: 'new',
        })
        .run().lastInsertRowid,
    );

    tx.update(evidence)
      .set({ eventId: newEventId, role: 'primary', mergeStage: null, similarity: null })
      .where(eq(evidence.id, row.id))
      .run();

    const remaining =
      tx
        .select({ n: sql<number>`count(*)` })
        .from(evidence)
        .where(eq(evidence.eventId, row.eventId))
        .get()?.n ?? 0;

    let sourceEventDeleted = false;
    if (remaining === 0) {
      tx.delete(events).where(eq(events.id, row.eventId)).run();
      sourceEventDeleted = true;
    } else {
      // Recompute the source event's denormalised counts INSIDE the transaction.
      // Without this the event keeps claiming the evidence it no longer has, and
      // nothing ever notices: the counts are only read, never re-derived. A test
      // caught it by asserting the count rather than the row set.
      const stats = tx
        .select({
          evidenceCount: sql<number>`count(*)`,
          distinctSourceCount: sql<number>`count(distinct ${evidence.sourceId})`,
          hasOfficial: sql<number>`max(case when ${sources.isOfficial} then 1 else 0 end)`,
        })
        .from(evidence)
        .innerJoin(sources, eq(sources.id, evidence.sourceId))
        .where(eq(evidence.eventId, row.eventId))
        .get();

      tx.update(events)
        .set({
          evidenceCount: stats?.evidenceCount ?? 0,
          distinctSourceCount: stats?.distinctSourceCount ?? 0,
          hasOfficialSource: (stats?.hasOfficial ?? 0) === 1,
          updatedAt: now,
        })
        .where(eq(events.id, row.eventId))
        .run();

      // If the moved item held the primary role, the event needs a new primary or it
      // points at evidence that is no longer attached to it.
      if (row.role === 'primary') {
        const replacement = tx
          .select({ rawItemId: evidence.rawItemId, sourceId: evidence.sourceId })
          .from(evidence)
          .where(eq(evidence.eventId, row.eventId))
          .limit(1)
          .get();

        if (replacement !== undefined) {
          tx.update(evidence)
            .set({ role: 'primary' })
            .where(
              and(eq(evidence.eventId, row.eventId), eq(evidence.rawItemId, replacement.rawItemId)),
            )
            .run();
          tx.update(events)
            .set({
              primarySourceId: replacement.sourceId,
              primaryRawItemId: replacement.rawItemId,
              updatedAt: now,
            })
            .where(eq(events.id, row.eventId))
            .run();
        }
      }
    }

    // The new event carries exactly one evidence row.
    tx.update(events)
      .set({ evidenceCount: 1, distinctSourceCount: 1, updatedAt: now })
      .where(eq(events.id, newEventId))
      .run();

    tx.insert(mergeAudit)
      .values({
        action: 'unmerge',
        rawItemId,
        fromEventId: row.eventId,
        toEventId: newEventId,
        stage: null,
        similarity: null,
        reason,
        actor,
        createdAt: now,
      })
      .run();

    return {
      movedRawItemId: rawItemId,
      fromEventId: row.eventId,
      toEventId: newEventId,
      sourceEventDeleted,
    };
  });
}

/** Raw items the operator has unmerged. The pipeline must not re-merge these. */
export function operatorUnmergedRawItems(db: Db): Set<number> {
  const rows = db
    .select({ rawItemId: mergeAudit.rawItemId })
    .from(mergeAudit)
    .where(and(eq(mergeAudit.action, 'unmerge'), eq(mergeAudit.actor, 'operator')))
    .all();

  return new Set(rows.map((r) => r.rawItemId));
}

// ─────────────────────────── reads ───────────────────────────

export function countEvents(db: Db): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(events)
      .where(isNull(events.mergedIntoEventId))
      .get()?.n ?? 0
  );
}

export function recentEvents(db: Db, limit = 50): EventRow[] {
  return db
    .select()
    .from(events)
    .where(isNull(events.mergedIntoEventId))
    .orderBy(desc(events.eventOccurredAt))
    .limit(limit)
    .all();
}

export function eventEvidence(db: Db, eventId: number): EvidenceRow[] {
  return db.select().from(evidence).where(eq(evidence.eventId, eventId)).all();
}

/**
 * Raw items not yet attached to any event. The pipeline's work queue.
 *
 * The limit is a batching bound, not a ceiling on what gets clustered — the caller
 * loops until it comes back empty. It was originally a silent cap, and the first
 * real run quietly processed 5,000 of 5,208 items and reported success. §36 of the
 * working brief: make the degradation visible, or do not degrade.
 */
export function unclusteredRawItemIds(db: Db, limit = 5000, afterId = 0): number[] {
  const rows = db
    .select({ id: rawItems.id })
    .from(rawItems)
    .leftJoin(evidence, eq(evidence.rawItemId, rawItems.id))
    .where(and(isNull(evidence.id), gt(rawItems.id, afterId)))
    .orderBy(rawItems.id)
    .limit(limit)
    .all();

  return rows.map((r) => r.id);
}

/** Delete every derived row. `events` is recomputable; `raw_items` is not touched. */
export function clearDerivedEvents(db: Db): void {
  db.transaction((tx) => {
    tx.delete(eventEmbeddings).run();
    tx.delete(evidence).run();
    tx.delete(events).run();
  });
}

export type RawItemWithSource = {
  readonly id: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly contentHash: string;
  readonly publishedAt: Date | null;
  readonly fetchedAt: Date;
  readonly sourceId: string;
  readonly sourceCategory: string;
  readonly isOfficial: boolean;
  readonly reliability: number;
  readonly sourceEntity: string | null;
};

/**
 * Load raw items with their source metadata, **in the order the ids were given**.
 *
 * `IN (…)` makes no promise about row order, and clustering determinism depends on
 * processing items in `raw_items.id` order — arrival order, which is stable. A
 * pipeline that clusters in whatever order SQLite returned produces different events
 * on a replay than it did live, which would quietly invalidate Phase 12's entire
 * premise.
 */
export function loadRawItemsWithSource(db: Db, ids: readonly number[]): RawItemWithSource[] {
  if (ids.length === 0) return [];

  const rows = db
    .select({
      id: rawItems.id,
      title: rawItems.title,
      body: rawItems.body,
      url: rawItems.url,
      contentHash: rawItems.contentHash,
      publishedAt: rawItems.publishedAt,
      fetchedAt: rawItems.fetchedAt,
      sourceId: sources.id,
      sourceCategory: sources.category,
      isOfficial: sources.isOfficial,
      reliability: sources.reliability,
      sourceEntity: sources.entity,
    })
    .from(rawItems)
    .innerJoin(sources, eq(sources.id, rawItems.sourceId))
    .where(inArray(rawItems.id, [...ids]))
    .all();

  const byId = new Map(rows.map((row) => [row.id, row]));
  return [...ids].map((id) => byId.get(id)).filter((row) => row !== undefined);
}
