import {
  sqliteTable,
  text,
  integer,
  real,
  blob,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import {
  SOURCE_CATEGORIES,
  SOURCE_PLATFORMS,
  ENTITY_KINDS,
  EVENT_CATEGORIES,
  CONFIDENCE_LEVELS,
  EVIDENCE_TAGS,
} from '@signal-desk/shared';

/**
 * Database schema. ARCHITECTURE.md §7 lists the full set of tables; they land in the
 * phase that first needs them rather than all at once, so that every column in this
 * file has code that reads it.
 *
 * Phase 1 — `sources`, minimal.
 * Phase 2 — `sources` extended to the full registry shape (SOURCE-INTELLIGENCE.md §6),
 *           plus `entities` and `entity_aliases`.
 */

/** Seconds since the Unix epoch. SQLite has no date type; storing integers keeps
 *  comparisons and indexes honest and avoids a string-format decision per column. */
const timestamp = (name: string) => integer(name, { mode: 'timestamp' });

export const sources = sqliteTable(
  'sources',
  {
    /** Stable slug, e.g. "openai-news". Chosen by hand, never generated — it appears
     *  in logs, in the probe table, and in evidence rows, and must stay readable. */
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    url: text('url').notNull(),

    /** How it is fetched, not who publishes it. */
    platform: text('platform', { enum: SOURCE_PLATFORMS }).notNull(),

    /** Who publishes it. Drives primary-source selection and confidence capping. */
    category: text('category', { enum: SOURCE_CATEGORIES }).notNull(),

    /** Canonical entity slug this source speaks for. Null for multi-entity sources
     *  like Hacker News, which speak for nobody in particular. */
    entity: text('entity'),

    /** 1..4; 1 means a human looks at this today. */
    priority: integer('priority').notNull(),

    /** Whether this source *is* the record, as opposed to reporting on it. Feeds
     *  primary-source selection (ARCHITECTURE.md §5) and the two-source rule
     *  (THREAT-MODEL.md §T-1 mitigation 7). Derivable from `category` today, kept
     *  separate because the two can diverge: a vendor's engineering blog is
     *  official, an official-sounding aggregator is not. */
    isOfficial: integer('is_official', { mode: 'boolean' }).notNull().default(false),

    /** 0.0–1.0. Seeded by category (see SOURCE_CATEGORY_RELIABILITY) and replaced in
     *  Phase 12 by measured precision. Every current value is an unvalidated guess.
     *
     *  The 0.5 default means "unknown", and exists because SQLite cannot add a
     *  NOT NULL column without one. The seed always supplies a real value; a row
     *  sitting at exactly 0.5 was inserted by hand and has never been assessed. */
    reliability: real('reliability').notNull().default(0.5),

    /** Per-source override of the priority default. Defaults to the Priority-3
     *  interval — the conservative middle. Polling too slowly costs latency;
     *  polling too fast costs goodwill and eventually access. */
    pollIntervalSec: integer('poll_interval_sec').notNull().default(3600),

    // ─── Conditional-request cache keys ────────────────────────────────
    // A 304 is free bandwidth and free CPU, and it is the difference between
    // polite polling and getting blocked (SOURCE-INTELLIGENCE.md §6).
    etag: text('etag'),
    lastModified: text('last_modified'),

    /** Disabling a misbehaving source is a data change, never a code change. */
    active: integer('active', { mode: 'boolean' }).notNull().default(true),

    // ─── Freshness tracking — the T-9 control ──────────────────────────
    // Three timestamps, not one, because they answer three different questions and
    // collapsing them is how silent source death stays invisible:
    //   checked  — did we try?           (a dead scheduler looks like a dead feed)
    //   success  — did the fetch work?   (a 500 loop looks like a quiet feed)
    //   event    — did it yield an item? (a feed that parses to zero items has died
    //                                     in the way that matters, while looking fine)
    lastCheckedAt: timestamp('last_checked_at'),
    lastSuccessAt: timestamp('last_success_at'),
    lastEventAt: timestamp('last_event_at'),

    /** Date this URL last returned a valid feed. Written by `pnpm sources:probe`. */
    verifiedAt: timestamp('verified_at'),

    /** Free text: what this source is for. Read by a human, not by code. */
    expectedValue: text('expected_value'),

    // ─── Circuit breaker — THREAT-MODEL.md §T-10 ───────────────────────
    // Per-source rather than global: one feed returning 500s must not stop the
    // other 59, and hammering a struggling host is how a polite client becomes a
    // blocked one (§T-8).
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    /** While set and in the future, the scheduler skips this source entirely. */
    circuitOpenUntil: timestamp('circuit_open_until'),
    /** Why the breaker opened. Shown on the health panel; cleared on success. */
    lastErrorMessage: text('last_error_message'),

    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (table) => [
    index('sources_active_priority_idx').on(table.active, table.priority),
    index('sources_platform_idx').on(table.platform),
    index('sources_entity_idx').on(table.entity),
    // "Which sources have gone quiet?" is the single most valuable operational
    // query in the system (ARCHITECTURE.md §9).
    index('sources_last_success_idx').on(table.lastSuccessAt),
  ],
);

/**
 * Canonical entities. SOURCE-INTELLIGENCE.md §6 / ROADMAP.md Phase 2:
 * "so 'Claude', 'Anthropic', and 'claude-opus-5' resolve to one entity."
 *
 * Entities are organisations and projects. Models and products are *aliases* of the
 * organisation rather than entities in their own right — the question the system
 * needs to answer is "is this the same event", and "Anthropic shipped Opus 5" and
 * "claude-opus-5 is out" are the same event.
 */
export const entities = sqliteTable(
  'entities',
  {
    /** Stable slug: "anthropic", "google-deepmind". */
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    kind: text('kind', { enum: ENTITY_KINDS }).notNull(),

    /** Relevance to this operator's expertise, 0.0–1.0. Feeds brand-relevance
     *  scoring in Phase 5. An unvalidated starting guess, refitted in Phase 12. */
    operatorRelevance: real('operator_relevance').notNull().default(0.5),

    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (table) => [index('entities_kind_idx').on(table.kind)],
);

/**
 * Aliases, one row per surface form.
 *
 * A separate table rather than a JSON column on `entities` because the lookup runs
 * once per extracted token during normalisation, and because a unique index on the
 * normalised form is what makes "this alias belongs to two entities" a database
 * error instead of a silent mis-resolution six weeks later.
 */
export const entityAliases = sqliteTable(
  'entity_aliases',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),

    /** The alias as a human writes it: "Claude Code", "claude-opus-5". */
    alias: text('alias').notNull(),

    /** Lowercased and punctuation-folded. The column actually matched against. */
    normalized: text('normalized').notNull(),

    /** Aliases short enough to collide with ordinary prose ("HF", "GPT") only match
     *  on a whole-token boundary with correct case. Without this, "hf" matches
     *  inside "shfted" and every typo becomes a Hugging Face event. */
    requiresExactCase: integer('requires_exact_case', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    uniqueIndex('entity_aliases_normalized_uq').on(table.normalized),
    index('entity_aliases_entity_idx').on(table.entityId),
  ],
);

/**
 * Everything fetched, exactly as fetched. ARCHITECTURE.md §7.
 *
 * **This table is append-only.** Nothing in the codebase updates or deletes a row,
 * and that is the property the rest of the system is built on:
 *
 *   - Phase 4's clustering is a *derived* view. Change the algorithm, re-run it over
 *     these rows, compare. No re-fetching, no lost history.
 *   - Phase 12's weight refitting replays three months of real history offline at
 *     **zero API cost**, which is only possible because the inputs were kept.
 *   - "Why didn't we detect this?" is answerable by looking at what actually arrived
 *     rather than at what the pipeline concluded.
 *
 * `rawPayload` keeps the original serialised item rather than only the parsed
 * fields, because a parser bug found in six months can then be fixed retroactively.
 */
export const rawItems = sqliteTable(
  'raw_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'restrict' }),

    /** The publisher's own id — RSS `<guid>`, Atom `<id>`. Falls back to the URL. */
    externalId: text('external_id').notNull(),

    url: text('url').notNull(),
    title: text('title').notNull(),
    /** Untrusted. Stored verbatim; sanitisation happens downstream in Phase 4. */
    body: text('body').notNull(),
    author: text('author'),

    /** The publisher's timestamp. Null when the feed omits one — which is common,
     *  and must not be silently replaced with `fetchedAt` or every such item looks
     *  brand new forever. */
    publishedAt: timestamp('published_at'),
    fetchedAt: timestamp('fetched_at').notNull(),

    /** SHA-256 over the normalised title+body+url. Deduplication stage 1
     *  (ARCHITECTURE.md §5) and the html_diff change detector. */
    contentHash: text('content_hash').notNull(),

    /** The original serialised item, for replay after a parser fix. */
    rawPayload: text('raw_payload').notNull(),

    /** Follows one item from fetch to analysis (ARCHITECTURE.md §9). */
    traceId: text('trace_id').notNull(),
    httpStatus: integer('http_status'),
  },
  (table) => [
    // The publisher's id is the primary dedup key. A feed that re-serves the same
    // item on every poll — which most do — must insert once.
    uniqueIndex('raw_items_source_external_uq').on(table.sourceId, table.externalId),
    index('raw_items_content_hash_idx').on(table.contentHash),
    index('raw_items_fetched_at_idx').on(table.fetchedAt),
    index('raw_items_published_at_idx').on(table.publishedAt),
    index('raw_items_source_idx').on(table.sourceId),
  ],
);

/**
 * Per-source, per-run fetch telemetry. THREAT-MODEL.md §T-9 and ARCHITECTURE.md §9.
 *
 * Separate from the counters on `sources` because those answer "what is the state
 * now" and this answers "what has been happening" — the second is what turns
 * "the feed looks quiet" into "the feed started 304ing on Tuesday and stopped
 * producing items on Thursday".
 */
export const fetchLog = sqliteTable(
  'fetch_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at').notNull(),
    durationMs: integer('duration_ms').notNull(),
    outcome: text('outcome').notNull(),
    httpStatus: integer('http_status'),
    /** Items parsed out of the response. */
    itemsFound: integer('items_found').notNull().default(0),
    /** Items that were new. `found > 0, new = 0` is the normal steady state. */
    itemsNew: integer('items_new').notNull().default(0),
    bytes: integer('bytes').notNull().default(0),
    /** True when the server answered 304 — free bandwidth, no parsing. */
    notModified: integer('not_modified', { mode: 'boolean' }).notNull().default(false),
    error: text('error'),
    traceId: text('trace_id').notNull(),
  },
  (table) => [
    index('fetch_log_source_started_idx').on(table.sourceId, table.startedAt),
    index('fetch_log_started_idx').on(table.startedAt),
  ],
);

