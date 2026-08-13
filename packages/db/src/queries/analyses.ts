import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { ConfidenceLevel } from '@signal-desk/shared';
import type { Db } from '../client.js';
import { analyses, events, eventScores, spendLedger } from '../schema.js';

/**
 * Analysis persistence and the spend ledger.
 *
 * The cost column is the budget guard's memory. It is stored in **micro-dollars as an
 * integer** rather than a float: a day's spend is a running sum of hundreds of small
 * amounts, and binary floating point accumulates error across that many additions. A
 * budget that drifts is a budget that either overspends silently or stops early for
 * no visible reason — both are the failure the guard exists to prevent.
 */

export type AnalysisInsert = {
  readonly eventId: number;
  readonly stage: 'triage' | 'analysis';
  readonly status: 'ok' | 'skipped' | 'refused' | 'failed';
  readonly reason: string;
  readonly skipCode: string | null;
  readonly payload: unknown;
  readonly confidence: ConfidenceLevel | null;
  readonly recommendedAction: string | null;
  readonly injectionObserved: boolean;
  readonly model: string;
  readonly promptVersion: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
};

export function insertAnalyses(db: Db, rows: readonly AnalysisInsert[], createdAt: Date): number {
  if (rows.length === 0) return 0;

  db.transaction((tx) => {
    for (const row of rows) {
      const { costUsd, ...rest } = row;
      const micro = Math.round(costUsd * 1_000_000);

      tx.insert(analyses)
        .values({ ...rest, costMicroUsd: micro, createdAt })
        .run();

      // Also record it where `--reset` cannot reach. An analysis is derived and can be
      // thrown away; the money was spent either way, and the budget guard has to read
      // a number that reflects that.
      if (micro > 0 || rest.inputTokens > 0 || rest.outputTokens > 0) {
        tx.insert(spendLedger)
          .values({
            stage: rest.stage,
            model: rest.model,
            inputTokens: rest.inputTokens,
            outputTokens: rest.outputTokens,
            cacheReadTokens: rest.cacheReadTokens,
            cacheWriteTokens: rest.cacheWriteTokens,
            costMicroUsd: micro,
            spentAt: createdAt,
          })
          .run();
      }
    }
  });

  return rows.length;
}

/**
 * Spend since a given instant, in USD.
 *
 * The budget guard calls this before every run to learn where it stands. Summing the
 * ledger rather than keeping a counter means the figure survives a restart and cannot
 * drift from what was actually recorded.
 */
export function spendSince(db: Db, since: Date): number {
  // Reads the LEDGER, not `analyses`. Reading `analyses` meant `--reset` zeroed the
  // figure the budget guard depends on.
  const row = db
    .select({ total: sql<number>`coalesce(sum(${spendLedger.costMicroUsd}), 0)` })
    .from(spendLedger)
    .where(gte(spendLedger.spentAt, since))
    .get();
  return (row?.total ?? 0) / 1_000_000;
}

/**
 * Cost broken down by stage and model — what Phase 6 must record in ARCHITECTURE §6.
 *
 * `calls` counts rows where a request was actually **sent** (ok, failed, or refused),
 * not every row. A skipped stage still records which model it *would* have used, and
 * an earlier version of this query counted those as calls — so a MOCK run reported
 * "25 calls to claude-opus-5" having made none. That is precisely the fabricated-live-
 * result failure the project forbids, so skips are counted in their own column.
 */
export function spendBreakdown(
  db: Db,
  since: Date,
): {
  stage: string;
  model: string;
  calls: number;
  skipped: number;
  costUsd: number;
  cacheReads: number;
}[] {
  return db
    .select({
      stage: analyses.stage,
      model: analyses.model,
      calls: sql<number>`sum(case when ${analyses.status} = 'skipped' then 0 else 1 end)`,
      skipped: sql<number>`sum(case when ${analyses.status} = 'skipped' then 1 else 0 end)`,
      micro: sql<number>`coalesce(sum(${analyses.costMicroUsd}), 0)`,
      cacheReads: sql<number>`coalesce(sum(${analyses.cacheReadTokens}), 0)`,
    })
    .from(analyses)
    .where(gte(analyses.createdAt, since))
    .groupBy(analyses.stage, analyses.model)
    .all()
    .map((row) => ({
      stage: row.stage,
      model: row.model,
      calls: row.calls,
      skipped: row.skipped,
      costUsd: row.micro / 1_000_000,
      cacheReads: row.cacheReads,
    }));
}

