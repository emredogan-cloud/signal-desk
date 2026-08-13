import { normalizeAlias, candidateGrams } from '@signal-desk/shared';

/**
 * The entity registry, in memory.
 *
 * `packages/core` performs no I/O (ARCHITECTURE.md §3) — rows are loaded by the
 * caller and passed in. That is what makes this testable without a database and what
 * lets Phase 4 replay three months of history offline.
 */

export type RegistryAlias = {
  readonly entityId: string;
  readonly alias: string;
  readonly normalized: string;
  readonly requiresExactCase: boolean;
};

export type RegistryEntity = {
  readonly id: string;
  readonly name: string;
  readonly operatorRelevance: number;
};

export type EntityMatch = {
  readonly entityId: string;
  /** The surface form that matched, as it appeared in the text. */
  readonly matchedText: string;
  /** The registry alias it matched against. */
  readonly alias: string;
};

export class DuplicateAliasError extends Error {
  constructor(normalized: string, first: string, second: string) {
    super(
      `Alias "${normalized}" is claimed by both "${first}" and "${second}". ` +
        `An alias that resolves to two entities silently mis-attributes every event ` +
        `carrying it; pick one owner or make the alias more specific.`,
    );
    this.name = 'DuplicateAliasError';
  }
}

export class EntityRegistry {
  readonly #byNormalized = new Map<string, RegistryAlias>();
  readonly #entities = new Map<string, RegistryEntity>();

  constructor(entities: readonly RegistryEntity[], aliases: readonly RegistryAlias[]) {
    for (const entity of entities) {
      this.#entities.set(entity.id, entity);
    }

    for (const alias of aliases) {
      const existing = this.#byNormalized.get(alias.normalized);
      if (existing !== undefined && existing.entityId !== alias.entityId) {
        throw new DuplicateAliasError(alias.normalized, existing.entityId, alias.entityId);
      }
      this.#byNormalized.set(alias.normalized, alias);
    }
  }

  get size(): number {
    return this.#entities.size;
  }

  get aliasCount(): number {
    return this.#byNormalized.size;
  }

  entity(id: string): RegistryEntity | undefined {
    return this.#entities.get(id);
  }

  /** Resolve a single surface form. Returns the entity id, or undefined. */
  lookup(surfaceForm: string): string | undefined {
    const entry = this.#byNormalized.get(normalizeAlias(surfaceForm));
    if (entry === undefined) return undefined;
    if (entry.requiresExactCase && !surfaceForm.includes(entry.alias)) return undefined;
    return entry.entityId;
  }

  /**
   * Find every entity mentioned in a block of text.
   *
   * Longest match wins per starting position: "Google DeepMind" resolves to
   * `google-deepmind`, not to `google` followed by a stray token. Without that rule
   * every DeepMind announcement would also be attributed to Google, and the two
   * would stop being distinguishable in the event stream.
   */
  extract(text: string): EntityMatch[] {
    const matches: EntityMatch[] = [];
    const claimed = new Set<string>();

    // Longest grams first so a 3-word alias wins over the 1-word alias inside it.
    const grams = candidateGrams(text).sort((a, b) => b.raw.length - a.raw.length);

    for (const gram of grams) {
      const entry = this.#byNormalized.get(gram.key);
      if (entry === undefined) continue;
      if (entry.requiresExactCase && !gram.raw.includes(entry.alias)) continue;

      // One match per entity per text. An announcement that says "Claude" nine times
      // is one Anthropic mention, not nine.
      if (claimed.has(entry.entityId)) continue;
      claimed.add(entry.entityId);

      matches.push({ entityId: entry.entityId, matchedText: gram.raw, alias: entry.alias });
    }

    return matches;
  }

  /** Entity ids mentioned in the text, in registry-relevance order. */
  extractIds(text: string): string[] {
    return this.extract(text)
      .map((m) => m.entityId)
      .sort((a, b) => {
        const relevance =
          (this.#entities.get(b)?.operatorRelevance ?? 0) -
          (this.#entities.get(a)?.operatorRelevance ?? 0);
        return relevance !== 0 ? relevance : a.localeCompare(b);
      });
  }
}
