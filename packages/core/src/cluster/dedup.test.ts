import { describe, it, expect } from 'vitest';
import { EntityRegistry } from '../entities/registry.js';
import { normalizeItem } from '../normalize/normalize.js';
import {
  decideCluster,
  cosineSimilarity,
  artifactsConflict,
  shouldReplacePrimary,
  sourceAuthority,
  evidenceRole,
  DEDUP_SIMILARITY_THRESHOLD,
  type ClusterCandidate,
} from './dedup.js';
import {
  DeterministicEmbedder,
  normalize,
  embeddingToBuffer,
  bufferToEmbedding,
} from './embedder.js';
import { measureClustering } from './measure.js';
import { LABELLED_CLUSTERS } from './labelled-fixtures.js';

/**
 * ROADMAP.md Phase 4 acceptance criteria, as tests.
 *
 * The measurement tests use the **deterministic** embedder so CI never downloads a
 * model. They therefore prove the *plumbing* — that the stages fire in order, that
 * artifacts block a merge, that the pipeline is deterministic. The **quality**
 * numbers (precision 1.0000, recall 0.9500) come from `pnpm measure:dedup` running
 * the real `bge-small-en-v1.5`, and are recorded in ARCHITECTURE.md §5. Conflating
 * the two would let a green CI imply a quality claim it did not test.
 */

const registry = new EntityRegistry(
  [
    { id: 'anthropic', name: 'Anthropic', operatorRelevance: 1 },
    { id: 'nvidia', name: 'NVIDIA', operatorRelevance: 0.65 },
  ],
  [
    {
      entityId: 'anthropic',
      alias: 'Anthropic',
      normalized: 'anthropic',
      requiresExactCase: false,
    },
    { entityId: 'anthropic', alias: 'Claude', normalized: 'claude', requiresExactCase: false },
    { entityId: 'nvidia', alias: 'NVIDIA', normalized: 'nvidia', requiresExactCase: false },
  ],
);

function item(overrides: {
  id?: number;
  title: string;
  body?: string;
  url: string;
  at: string;
  sourceId?: string;
  sourceCategory?: 'OFFICIAL_SOURCE' | 'JOURNALIST' | 'COMMUNITY_SIGNAL';
}) {
  const at = new Date(overrides.at);
  return normalizeItem(
    {
      rawItemId: overrides.id ?? 1,
      source: {
        id: overrides.sourceId ?? 'test-source',
        category: overrides.sourceCategory ?? 'JOURNALIST',
        isOfficial: (overrides.sourceCategory ?? 'JOURNALIST') === 'OFFICIAL_SOURCE',
        reliability: 0.8,
        entity: null,
      },
      title: overrides.title,
      body: overrides.body ?? '',
      url: overrides.url,
      contentHash: `hash-${String(overrides.id ?? 1)}`,
      publishedAt: at,
      fetchedAt: at,
    },
    registry,
  );
}

function candidateFrom(
  normalized: ReturnType<typeof item>,
  eventId = 1,
  embedding?: Float32Array,
): ClusterCandidate {
  return {
    eventId,
    category: normalized.category,
    entities: normalized.entities,
    artifacts: normalized.artifacts,
    canonicalUrls: new Set([normalized.canonicalUrl]),
    contentHashes: new Set([normalized.contentHash]),
    eventOccurredAt: normalized.eventOccurredAt,
    embedding,
    primarySourceCategory: normalized.sourceCategory,
  };
}

describe('stage 1 — exact identity', () => {
  it('merges on an identical canonical URL', () => {
    const a = item({ id: 1, title: 'Launch', url: 'https://x.test/a', at: '2026-08-10T10:00:00Z' });
    const b = item({
      id: 2,
      title: 'Completely different words here',
      // Same article, reached through a tracking URL.
      url: 'https://www.x.test/a/?utm_source=newsletter',
      at: '2026-08-10T12:00:00Z',
    });

    const decision = decideCluster(b, [candidateFrom(a)], undefined);
    expect(decision.kind).toBe('merge');
    if (decision.kind === 'merge') expect(decision.stage).toBe(1);
  });

  it('merges on an identical content hash even when URLs differ', () => {
    const a = item({ id: 1, title: 'Launch', url: 'https://x.test/a', at: '2026-08-10T10:00:00Z' });
    const b = {
      ...item({ id: 1, title: 'Launch', url: 'https://y.test/b', at: '2026-08-10T11:00:00Z' }),
    };

    const decision = decideCluster(b, [candidateFrom(a)], undefined);
    expect(decision.kind).toBe('merge');
  });

  it('ignores the time window — a re-fetch of an old post is the same post', () => {
    // Applying the 48h window at stage 1 would create a duplicate event for anything
    // older than the window, which is the opposite of what stage 1 is for.
    const old = item({
      id: 1,
      title: 'Old post',
      url: 'https://x.test/old',
      at: '2024-01-01T00:00:00Z',
    });
    const refetch = item({
      id: 2,
      title: 'Old post',
      url: 'https://x.test/old',
      at: '2026-08-10T10:00:00Z',
    });

    const decision = decideCluster(refetch, [candidateFrom(old)], undefined);
    expect(decision.kind).toBe('merge');
    if (decision.kind === 'merge') expect(decision.stage).toBe(1);
  });
});