/** Events that passed the rule gate and have not been analysed under this prompt version. */
export function eventsAwaitingAnalysis(
  db: Db,
  promptVersion: string,
  limit = 200,
): { eventId: number; combined: number }[] {
  const latestScore = db
    .select({
      eventId: eventScores.eventId,
      maxId: sql<number>`max(${eventScores.id})`.as('max_score_id'),
    })
    .from(eventScores)
    .groupBy(eventScores.eventId)
    .as('latest_score');

  return db
    .select({ eventId: eventScores.eventId, combined: eventScores.combined })
    .from(eventScores)
    .innerJoin(latestScore, eq(latestScore.maxId, eventScores.id))
    .where(
      and(
        eq(eventScores.gatePassed, true),
        // Re-analysing under the same prompt version would spend money to produce the
        // row that already exists. A version bump makes every event eligible again,
        // which is exactly what "revert the prompt version and re-run" means.
        sql`not exists (
          select 1 from ${analyses}
          where ${analyses.eventId} = ${eventScores.eventId}
            and ${analyses.stage} = 'triage'
            and ${analyses.promptVersion} = ${promptVersion}
        )`,
      ),
    )
    .orderBy(desc(eventScores.combined))
    .limit(limit)
    .all();
}

/** Evidence for one event, shaped for the untrusted-content envelope. */
export function envelopeItemsFor(
  db: Db,
  eventId: number,
): {
  evidenceId: string;
  sourceId: string;
  title: string;
  body: string;
  url: string;
  publishedAt: string;
  isOfficial: boolean;
  sourceCategory: string;
}[] {
  return db
    .all<{
      evidenceId: number;
      sourceId: string;
      title: string;
      body: string;
      url: string;
      publishedAt: number | null;
      fetchedAt: number;
      isOfficial: number;
      sourceCategory: string;
    }>(
      sql`
      select ev.id as evidenceId, ev.source_id as sourceId,
             ri.title as title, coalesce(ri.body, '') as body,
             ri.url as url, ri.published_at as publishedAt, ri.fetched_at as fetchedAt,
             s.is_official as isOfficial, s.category as sourceCategory
      from evidence ev
      join raw_items ri on ri.id = ev.raw_item_id
      join sources s on s.id = ev.source_id
      where ev.event_id = ${eventId}
      order by coalesce(ri.published_at, ri.fetched_at) asc
    `,
    )
    .map((row) => ({
      // A stable, human-readable id. The model must cite these, and validation
      // rejects anything it was not shown — so the format has to be predictable.
      evidenceId: `ev-${String(row.evidenceId)}`,
      sourceId: row.sourceId,
      title: row.title,
      body: row.body,
      url: row.url,
      publishedAt: new Date(row.publishedAt ?? row.fetchedAt).toISOString(),
      isOfficial: row.isOfficial === 1,
      sourceCategory: row.sourceCategory,
    }));
}

export function eventForAnalysis(
  db: Db,
  eventId: number,
): { id: number; title: string; summary: string } | undefined {
  return db
    .select({ id: events.id, title: events.title, summary: events.summary })
    .from(events)
    .where(eq(events.id, eventId))
    .get();
}

export function countAnalyses(db: Db): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(analyses)
      .get()?.n ?? 0
  );
}

export function clearAnalyses(db: Db): void {
  db.delete(analyses).run();
}

/**
 * The latest successful analysis for an event, if there is one.
 *
 * The strategy layer previously hard-coded `stillUnknown: []` and `doNotSay: []`
 * because no analysis existed. Now that the live path produces them, two of the seven
 * DON'T POST reasons — `insufficient_information` and `reputational_risk` — can
 * actually fire, and the decision panel can show real traps rather than an empty list.
 */
export function latestAnalysisFor(
  db: Db,
  eventId: number,
):
  | {
      stillUnknown: string[];
      doNotSay: string[];
      confidence: string | null;
      injectionObserved: boolean;
    }
  | undefined {
  const row = db
    .select({
      payload: analyses.payload,
      confidence: analyses.confidence,
      injectionObserved: analyses.injectionObserved,
    })
    .from(analyses)
    .where(
      and(eq(analyses.eventId, eventId), eq(analyses.stage, 'analysis'), eq(analyses.status, 'ok')),
    )
    .orderBy(desc(analyses.id))
    .limit(1)
    .get();

  if (row === undefined) return undefined;

  const payload = row.payload as { stillUnknown?: string[]; doNotSay?: string[] } | null;
  return {
    stillUnknown: payload?.stillUnknown ?? [],
    doNotSay: payload?.doNotSay ?? [],
    confidence: row.confidence,
    injectionObserved: row.injectionObserved,
  };
}
