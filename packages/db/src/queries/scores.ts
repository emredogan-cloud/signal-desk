import { desc, eq, sql, inArray, and, isNull } from 'drizzle-orm';
import type { ConfidenceLevel, EvidenceTag, EventCategory } from '@signal-desk/shared';
import type { Db } from '../client.js';
import { eventScores, events, evidence, sources, rawItems } from '../schema.js';

/**
 * Score persistence and the queries that read scores back.
 *
 * `event_scores` is **append-only**, like `raw_items` and for the same reason: the
 * series is the data. An event that scored 41 on Monday and 78 on Wednesday because
 * four more sources arrived is a fact about detection latency, and overwriting the 41
 * destroys it.
 */

export type ScoreInput = {
  readonly eventId: number;
  readonly importance: number;
  readonly brandRelevance: number;
  readonly velocity: number;
  readonly combined: number;
  readonly confidence: ConfidenceLevel;
  readonly evidenceTag: EvidenceTag;
  readonly breakdown: unknown;
  readonly caps: string[];
  readonly gatePassed: boolean;
  readonly gateKilledBy: string | null;
  readonly gateReason: string;
  readonly scoredWith: string;
};

export function insertScores(db: Db, rows: readonly ScoreInput[], scoredAt: Date): number {
  if (rows.length === 0) return 0;

  db.transaction((tx) => {
    for (const row of rows) {
      tx.insert(eventScores)
        .values({ ...row, scoredAt })
        .run();
    }
  });

  return rows.length;
}

/** Everything the scorer needs about an event, without it touching the database. */
export type ScorableRow = {
  readonly id: number;
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
  readonly eventOccurredAt: Date;
  readonly occurredAtIsEstimated: boolean;
  readonly firstSeenAt: Date;
  readonly injectionFlagged: boolean;
  readonly evidence: {
    sourceId: string;
    sourceCategory: string;
    isOfficial: boolean;
    reliability: number;
    publishedAt: Date;
  }[];
};

/**
 * Load events with their evidence, in one pass.
 *
 * Two queries rather than N+1: the evidence join is done once for the whole batch and
 * stitched in memory. Scoring 5,000 events with a per-event evidence query is the
 * same quadratic mistake the clustering pipeline already made once.
 */
export function loadScorableEvents(db: Db, limit = 10_000, afterId = 0): ScorableRow[] {
  const eventRows = db
    .select({
      id: events.id,
      title: events.title,
      summary: events.summary,
      category: events.category,
      entities: events.entities,
      artifacts: events.artifacts,
      eventOccurredAt: events.eventOccurredAt,
      occurredAtIsEstimated: events.occurredAtIsEstimated,
      firstSeenAt: events.firstSeenAt,
      injectionFlagged: events.injectionFlagged,
    })
    .from(events)
    .where(and(isNull(events.mergedIntoEventId), sql`${events.id} > ${afterId}`))
    .orderBy(events.id)
    .limit(limit)
    .all();

  if (eventRows.length === 0) return [];

  const evidenceRows = db
    .select({
      eventId: evidence.eventId,
      sourceId: evidence.sourceId,
      sourceCategory: sources.category,
      isOfficial: sources.isOfficial,
      reliability: sources.reliability,
      publishedAt: rawItems.publishedAt,
      fetchedAt: rawItems.fetchedAt,
    })
    .from(evidence)
    .innerJoin(sources, eq(sources.id, evidence.sourceId))
    .innerJoin(rawItems, eq(rawItems.id, evidence.rawItemId))
    .where(
      inArray(
        evidence.eventId,
        eventRows.map((row) => row.id),
      ),
    )
    .all();

  const byEvent = new Map<number, ScorableRow['evidence']>();
  for (const row of evidenceRows) {
    const list = byEvent.get(row.eventId) ?? [];
    list.push({
      sourceId: row.sourceId,
      sourceCategory: row.sourceCategory,
      isOfficial: row.isOfficial,
      reliability: row.reliability,
      // Fall back to fetch time: an evidence row with no publisher timestamp still
      // has a position in the arrival sequence, which is what velocity reads.
      publishedAt: row.publishedAt ?? row.fetchedAt,
    });
    byEvent.set(row.eventId, list);
  }

  return eventRows.map((row) => ({ ...row, evidence: byEvent.get(row.id) ?? [] }));
}

/**
 * The latest score per event, joined to the event. The dashboard's stream query.
 *
 * `gatePassedOnly` filters **in SQL**, before the LIMIT. An earlier version applied
 * the LIMIT first and filtered the result in JavaScript, so asking for 100 gate
 * survivors returned however many happened to fall inside the top 100 by score — a
 * partial set with no indication it was partial. That silently changed the measured
 * restraint rate from 50.8% to 21.1% depending only on the `--limit` flag, and made
 * the alerts CLI miss a manual-flagged event entirely.
 *
 * Same class of mistake as the Phase 5 pipeline bug: a LIMIT read as a ceiling when
 * it is actually a truncation.
 */