describe('stage 2 — same named thing, close in time', () => {
  it('merges six outlets covering one launch', () => {
    // ROADMAP.md acceptance: "The six-outlet launch case produces exactly one event
    // with six evidence rows."
    const official = item({
      id: 1,
      title: 'Introducing claude-opus-5',
      body: 'Anthropic releases claude-opus-5 today.',
      url: 'https://anthropic.test/news/opus5',
      at: '2026-08-10T15:00:00Z',
      sourceCategory: 'OFFICIAL_SOURCE',
    });

    let candidate = candidateFrom(official);
    for (const [index, title] of [
      'Anthropic launches claude-opus-5',
      'claude-opus-5 arrives for developers',
      'A first look at claude-opus-5',
      'What claude-opus-5 changes',
      'claude-opus-5, briefly',
    ].entries()) {
      const outlet = item({
        id: index + 2,
        title,
        body: 'Anthropic shipped claude-opus-5.',
        url: `https://outlet${String(index)}.test/story`,
        at: `2026-08-10T${String(16 + index).padStart(2, '0')}:00:00Z`,
      });

      const decision = decideCluster(outlet, [candidate], undefined);
      expect(decision.kind, title).toBe('merge');
      if (decision.kind === 'merge') expect(decision.stage).toBe(2);

      candidate = {
        ...candidate,
        canonicalUrls: new Set([...candidate.canonicalUrls, outlet.canonicalUrl]),
      };
    }
  });

  it('does NOT merge two different models from one vendor on one day', () => {
    // The adversarial case, and the destructive failure: a wrong merge HIDES a launch.
    const opus = item({
      id: 1,
      title: 'Introducing claude-opus-5',
      body: 'Our most capable model.',
      url: 'https://anthropic.test/news/opus5',
      at: '2026-08-10T15:00:00Z',
      sourceCategory: 'OFFICIAL_SOURCE',
    });
    const sonnet = item({
      id: 2,
      title: 'Introducing claude-sonnet-5',
      body: 'A faster, cheaper model.',
      url: 'https://anthropic.test/news/sonnet5',
      at: '2026-08-10T15:05:00Z',
      sourceCategory: 'OFFICIAL_SOURCE',
    });

    expect(decideCluster(sonnet, [candidateFrom(opus)], undefined).kind).toBe('new');
  });

  it('does not merge on a shared entity alone', () => {
    // Without the artifact requirement, every Anthropic item within 48 hours merges
    // into one event and a real launch becomes invisible inside it.
    const a = item({
      id: 1,
      title: 'Anthropic publishes a research note',
      url: 'https://x.test/1',
      at: '2026-08-10T10:00:00Z',
    });
    const b = item({
      id: 2,
      title: 'Anthropic announces an office move',
      url: 'https://x.test/2',
      at: '2026-08-10T12:00:00Z',
    });

    expect(decideCluster(b, [candidateFrom(a)], undefined).kind).toBe('new');
  });

  it('does not merge outside the 48-hour window', () => {
    const launch = item({
      id: 1,
      title: 'Introducing claude-opus-5',
      url: 'https://x.test/1',
      at: '2026-08-10T15:00:00Z',
    });
    const followUp = item({
      id: 2,
      title: 'Pricing update for claude-opus-5',
      url: 'https://x.test/2',
      at: '2026-08-13T15:00:00Z',
    });

    expect(decideCluster(followUp, [candidateFrom(launch)], undefined).kind).toBe('new');
  });
});

