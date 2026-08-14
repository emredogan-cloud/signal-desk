import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { ConfidenceLevel } from '@signal-desk/shared';
import type { Db } from '../client.js';
import {
  analyses,
  evidence,
  events,
  eventScores,
  rawItems,
  sources,
  spendLedger,
} from '../schema.js';

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
export function spendSince(db: Db, since: Date, provider: SpendProvider = 'anthropic'): number {
  // Reads the LEDGER, not `analyses`. Reading `analyses` meant `--reset` zeroed the
  // figure the budget guard depends on.
  //
  // Filtered by provider since 2026-08-14. The two budgets are separate ceilings on
  // separate vendors; summing them would let an X owned read push deep analysis into
  // FRUGAL, and let a heavy analysis day silently consume the X allowance.
  const row = db
    .select({ total: sql<number>`coalesce(sum(${spendLedger.costMicroUsd}), 0)` })
    .from(spendLedger)
    .where(and(gte(spendLedger.spentAt, since), eq(spendLedger.provider, provider)))
    .get();
  return (row?.total ?? 0) / 1_000_000;
}

export type SpendProvider = 'anthropic' | 'x';

/**
 * Record one metered non-Anthropic request.
 *
 * Takes the cost in USD and rounds to micro-dollars here, so callers cannot each
 * invent their own rounding. `stage` is the request kind (`user_read`, `owned_read`),
 * `model` the endpoint — the columns already mean "what was bought" and "from what",
 * which is the same question for both vendors.
 */
