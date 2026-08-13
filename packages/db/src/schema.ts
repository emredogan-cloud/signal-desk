import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { SOURCE_CATEGORIES, SOURCE_PLATFORMS } from '@signal-desk/shared';

/**
 * Database schema. ARCHITECTURE.md §7 lists the full set of tables; they land in the
 * phase that first needs them rather than all at once, so that every column in this
 * file has code that reads it.
 *
 * Phase 1 creates `sources` only — enough to prove the migration path works end to
 * end. Phase 2 extends it to the full registry shape in SOURCE-INTELLIGENCE.md §6.
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

    /** 1..4; 1 means a human looks at this today. */
    priority: integer('priority').notNull(),

    /** Disabling a misbehaving source is a data change, never a code change. */
    active: integer('active', { mode: 'boolean' }).notNull().default(true),

    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (table) => [
    index('sources_active_priority_idx').on(table.active, table.priority),
    index('sources_platform_idx').on(table.platform),
  ],
);

export type SourceRow = typeof sources.$inferSelect;
export type NewSourceRow = typeof sources.$inferInsert;