describe('stage 3 — paraphrase, by embedding', () => {
  const embedder = new DeterministicEmbedder();

  it('merges paraphrases above the threshold', async () => {
    const a = item({
      id: 1,
      title: 'The quick brown fox jumps over the lazy dog',
      url: 'https://x.test/1',
      at: '2026-08-10T10:00:00Z',
    });
    const b = item({
      id: 2,
      title: 'The quick brown fox jumps over the lazy dog today',
      url: 'https://x.test/2',
      at: '2026-08-10T11:00:00Z',
    });

    const [ea, eb] = await embedder.embed([a.embeddingText, b.embeddingText]);
    if (ea === undefined || eb === undefined) throw new Error('embedder returned nothing');

    const decision = decideCluster(b, [candidateFrom(a, 1, ea)], eb);
    expect(decision.kind).toBe('merge');
    if (decision.kind === 'merge') expect(decision.stage).toBe(3);
  });

  it('refuses a merge when both sides name DIFFERENT artifacts, however similar the text', () => {
    // Measured from real data: llama.cpp b10400 and b10405 embed at cosine 0.9649
    // because their text is nearly identical. They are two releases, and merging
    // them hides one. Artifacts are the higher-precision identity signal and win.
    const a = item({
      id: 1,
      title: 'b10400',
      body: 'llama.cpp release b10400',
      url: 'https://x.test/b10400',
      at: '2026-08-10T10:00:00Z',
    });
    const b = item({
      id: 2,
      title: 'b10405',
      body: 'llama.cpp release b10405',
      url: 'https://x.test/b10405',
      at: '2026-08-10T11:00:00Z',
    });

    expect(a.artifacts.versions).toContain('b10400');
    expect(b.artifacts.versions).toContain('b10405');

    // Force a near-perfect embedding match, so only the artifact rule can stop it.
    const identical = normalize(Float32Array.from({ length: 384 }, (_v, i) => (i % 7) + 1));

    const decision = decideCluster(b, [candidateFrom(a, 1, identical)], identical);
    expect(decision.kind).toBe('new');
  });

  it('allows a merge when only ONE side names an artifact — absence is not disagreement', () => {
    const withArtifact = item({
      id: 1,
      title: 'claude-opus-5 released',
      url: 'https://x.test/1',
      at: '2026-08-10T10:00:00Z',
    });
    const without = item({
      id: 2,
      title: 'A new frontier model is out',
      url: 'https://x.test/2',
      at: '2026-08-10T11:00:00Z',
    });

    expect(artifactsConflict(withArtifact.artifacts, without.artifacts)).toBe(false);
  });

  it('skips candidates with no embedding rather than treating them as dissimilar', async () => {
    const a = item({
      id: 1,
      title: 'Something',
      url: 'https://x.test/1',
      at: '2026-08-10T10:00:00Z',
    });
    const b = item({
      id: 2,
      title: 'Something else entirely',
      url: 'https://x.test/2',
      at: '2026-08-10T11:00:00Z',
    });
    const [eb] = await embedder.embed([b.embeddingText]);

    expect(decideCluster(b, [candidateFrom(a, 1, undefined)], eb).kind).toBe('new');
  });

  it('does nothing at all when the item itself has no embedding', () => {
    const a = item({
      id: 1,
      title: 'Something',
      url: 'https://x.test/1',
      at: '2026-08-10T10:00:00Z',
    });
    const b = item({
      id: 2,
      title: 'Something',
      url: 'https://x.test/2',
      at: '2026-08-10T11:00:00Z',
    });
    // Same title, different URL, no artifacts, no shared entity → nothing can match.
    expect(decideCluster(b, [candidateFrom(a)], undefined).kind).toBe('new');
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors and 0 for orthogonal ones', () => {
    const a = Float32Array.from([1, 0, 0]);
    const b = Float32Array.from([0, 1, 0]);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0);
  });

  it('returns 0 rather than NaN for a zero vector', () => {
    expect(cosineSimilarity(Float32Array.from([0, 0]), Float32Array.from([1, 1]))).toBe(0);
  });

  it('returns 0 for mismatched dimensions instead of reading past the end', () => {
    expect(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([1, 0, 0]))).toBe(0);
  });
});

describe('embedding round-trip through SQLite', () => {
  it('survives being written and read back', () => {
    const original = normalize(Float32Array.from({ length: 384 }, (_v, i) => Math.sin(i)));
    const restored = bufferToEmbedding(embeddingToBuffer(original));

    expect(restored.length).toBe(original.length);
    expect(cosineSimilarity(original, restored)).toBeCloseTo(1, 6);
  });

  it('copies rather than views, so a reused buffer cannot change it underneath', () => {
    const buffer = embeddingToBuffer(normalize(Float32Array.from([1, 2, 3, 4])));
    const restored = bufferToEmbedding(buffer);
    buffer.fill(0);
    expect(restored.some((v) => v !== 0)).toBe(true);
  });
});