export type SourceRow = typeof sources.$inferSelect;
export type NewSourceRow = typeof sources.$inferInsert;
export type EntityRow = typeof entities.$inferSelect;
export type NewEntityRow = typeof entities.$inferInsert;
export type EntityAliasRow = typeof entityAliases.$inferSelect;
export type NewEntityAliasRow = typeof entityAliases.$inferInsert;

export type RawItemRow = typeof rawItems.$inferSelect;
export type NewRawItemRow = typeof rawItems.$inferInsert;
export type FetchLogRow = typeof fetchLog.$inferSelect;
export type NewFetchLogRow = typeof fetchLog.$inferInsert;

// ─────────────────────────────────────────────────────────────────────
// Phase 4 — canonical events. ARCHITECTURE.md §5.
//
// `events` is a DERIVED table. Everything in it can be recomputed from
// `raw_items`, which is why clustering can be changed and re-run over real
// history rather than only over whatever arrives next.
// ─────────────────────────────────────────────────────────────────────

export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    category: text('category', { enum: EVENT_CATEGORIES }).notNull(),

    /** Canonical entity slugs, JSON array. Denormalised deliberately: it is read on
     *  every clustering pass and never queried relationally. */
    entities: text('entities', { mode: 'json' }).$type<string[]>().notNull(),
    /** `{ models, versions, repos }`. The stage-2 dedup key. */
    artifacts: text('artifacts', { mode: 'json' })
      .$type<{
        models: string[];
        versions: string[];
        repos: string[];
        titleModels: string[];
        titleVersions: string[];
      }>()
      .notNull(),

    /** When we first saw it. The latency KPI's denominator. */
    firstSeenAt: timestamp('first_seen_at').notNull(),
    /** When it happened, per the publisher. The KPI's numerator. */
    eventOccurredAt: timestamp('event_occurred_at').notNull(),
    /** True when no publisher timestamp existed and `fetchedAt` stood in. A latency
     *  measurement over these rows measures nothing, and must exclude them. */
    occurredAtIsEstimated: integer('occurred_at_is_estimated', { mode: 'boolean' })
      .notNull()
      .default(false),
    updatedAt: timestamp('updated_at').notNull(),

    /** The most authoritative evidence, by source category — not by arrival order. */
    primarySourceId: text('primary_source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'restrict' }),
    primaryRawItemId: integer('primary_raw_item_id')
      .notNull()
      .references(() => rawItems.id, { onDelete: 'restrict' }),

    status: text('status', {
      enum: ['new', 'triaged', 'analyzed', 'actioned', 'ignored', 'expired'],
    })
      .notNull()
      .default('new'),

    /** Count of attached evidence rows. Denormalised for the stream view. */
    evidenceCount: integer('evidence_count').notNull().default(0),
    /** How many distinct sources corroborate. Feeds confidence in Phase 5. */
    distinctSourceCount: integer('distinct_source_count').notNull().default(1),
    /** True when at least one OFFICIAL_SOURCE backs it. Confidence is capped
     *  otherwise (THREAT-MODEL.md §T-2 mitigation 4). */
    hasOfficialSource: integer('has_official_source', { mode: 'boolean' }).notNull().default(false),

    /** §T-1 mitigation 6: flagged, stored, surfaced — never silently dropped. */
    injectionFlagged: integer('injection_flagged', { mode: 'boolean' }).notNull().default(false),

    /** Set when this event was merged into another. Non-null means "not canonical". */
    mergedIntoEventId: integer('merged_into_event_id'),
  },
  (table) => [
    index('events_occurred_idx').on(table.eventOccurredAt),
    index('events_first_seen_idx').on(table.firstSeenAt),
    index('events_category_idx').on(table.category),
    index('events_status_idx').on(table.status),
    index('events_merged_idx').on(table.mergedIntoEventId),
  ],
);