/**
 * The latest score for each event, ranked.
 *
 * ### MEASURED — 2026-08-14 — why this is `in (select max(id) …)` and not a join
 *
 * This function used to join a `group by` sub-select as a derived table. On the
 * deployed database it took **165 seconds** for the gate-filtered call, and 45ms for
 * the unfiltered one — the same work, a thousandfold apart, because the two took
 * different query plans.
 *
 * `explain query plan` on the join form:
 *
 *     SEARCH s USING INDEX event_scores_gate_idx (gate_passed=?)
 *     SCAN l                      ← the whole grouped sub-select, per matching row
 *
 * `event_scores` is **append-only score history** by design (§7: "scores change as
 * evidence accumulates; keep the series"), so it had grown to **169,178 rows for
 * 5,372 events** — roughly thirty score rows per event after a month of pipeline
 * cycles. Re-scanning that per gate survivor is where the time went, and it gets
 * worse on every run.
 *
 * The `in (select …)` form materialises the sub-select **once** into an ephemeral
 * list, then the outer query is an index lookup:
 *
 *     SEARCH s USING INDEX event_scores_gate_idx (gate_passed=? AND rowid=?)
 *     LIST SUBQUERY 1
 *       SCAN event_scores USING COVERING INDEX event_scores_event_idx
 *
 * Measured on the same database, same results, byte-identical: **161ms**.
 *
 * The lesson worth keeping is not "use IN". It is that this table grows without bound
 * by design, so any query over it has to be checked against a database that has
 * actually accumulated history — a local database a few hours old will take the fast
 * plan and prove nothing.
 */
export function latestScores(db: Db, limit = 50, gatePassedOnly = false) {
  const latestIds = db
    .select({ maxId: sql<number>`max(${eventScores.id})` })
    .from(eventScores)
    .groupBy(eventScores.eventId);

  const rows = db
    .select({
      eventId: events.id,
      title: events.title,
      category: events.category,
      entities: events.entities,
      eventOccurredAt: events.eventOccurredAt,
      evidenceCount: events.evidenceCount,
      distinctSourceCount: events.distinctSourceCount,
      importance: eventScores.importance,
      brandRelevance: eventScores.brandRelevance,
      combined: eventScores.combined,
      confidence: eventScores.confidence,
      evidenceTag: eventScores.evidenceTag,
      gatePassed: eventScores.gatePassed,
      gateKilledBy: eventScores.gateKilledBy,
      gateReason: eventScores.gateReason,
      caps: eventScores.caps,
      breakdown: eventScores.breakdown,
      scoredAt: eventScores.scoredAt,
    })
    .from(eventScores)
    .innerJoin(events, eq(events.id, eventScores.eventId))
    .where(
      gatePassedOnly
        ? and(inArray(eventScores.id, latestIds), eq(eventScores.gatePassed, true))
        : inArray(eventScores.id, latestIds),
    )
    .orderBy(desc(eventScores.combined))
    .limit(limit)
    .all();

  return rows;
}

/**
 * Gate kill-rate over the stored scores. The Phase 5 acceptance measurement.
 *
 * Reported **twice**, because one number would mislead. The first ingest backfilled
 * whole archives — Vercel's changelog alone carries 1,463 entries going back years —
 * so an overall kill rate is dominated by `too_old` and flatters the gate enormously.
 * The second figure excludes everything the staleness rule killed, and is the closer
 * proxy for steady-state daily volume, where almost nothing is old.
 */
export function gateKillRate(db: Db): {
  total: number;
  passed: number;
  killed: number;
  killRate: number;
  /** Excluding everything the staleness rule killed — the steady-state proxy. */
  inWindowTotal: number;
  inWindowKilled: number;
  inWindowKillRate: number;
  byRule: { rule: string; n: number }[];
} {
  const latest = db
    .select({
      eventId: eventScores.eventId,
      maxId: sql<number>`max(${eventScores.id})`.as('max_id'),
    })
    .from(eventScores)
    .groupBy(eventScores.eventId)
    .as('latest');

  const rows = db
    .select({ gatePassed: eventScores.gatePassed, killedBy: eventScores.gateKilledBy })
    .from(eventScores)
    .innerJoin(latest, eq(latest.maxId, eventScores.id))
    .all();

  const byRuleMap = new Map<string, number>();
  let killed = 0;
  for (const row of rows) {
    if (row.gatePassed) continue;
    killed += 1;
    const rule = row.killedBy ?? 'unknown';
    byRuleMap.set(rule, (byRuleMap.get(rule) ?? 0) + 1);
  }

  const tooOld = byRuleMap.get('too_old') ?? 0;
  const inWindowTotal = rows.length - tooOld;
  const inWindowKilled = killed - tooOld;

  return {
    total: rows.length,
    passed: rows.length - killed,
    killed,
    killRate: rows.length === 0 ? 0 : killed / rows.length,
    inWindowTotal,
    inWindowKilled,
    inWindowKillRate: inWindowTotal === 0 ? 0 : inWindowKilled / inWindowTotal,
    byRule: [...byRuleMap.entries()].map(([rule, n]) => ({ rule, n })).sort((a, b) => b.n - a.n),
  };
}

/** Discard every stored score. Scores are derived; recompute (ROADMAP.md Phase 5). */
export function clearScores(db: Db): void {
  db.delete(eventScores).run();
}

export function countScores(db: Db): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(eventScores)
      .get()?.n ?? 0
  );
}