describe('primary-source selection', () => {
  it('ranks an official source above a journalist', () => {
    // ARCHITECTURE.md §5: "OFFICIAL_SOURCE outranks JOURNALIST even if the journalist
    // published first. A journalist's report about a launch is evidence; the launch
    // post is the record."
    expect(sourceAuthority('OFFICIAL_SOURCE')).toBeGreaterThan(sourceAuthority('JOURNALIST'));
    expect(sourceAuthority('JOURNALIST')).toBeGreaterThan(sourceAuthority('COMMUNITY_SIGNAL'));
    expect(shouldReplacePrimary('JOURNALIST', 'OFFICIAL_SOURCE')).toBe(true);
    expect(shouldReplacePrimary('OFFICIAL_SOURCE', 'JOURNALIST')).toBe(false);
  });

  it('does not churn on a tie', () => {
    expect(shouldReplacePrimary('OFFICIAL_SOURCE', 'OFFICIAL_SOURCE')).toBe(false);
  });

  it('classifies community chatter as a reaction, not corroboration', () => {
    expect(evidenceRole({ sourceCategory: 'COMMUNITY_SIGNAL' }, false)).toBe('reaction');
    expect(evidenceRole({ sourceCategory: 'JOURNALIST' }, false)).toBe('corroborating');
    expect(evidenceRole({ sourceCategory: 'JOURNALIST' }, true)).toBe('primary');
  });
});

describe('the labelled set', () => {
  it('contains the adversarial cases the roadmap names', () => {
    const labels = LABELLED_CLUSTERS.map((c) => c.label);
    expect(labels).toContain('syn-opus5-launch'); // six outlets, must merge
    expect(labels).toContain('syn-sameday-sonnet'); // two models, must not
    expect(labels).toContain('syn-opus5-followup'); // 3 days later, must not
    expect(labels).toContain('real-llamacpp-b10400');
    expect(labels).toContain('real-llamacpp-b10405');
  });

  it('declares the provenance of every cluster', () => {
    for (const cluster of LABELLED_CLUSTERS) {
      expect(['real', 'synthetic']).toContain(cluster.provenance);
      expect(cluster.note.length, cluster.label).toBeGreaterThan(20);
      expect(cluster.items.length, cluster.label).toBeGreaterThan(0);
    }
  });

  it('has a six-item cluster for the six-outlet case', () => {
    expect(LABELLED_CLUSTERS.find((c) => c.label === 'syn-opus5-launch')?.items).toHaveLength(6);
  });

  it('has no duplicate item ids across clusters', () => {
    const ids = LABELLED_CLUSTERS.flatMap((c) => c.items.map((i) => i.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('measured clustering — plumbing, with the deterministic embedder', () => {
  // These prove the stages fire and the adversarial cases behave. The QUALITY numbers
  // are produced by `pnpm measure:dedup` against the real model — see the file header.
  it('makes no wrong merges on the labelled set', async () => {
    const result = await measureClustering({
      registry,
      embedder: new DeterministicEmbedder(),
      similarityThreshold: DEDUP_SIMILARITY_THRESHOLD,
    });

    expect(result.wrongMerges, JSON.stringify(result.wrongMerges)).toEqual([]);
    expect(result.precision).toBe(1);
  });

  it('merges the six-outlet launch into exactly one event', async () => {
    const cluster = LABELLED_CLUSTERS.filter((c) => c.label === 'syn-opus5-launch');
    const result = await measureClustering({ registry, clusters: cluster });

    // 6 items, all one event → every one of the 15 pairs is a true positive.
    expect(result.truePositives).toBe(15);
    expect(result.falseNegatives).toBe(0);
  });

  it('keeps two same-day models apart', async () => {
    const clusters = LABELLED_CLUSTERS.filter(
      (c) => c.label === 'syn-opus5-launch' || c.label === 'syn-sameday-sonnet',
    );
    const result = await measureClustering({ registry, clusters });
    expect(result.falsePositives).toBe(0);
  });

  it('is deterministic — the same input produces the same clustering', async () => {
    // ROADMAP.md acceptance: "Full pipeline replay over raw_items is deterministic —
    // same input, same clusters." Phase 12's offline refitting depends on it.
    const run = () => measureClustering({ registry, embedder: new DeterministicEmbedder() });

    const first = await run();
    const second = await run();
    const third = await run();
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });
});