export function recordVendorSpend(
  db: Db,
  row: {
    readonly provider: SpendProvider;
    readonly stage: string;
    readonly endpoint: string;
    readonly costUsd: number;
    readonly spentAt: Date;
  },
): void {
  db.insert(spendLedger)
    .values({
      provider: row.provider,
      stage: row.stage,
      model: row.endpoint,
      costMicroUsd: Math.round(row.costUsd * 1_000_000),
      spentAt: row.spentAt,
    })
    .run();
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

/**
 * The three evidence facts the ranked list needs, for many events, in ONE query.
 *
 * ### The defect this fixes — 2026-08-14
 *
 * The rebuilt list called `envelopeItemsFor` once per row to derive three booleans.
 * Locally that was invisible; on the deployed 2-vCPU machine the dashboard took
 * **32.2 seconds** to render — 200 joined queries pulling every evidence body, to
 * compute "is any source official".
 *
 * This is the second time in one afternoon that a per-row query became the bottleneck
 * (see `analysisContextFor`), and the shape of the mistake is the same both times: a
 * function written for the *detail* view, reused in the *list* view where the row count
 * is two orders of magnitude higher. The detail panel legitimately wants whole
 * evidence items; the list wants three aggregates, and asking for the former to compute
 * the latter is what costs thirty seconds.
 *
 * It also never reads `raw_items.body`, which is the large column — a list should not
 * be paging article text through SQLite to decide how to sort itself.
 */
export function evidenceFactsFor(
  db: Db,
  eventIds: readonly number[],
): Map<
  number,
  { hasOfficialSource: boolean; hasVersionArtifact: boolean; expertSourceCount: number }
> {
  const out = new Map<
    number,
    { hasOfficialSource: boolean; hasVersionArtifact: boolean; expertSourceCount: number }
  >();
  if (eventIds.length === 0) return out;

  const rows = db
    .select({
      eventId: evidence.eventId,
      official: sql<number>`max(${sources.isOfficial})`,
      // SQLite has no REGEXP without an extension, so the version test is two GLOBs:
      // "digit.digit" anywhere (v1.2, 16.3.1) or "b" followed by four digits (b10400).
      // Deliberately looser than the JS regex it replaces — this only feeds a strategy
      // input, and a false positive costs a slightly different angle, not a wrong fact.
      versioned: sql<number>`max(
        case when ${rawItems.title} glob '*[0-9].[0-9]*'
               or ${rawItems.title} glob '*b[0-9][0-9][0-9][0-9]*'
             then 1 else 0 end
      )`,
      experts: sql<number>`count(distinct case when ${sources.category} = 'EXPERT_ANALYST' then ${evidence.sourceId} end)`,
    })
    .from(evidence)
    .innerJoin(rawItems, eq(rawItems.id, evidence.rawItemId))
    .innerJoin(sources, eq(sources.id, evidence.sourceId))
    .where(inArray(evidence.eventId, [...eventIds]))
    .groupBy(evidence.eventId)
    .all();

  for (const row of rows) {
    out.set(row.eventId, {
      hasOfficialSource: row.official === 1,
      hasVersionArtifact: row.versioned === 1,
      expertSourceCount: row.experts,
    });
  }

  return out;
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
/**
 * The analysis context for many events at once.
 *
 * ### The defect this exists to fix — 2026-08-14
 *
 * The dashboard showed **two different recommendations for the same event**: the list
 * card said POST_SOON and the detail panel said DONT_POST, three centimetres apart.
 *
 * They were not disagreeing by design. `buildStrategy` is one function and both callers
 * used it — but the list called it with `stillUnknown: []` and `doNotSay: []`, because
 * reading each event's analysis meant a query per row and the list had forty rows. The
 * detail panel passed the real values, the forcing rule saw ten open questions, and it
 * escalated. **The list was not showing a different opinion; it was showing an opinion
 * formed with less information than the system already had**, which is worse, because
 * the list is what the operator scans.
 *
 * PROJECT-MEMORY records the same shape from Phase 11 — "one judgement, three
 * derivations" — where `strategyFromScore` had been reimplemented in three callers and
 * the third had drifted. That was a duplicated *function*. This was a duplicated
 * *input set*, which is harder to see and produces the same class of wrong.
 *
 * One query for the whole page, so the cheap path and the expensive path can be given
 * identical inputs and there is no incentive to cut the corner again.
 */
export function analysisContextFor(
  db: Db,
  eventIds: readonly number[],
): Map<number, { stillUnknown: string[]; doNotSay: string[]; injectionObserved: boolean }> {
  const out = new Map<
    number,
    { stillUnknown: string[]; doNotSay: string[]; injectionObserved: boolean }
  >();
  if (eventIds.length === 0) return out;

  const rows = db
    .select({
      eventId: analyses.eventId,
      id: analyses.id,
      payload: analyses.payload,
      injectionObserved: analyses.injectionObserved,
    })
    .from(analyses)
    .where(
      and(
        inArray(analyses.eventId, [...eventIds]),
        eq(analyses.stage, 'analysis'),
        eq(analyses.status, 'ok'),
      ),
    )
    .orderBy(analyses.id)
    .all();

  // Ascending id, so a later row for the same event overwrites an earlier one and the
  // map ends up holding the most recent analysis per event.
  for (const row of rows) {
    const payload = row.payload as { stillUnknown?: string[]; doNotSay?: string[] } | null;
    out.set(row.eventId, {
      stillUnknown: payload?.stillUnknown ?? [],
      doNotSay: payload?.doNotSay ?? [],
      injectionObserved: row.injectionObserved,
    });
  }

  return out;
}

export function latestAnalysisFor(
  db: Db,
  eventId: number,
):
  | {
      stillUnknown: string[];
      doNotSay: string[];
      confidence: string | null;
      injectionObserved: boolean;
      /**
       * The whole stored analysis, unnarrowed.
       *
       * Added 2026-08-14 for the rebuilt dashboard, which renders what/changed,
       * before/after, implications, claims, draft material, attention drivers and the
       * media idea — all of which were already being written to this column and none
       * of which anything read. Typed as `unknown` on purpose: this row was produced
       * by a model that had read untrusted content, and the reader is responsible for
       * validating the shape it uses rather than trusting a cast made here.
       */
      payload: unknown;
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
    payload: row.payload,
  };
}