/** `raw_item` → `event`, with the role that item plays. ARCHITECTURE.md §7. */
export const evidence = sqliteTable(
  'evidence',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    rawItemId: integer('raw_item_id')
      .notNull()
      .references(() => rawItems.id, { onDelete: 'cascade' }),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'restrict' }),

    role: text('role', { enum: ['primary', 'corroborating', 'reaction'] }).notNull(),
    /** Which dedup stage attached it, and how confidently. Rendered in the UI so a
     *  merge the operator disagrees with can be understood before it is undone. */
    mergeStage: integer('merge_stage'),
    similarity: real('similarity'),

    canonicalUrl: text('canonical_url').notNull(),
    contentHash: text('content_hash').notNull(),
    attachedAt: timestamp('attached_at').notNull(),
  },
  (table) => [
    uniqueIndex('evidence_raw_item_uq').on(table.rawItemId),
    index('evidence_event_idx').on(table.eventId),
    index('evidence_source_idx').on(table.sourceId),
  ],
);

/** Embeddings, one per event. Raw float32 bytes: the format `sqlite-vec` reads, and
 *  half the size of a JSON array. */
export const eventEmbeddings = sqliteTable('event_embeddings', {
  eventId: integer('event_id')
    .primaryKey()
    .references(() => events.id, { onDelete: 'cascade' }),
  model: text('model').notNull(),
  dimensions: integer('dimensions').notNull(),
  embedding: blob('embedding', { mode: 'buffer' }).$type<Buffer>().notNull(),
  /** The exact text embedded, so a re-embed after a model change is reproducible. */
  sourceText: text('source_text').notNull(),
  createdAt: timestamp('created_at').notNull(),
});

