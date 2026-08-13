import { describe, it, expect } from 'vitest';
import {
  SOURCE_PLATFORMS,
  SOURCE_CATEGORIES,
  SOURCE_CATEGORY_RELIABILITY,
  DEFAULT_POLL_INTERVAL_SEC,
  ENTITY_KINDS,
  normalizeAlias,
} from '@signal-desk/shared';
import { SOURCE_SEEDS, resolveSourceSeed } from './sources.js';
import { ENTITY_SEEDS } from './entities.js';
import { buildAliasRows, CrossEntityAliasError } from './apply.js';

/**
 * ROADMAP.md Phase 2 TESTS:
 *   "Seed integrity (no duplicate ids, every URL parses, every priority in range,
 *    every category valid)."
 *
 * These are cheap and they protect against the specific way a registry rots: someone
 * adds a source in a hurry, and a typo makes it silently unreachable while the
 * dashboard keeps showing it as monitored.
 */

describe('source seed integrity', () => {
  it('meets the ≥30 source acceptance criterion', () => {
    expect(SOURCE_SEEDS.length).toBeGreaterThanOrEqual(30);
  });

  it('has no duplicate ids', () => {
    const ids = SOURCE_SEEDS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has no duplicate URLs', () => {
    // Two ids pointing at one URL means the same items are ingested twice and the
    // dedup stage has to clean up a mess the registry created.
    const urls = SOURCE_SEEDS.map((s) => s.url);
    const seen = new Map<string, string>();
    for (const seed of SOURCE_SEEDS) {
      const previous = seen.get(seed.url);
      expect(previous, `${seed.id} duplicates the URL of ${previous ?? ''}`).toBeUndefined();
      seen.set(seed.url, seed.id);
    }
    expect(seen.size).toBe(urls.length);
  });

  it.each(SOURCE_SEEDS.map((s) => [s.id, s] as const))('%s is well formed', (_id, seed) => {
    expect(seed.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(seed.name.trim()).not.toBe('');

    const url = new URL(seed.url);
    expect(['http:', 'https:']).toContain(url.protocol);

    expect(SOURCE_PLATFORMS).toContain(seed.platform);
    expect(SOURCE_CATEGORIES).toContain(seed.category);
    expect([1, 2, 3, 4]).toContain(seed.priority);
    expect(seed.expectedValue.trim(), 'every source must say what it is for').not.toBe('');
  });

  it('uses https everywhere', () => {
    // A feed fetched over http is a feed an intermediary can rewrite, and ingested
    // content goes to an LLM (THREAT-MODEL.md §T-1).
    for (const seed of SOURCE_SEEDS) {
      expect(new URL(seed.url).protocol, `${seed.id} must use https`).toBe('https:');
    }
  });

  it('marks every OFFICIAL_SOURCE as official and no COMMUNITY_SIGNAL as official', () => {
    for (const seed of SOURCE_SEEDS) {
      if (seed.category === 'OFFICIAL_SOURCE') {
        expect(seed.isOfficial, `${seed.id}`).toBe(true);
      }
      if (seed.category === 'COMMUNITY_SIGNAL' || seed.category === 'JOURNALIST') {
        expect(seed.isOfficial, `${seed.id} must not claim to be an official source`).toBe(false);
      }
    }
  });

  it('references only entities that exist in the entity registry', () => {
    const known = new Set(ENTITY_SEEDS.map((e) => e.id));
    for (const seed of SOURCE_SEEDS) {
      if (seed.entity === null) continue;
      expect(known, `${seed.id} references unknown entity "${seed.entity}"`).toContain(seed.entity);
    }
  });

  it('resolves reliability and poll interval from category and priority', () => {
    for (const seed of SOURCE_SEEDS) {
      const resolved = resolveSourceSeed(seed);
      expect(resolved.reliability).toBe(
        seed.reliability ?? SOURCE_CATEGORY_RELIABILITY[seed.category],
      );
      expect(resolved.pollIntervalSec).toBe(
        seed.pollIntervalSec ?? DEFAULT_POLL_INTERVAL_SEC[seed.priority],
      );
      expect(resolved.reliability).toBeGreaterThan(0);
      expect(resolved.reliability).toBeLessThanOrEqual(1);
    }
  });

  it('honours the 15-minute floor on every html_diff source', () => {
    // SOURCE-INTELLIGENCE.md §1a and THREAT-MODEL.md §T-8. Diffing a page is the one
    // mechanism here with no conditional-request story, so the interval is the only
    // politeness control there is.
    for (const seed of SOURCE_SEEDS.filter((s) => s.platform === 'html_diff')) {
      expect(resolveSourceSeed(seed).pollIntervalSec, `${seed.id}`).toBeGreaterThanOrEqual(15 * 60);
    }
  });

  it('covers every source type the adapters will implement', () => {
    const platforms = new Set(SOURCE_SEEDS.map((s) => s.platform));
    for (const required of ['rss', 'atom', 'github_atom', 'statuspage', 'html_diff'] as const) {
      expect(platforms, `no seeded source exercises the ${required} adapter`).toContain(required);
    }
  });

  it('includes the status feeds Phase 2 requires adding', () => {
    // ROADMAP.md Phase 2 acceptance: "Cloudflare / Vercel / AWS / Supabase status
    // feeds probed and added."
    const ids = new Set(SOURCE_SEEDS.map((s) => s.id));
    for (const id of ['status-cloudflare', 'status-vercel', 'status-aws', 'status-supabase']) {
      expect(ids).toContain(id);
    }
  });

  it('covers Anthropic despite it publishing no feed', () => {
    // SOURCE-INTELLIGENCE.md §1a records this as "a real gap, since Anthropic is the
    // operator's highest-relevance vendor". If this test fails, the gap has reopened.
    const anthropic = SOURCE_SEEDS.filter((s) => s.entity === 'anthropic');
    expect(anthropic.length).toBeGreaterThanOrEqual(3);
    expect(anthropic.some((s) => s.platform === 'html_diff' && s.priority === 1)).toBe(true);
    expect(anthropic.some((s) => s.platform === 'github_atom')).toBe(true);
    expect(anthropic.some((s) => s.platform === 'statuspage')).toBe(true);
  });

  it('has at least one Priority-1 source', () => {
    expect(SOURCE_SEEDS.filter((s) => s.priority === 1).length).toBeGreaterThan(0);
  });
});

describe('entity seed integrity', () => {
  it('covers at least the top 15 entities', () => {
    // ROADMAP.md Phase 2 acceptance: "Entity registry resolves the alias set for the
    // top 15 entities."
    expect(ENTITY_SEEDS.length).toBeGreaterThanOrEqual(15);
  });

  it('has no duplicate ids', () => {
    const ids = ENTITY_SEEDS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(ENTITY_SEEDS.map((e) => [e.id, e] as const))('%s is well formed', (_id, seed) => {
    expect(seed.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(seed.name.trim()).not.toBe('');
    expect(ENTITY_KINDS).toContain(seed.kind);
    expect(seed.operatorRelevance).toBeGreaterThanOrEqual(0);
    expect(seed.operatorRelevance).toBeLessThanOrEqual(1);
    expect(seed.aliases.length).toBeGreaterThan(0);
    for (const alias of seed.aliases) {
      expect(normalizeAlias(alias), `"${alias}" normalises to nothing`).not.toBe('');
    }
  });

  it('has no alias owned by two entities', () => {
    // The property the unique index enforces at the database level, asserted here so
    // the failure arrives as a readable message in a test rather than as a
    // SqliteError during a deploy.
    expect(() => buildAliasRows()).not.toThrow();
  });

  it('throws a readable error when two entities claim one alias', () => {
    expect(() =>
      buildAliasRows([
        { id: 'a', name: 'A', kind: 'org', operatorRelevance: 0.5, aliases: ['Gemini'] },
        { id: 'b', name: 'B', kind: 'org', operatorRelevance: 0.5, aliases: ['gemini'] },
      ]),
    ).toThrow(CrossEntityAliasError);
  });

  it('folds redundant spellings of one name within an entity', () => {
    // "Next.js" and "NextJS" normalise to the same key by design. Within one entity
    // that is not a collision, it is the normaliser doing its job.
    const rows = buildAliasRows([
      {
        id: 'vercel',
        name: 'Vercel',
        kind: 'org',
        operatorRelevance: 1,
        aliases: ['Next.js', 'NextJS'],
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.normalized).toBe('nextjs');
  });

  it('marks short ambiguous aliases as case-sensitive', () => {
    // "HF", "GPT", "AWS", "MCP", "GCP" appear inside ordinary words once folded.
    // Matching them case-insensitively turns typos into entity mentions.
    for (const seed of ENTITY_SEEDS) {
      for (const alias of seed.aliases) {
        expect(
          normalizeAlias(alias).length,
          `"${alias}" (${seed.id}) is short enough to need caseSensitiveAliases`,
        ).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it('does not claim a bare "X" as an alias', () => {
    // SOURCE-INTELLIGENCE.md's own reasoning: "X" appears in ordinary prose
    // constantly, and an entity resolver that fires on it attaches half the corpus
    // to xAI.
    const rows = buildAliasRows();
    expect(rows.map((r) => r.normalized)).not.toContain('x');
  });

  it('gives the operator’s own stack the highest relevance', () => {
    // ROADMAP.md §7: brand relevance is "whether he can *test* it". The ordering is
    // the only claim these guesses make, so it is the only thing worth asserting.
    const relevance = new Map(ENTITY_SEEDS.map((e) => [e.id, e.operatorRelevance]));
    const ownStack = ['anthropic', 'supabase', 'flutter', 'vercel'];
    const peripheral = ['apple', 'amazon', 'microsoft'];

    for (const own of ownStack) {
      for (const other of peripheral) {
        expect(
          relevance.get(own) ?? 0,
          `${own} should outrank ${other} for an operator who ships on it`,
        ).toBeGreaterThan(relevance.get(other) ?? 1);
      }
    }
  });
});
