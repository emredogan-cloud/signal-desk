import { sqliteTable, text, integer, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { SOURCE_CATEGORIES, SOURCE_PLATFORMS, ENTITY_KINDS } from '@signal-desk/shared';

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

export type SourceRow = typeof sources.$inferSelect;
export type NewSourceRow = typeof sources.$inferInsert;
export type EntityRow = typeof entities.$inferSelect;
export type NewEntityRow = typeof entities.$inferInsert;
export type EntityAliasRow = typeof entityAliases.$inferSelect;
export type NewEntityAliasRow = typeof entityAliases.$inferInsert;