/**
 * Every merge and unmerge. ARCHITECTURE.md §5: "Merges are **reversible.** Every
 * merge writes an audit row; the dashboard has an 'unmerge' action."
 *
 * The row carries enough to reverse the operation exactly — which event the item came
 * from, which it went to, and why. Without the `from` side, an unmerge can only guess
 * where to put things back.
 */
export const mergeAudit = sqliteTable(
  'merge_audit',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    action: text('action', { enum: ['merge', 'unmerge', 'split'] }).notNull(),
    rawItemId: integer('raw_item_id').notNull(),
    fromEventId: integer('from_event_id'),
    toEventId: integer('to_event_id'),
    stage: integer('stage'),
    similarity: real('similarity'),
    reason: text('reason').notNull(),
    /** 'pipeline' or 'operator'. An operator unmerge must never be undone by the
     *  pipeline re-merging the same item on the next pass. */
    actor: text('actor', { enum: ['pipeline', 'operator'] }).notNull(),
    createdAt: timestamp('created_at').notNull(),
  },
  (table) => [
    index('merge_audit_raw_item_idx').on(table.rawItemId),
    index('merge_audit_event_idx').on(table.toEventId),
  ],
);

export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;
export type EvidenceRow = typeof evidence.$inferSelect;
export type NewEvidenceRow = typeof evidence.$inferInsert;
export type EventEmbeddingRow = typeof eventEmbeddings.$inferSelect;
export type MergeAuditRow = typeof mergeAudit.$inferSelect;

