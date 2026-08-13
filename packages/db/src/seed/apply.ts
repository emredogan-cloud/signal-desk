import { eq, sql } from 'drizzle-orm';
import { normalizeAlias } from '@signal-desk/shared';
import type { Db } from '../client.js';
import { sources, entities, entityAliases } from '../schema.js';
import { SOURCE_SEEDS, resolveSourceSeed } from './sources.js';
import { ENTITY_SEEDS } from './entities.js';

/**
 * Applying the registry to a database.
 *
 * Seeding is **idempotent and non-destructive**: re-running it updates the
 * declarative fields (name, URL, priority, category…) and leaves everything the
 * running system has learned — etags, last-success timestamps, probe results, the
 * `active` flag — untouched.
 *
 * That distinction matters operationally. `active` is how an operator disables a
 * misbehaving source, and a seed that reset it would silently re-enable a feed
 * someone turned off for a reason.
 */

export type SeedReport = {
  readonly sourcesInserted: number;
  readonly sourcesUpdated: number;
  readonly entitiesUpserted: number;
  readonly aliasesUpserted: number;
};

export function seedSources(db: Db, now: Date = new Date()): { inserted: number; updated: number } {
  const existing = new Set(
    db
      .select({ id: sources.id })
      .from(sources)
      .all()
      .map((r) => r.id),
  );
  let inserted = 0;
  let updated = 0;

  for (const seed of SOURCE_SEEDS) {
    const row = resolveSourceSeed(seed);
    const isNew = !existing.has(row.id);

    db.insert(sources)
      .values({ ...row, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: sources.id,
        set: {
          name: row.name,
          url: row.url,
          platform: row.platform,
          category: row.category,
          entity: row.entity,
          priority: row.priority,
          isOfficial: row.isOfficial,
          reliability: row.reliability,
          pollIntervalSec: row.pollIntervalSec,
          expectedValue: row.expectedValue,
          updatedAt: now,
          // verifiedAt is NOT reset from the seed on update: a probe run may have
          // written a fresher date than the document carries, and going backwards
          // would make a verified source look unverified.
        },
      })
      .run();

    if (isNew) inserted += 1;
    else updated += 1;
  }

  return { inserted, updated };
}

export class CrossEntityAliasError extends Error {
  constructor(
    normalized: string,
    a: { entity: string; alias: string },
    b: { entity: string; alias: string },
  ) {
    super(
      `Alias collision: "${a.alias}" (${a.entity}) and "${b.alias}" (${b.entity}) both normalise ` +
        `to "${normalized}". An alias owned by two entities mis-attributes every event carrying ` +
        `it, silently. Pick one owner or make the alias more specific.`,
    );
    this.name = 'CrossEntityAliasError';
  }
}

/**
 * Flatten the entity seeds into alias rows, folding duplicates.
 *
 * Two spellings of the same name — "Hugging Face" and "HuggingFace", "Next.js" and
 * "NextJS" — normalise to one key by design; that folding is the whole point of the
 * registry. Within an entity they are simply the same alias listed twice, and the
 * first wins. **Across** entities the same collision is a genuine data error, and it
 * throws rather than resolving arbitrarily.
 */
export function buildAliasRows(seeds: readonly (typeof ENTITY_SEEDS)[number][] = ENTITY_SEEDS) {
  const byNormalized = new Map<
    string,
    { entityId: string; alias: string; normalized: string; requiresExactCase: boolean }
  >();

  for (const seed of seeds) {
    const declared = [
      ...seed.aliases.map((alias) => ({ alias, requiresExactCase: false })),
      ...(seed.caseSensitiveAliases ?? []).map((alias) => ({ alias, requiresExactCase: true })),
    ];

    for (const { alias, requiresExactCase } of declared) {
      const normalized = normalizeAlias(alias);
      const existing = byNormalized.get(normalized);

      if (existing !== undefined) {
        if (existing.entityId !== seed.id) {
          throw new CrossEntityAliasError(
            normalized,
            { entity: existing.entityId, alias: existing.alias },
            { entity: seed.id, alias },
          );
        }
        continue; // same entity, redundant spelling — keep the first
      }

      byNormalized.set(normalized, { entityId: seed.id, alias, normalized, requiresExactCase });
    }
  }

  return [...byNormalized.values()];
}

export function seedEntities(
  db: Db,
  now: Date = new Date(),
): { entities: number; aliases: number } {
  // Built up front so a cross-entity collision fails before any row is written,
  // rather than halfway through leaving the registry in a partial state.
  const aliasRows = buildAliasRows();
  let entityCount = 0;
  let aliasCount = 0;

  for (const seed of ENTITY_SEEDS) {
    db.insert(entities)
      .values({
        id: seed.id,
        name: seed.name,
        kind: seed.kind,
        operatorRelevance: seed.operatorRelevance,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: entities.id,
        set: {
          name: seed.name,
          kind: seed.kind,
          operatorRelevance: seed.operatorRelevance,
          updatedAt: now,
        },
      })
      .run();
    entityCount += 1;

    // Aliases are replaced wholesale rather than merged. An alias removed from the
    // seed because it was causing mis-attribution must actually disappear; merging
    // would leave it resolving forever.
    db.delete(entityAliases).where(eq(entityAliases.entityId, seed.id)).run();

    for (const row of aliasRows.filter((r) => r.entityId === seed.id)) {
      db.insert(entityAliases).values(row).run();
      aliasCount += 1;
    }
  }

  return { entities: entityCount, aliases: aliasCount };
}

export function seedAll(db: Db, now: Date = new Date()): SeedReport {
  const s = seedSources(db, now);
  const e = seedEntities(db, now);
  return {
    sourcesInserted: s.inserted,
    sourcesUpdated: s.updated,
    entitiesUpserted: e.entities,
    aliasesUpserted: e.aliases,
  };
}

/**
 * Load the registry in the shape `@signal-desk/core`'s `EntityRegistry` expects.
 *
 * The database→core boundary is a plain data handoff on purpose: core performs no
 * I/O, so it cannot know this table exists.
 */
export function loadEntityRegistryRows(db: Db) {
  return {
    entities: db
      .select({
        id: entities.id,
        name: entities.name,
        operatorRelevance: entities.operatorRelevance,
      })
      .from(entities)
      .all(),
    aliases: db
      .select({
        entityId: entityAliases.entityId,
        alias: entityAliases.alias,
        normalized: entityAliases.normalized,
        requiresExactCase: entityAliases.requiresExactCase,
      })
      .from(entityAliases)
      .all(),
  };
}

/** Count rows without loading them. Used by the CLIs for their summary lines. */
export function countRows(db: Db) {
  const one = (table: typeof sources | typeof entities | typeof entityAliases) =>
    db
      .select({ n: sql<number>`count(*)` })
      .from(table)
      .get()?.n ?? 0;

  return {
    sources: one(sources),
    entities: one(entities),
    aliases: one(entityAliases),
  };
}