/**
 * Score history. ARCHITECTURE.md §7: "Score history — scores change as evidence
 * accumulates; keep the series."
 *
 * Append-only, like `raw_items`. An event scored 41 on Monday and 78 on Wednesday
 * because four more sources arrived is a *fact about detection latency*, and
 * overwriting the 41 destroys it. Phase 12 needs the series to answer "would the new
 * weights have surfaced this sooner", which is the entire point of the refit.
 */
export const eventScores = sqliteTable(
  'event_scores',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),

    importance: integer('importance').notNull(),
    brandRelevance: integer('brand_relevance').notNull(),
    velocity: integer('velocity').notNull(),
    combined: integer('combined').notNull(),
    confidence: text('confidence', { enum: CONFIDENCE_LEVELS }).notNull(),
    evidenceTag: text('evidence_tag', { enum: EVIDENCE_TAGS }).notNull(),

    /** The full component breakdown, as rendered. An operator who cannot see why
     *  something scored 82 will not trust the number (ROADMAP.md Phase 5). */
    breakdown: text('breakdown', { mode: 'json' }).$type<unknown>().notNull(),
    /** Caps that fired. Non-empty means a rule overrode the arithmetic. */
    caps: text('caps', { mode: 'json' }).$type<string[]>().notNull(),

    /** Gate outcome, stored so the kill rate is measurable after the fact. */
    gatePassed: integer('gate_passed', { mode: 'boolean' }).notNull(),
    gateKilledBy: text('gate_killed_by'),
    gateReason: text('gate_reason').notNull(),

    /** Which version of the scorer produced this. Bumped when weights change, so a
     *  Phase-12 refit can compare like with like instead of silently mixing eras. */
    scoredWith: text('scored_with').notNull(),
    scoredAt: timestamp('scored_at').notNull(),
  },
  (table) => [
    index('event_scores_event_idx').on(table.eventId, table.scoredAt),
    index('event_scores_combined_idx').on(table.combined),
    index('event_scores_gate_idx').on(table.gatePassed),
  ],
);

export type EventScoreRow = typeof eventScores.$inferSelect;
export type NewEventScoreRow = typeof eventScores.$inferInsert;

/**
 * Stored analyses. Append-only and **versioned**.
 *
 * `ROADMAP.md` Phase 6: "Prompt versioning — every stored analysis records model id +
 * prompt version", and rollback is "revert the prompt version and re-run". Both need
 * the old rows to survive, so a re-analysis inserts rather than updates.
 */
export const analyses = sqliteTable(
  'analyses',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),

    /** 'triage' or 'analysis'. Both are stored — a triage verdict is itself a finding. */
    stage: text('stage').notNull(),
    /** ok | skipped | refused | failed. A skip is data: it says why nothing was spent. */
    status: text('status').notNull(),
    reason: text('reason').notNull(),
    /**
     * Machine-readable skip code. Null unless status is 'skipped'.
     *
     * Reporting grouped on `reason` substrings first, and mis-bucketed most skips as
     * "other" — a summary derived from prose breaks the next time the prose changes.
     */
    skipCode: text('skip_code'),

    /** The validated payload. Null when the stage produced nothing. */
    payload: text('payload', { mode: 'json' }).$type<unknown>(),

    confidence: text('confidence', { enum: CONFIDENCE_LEVELS }),
    recommendedAction: text('recommended_action'),
    injectionObserved: integer('injection_observed', { mode: 'boolean' }).notNull().default(false),

    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),

    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    /** Micro-dollars. Integer, because floating-point money accumulates error. */
    costMicroUsd: integer('cost_micro_usd').notNull().default(0),

    createdAt: timestamp('created_at').notNull(),
  },
  (table) => [
    index('analyses_event_idx').on(table.eventId, table.createdAt),
    index('analyses_stage_idx').on(table.stage, table.createdAt),
    index('analyses_cost_idx').on(table.createdAt),
  ],
);

export type AnalysisRow = typeof analyses.$inferSelect;
export type NewAnalysisRow = typeof analyses.$inferInsert;

/**
 * Trends and their observation series. `ROADMAP.md` Phase 9.
 *
 * Two tables, because the series is the data. A trend row holds what a human asserted
 * once; observation rows hold the trajectory. "Growing" and "declining" are statements
 * about a sequence, so the sequence has to be stored.
 */
export const trends = sqliteTable(
  'trends',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull().unique(),
    platform: text('platform').notNull(),

    /** Human-supplied. NULL when the operator has not filled it in — never guessed. */
    mechanism: text('mechanism'),
    howToParticipate: text('how_to_participate'),
    originalVersion: text('original_version'),

    /** Latest computed placement. Recomputed from the series, never hand-edited. */
    stage: text('stage').notNull().default('UNKNOWN'),
    saturation: real('saturation').notNull().default(0),
    stageExplanation: text('stage_explanation').notNull().default(''),

    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (table) => [index('trends_stage_idx').on(table.stage)],
);

export const trendObservations = sqliteTable(
  'trend_observations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    trendId: integer('trend_id')
      .notNull()
      .references(() => trends.id, { onDelete: 'cascade' }),
    observedAt: timestamp('observed_at').notNull(),
    mentionCount: integer('mention_count').notNull(),
    distinctSources: integer('distinct_sources').notNull(),
    /** True when the operator entered it. Manual entry is first-class, not a fallback. */
    manual: integer('manual', { mode: 'boolean' }).notNull().default(true),
    note: text('note').notNull().default(''),
  },
  (table) => [index('trend_obs_idx').on(table.trendId, table.observedAt)],
);

export type TrendRow = typeof trends.$inferSelect;
export type TrendObservationRow = typeof trendObservations.$inferSelect;
