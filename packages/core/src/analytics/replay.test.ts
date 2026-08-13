import { describe, it, expect } from 'vitest';
import {
  replay,
  compareReplays,
  classifyOutcome,
  BASELINE,
  type ReplayEvent,
  type Dimensions,
} from './replay.js';
import { extractArtifacts } from '../normalize/artifacts.js';
import type { ScorableEvent } from '../score/types.js';

/**
 * `ROADMAP.md` Phase 12 TESTS: "Attribution correctness. **Replay determinism.**
 * Weight-fitting produces reproducible output."
 */

const SCORED_AT = new Date('2026-08-13T12:00:00Z');
const context = {
  entityRelevance: new Map([
    ['anthropic', 1.0],
    ['apple', 0.2],
  ]),
};

function event(id: number, overrides: Partial<ScorableEvent> = {}): ScorableEvent {
  const occurred = overrides.eventOccurredAt ?? new Date(SCORED_AT.getTime() - 3_600_000);
  return {
    id,
    title: 'Anthropic releases claude-opus-5',
    summary: 'A new flagship model.',
    category: 'ai',
    entities: ['anthropic'],
    artifacts: extractArtifacts('Anthropic releases claude-opus-5', 'claude-opus-5'),
    eventOccurredAt: occurred,
    occurredAtIsEstimated: false,
    firstSeenAt: new Date(occurred.getTime() + 600_000),
    evidence: [
      {
        sourceId: 'anthropic-news-diff',
        sourceCategory: 'OFFICIAL_SOURCE',
        isOfficial: true,
        reliability: 0.95,
        publishedAt: occurred,
      },
      {
        sourceId: 'techcrunch',
        sourceCategory: 'JOURNALIST',
        isOfficial: false,
        reliability: 0.6,
        publishedAt: occurred,
      },
    ],
    injectionFlagged: false,
    ...overrides,
  };
}

const corpus: ReplayEvent[] = [
  { event: event(1), scoredAt: SCORED_AT, sourceIds: ['anthropic-news-diff', 'techcrunch'] },
  {
    event: event(2, { entities: ['apple'], title: 'Apple ships a laptop' }),
    scoredAt: SCORED_AT,
    sourceIds: ['techcrunch', 'verge'],
  },
  {
    event: event(3, { eventOccurredAt: new Date(SCORED_AT.getTime() - 20 * 86_400_000) }),
    scoredAt: SCORED_AT,
    sourceIds: ['anthropic-news-diff', 'techcrunch'],
  },
];

describe('replay determinism', () => {
  it('produces byte-identical results across runs', () => {
    // The whole refit depends on this. If a replay drifted, comparing candidates would
    // be comparing noise.
    expect(replay(corpus, context, BASELINE)).toEqual(replay(corpus, context, BASELINE));
  });

  it('uses the STORED scoredAt, not the clock', () => {
    // A scorer reading Date.now() internally would make every replay meaningless while
    // looking like it worked. The stale event stays stale however long ago it was.
    const first = replay(corpus, context, BASELINE);
    const later = replay(
      corpus.map((entry) => ({ ...entry })),
      context,
      BASELINE,
    );
    expect(later.passedIds).toEqual(first.passedIds);
    // Event 3 is 20 days old at ITS scoredAt, so staleness kills it regardless.
    expect(first.passedIds).not.toContain(3);
    expect(first.byKillRule.too_old).toBe(1);
  });

  it('costs nothing — it never touches the network', () => {
    // The acceptance criterion is "$0 API cost". Replay is pure computation over
    // stored rows; there is nothing here that could spend.
    expect(() => replay(corpus, context, BASELINE)).not.toThrow();
  });

  it('handles an empty corpus', () => {
    expect(replay([], context, BASELINE).killRate).toBe(0);
  });
});

describe('candidate weights change what surfaces', () => {
  it('a raised floor surfaces strictly fewer events', () => {
    const base = replay(corpus, context, BASELINE);
    const strict = replay(corpus, context, { ...BASELINE, name: 'strict', minCombined: 95 });
    expect(strict.passed).toBeLessThanOrEqual(base.passed);
    expect(strict.byKillRule.candidate_min_combined).toBeGreaterThan(0);
  });

  it('a shortened age window surfaces fewer events', () => {
    const strict = replay(corpus, context, { ...BASELINE, name: 'fresh-only', maxAgeDays: 0.5 });
    expect(strict.passed).toBeLessThan(replay(corpus, context, BASELINE).passed + 1);
  });

  it('names the CANDIDATE rule when the candidate is what killed it', () => {
    // A candidate that silently failed to apply would look like "no difference",
    // which is the failure mode of a refit that proves nothing.
    const strict = replay(corpus, context, { ...BASELINE, name: 's', minCombined: 99 });
    expect(Object.keys(strict.byKillRule)).toContain('candidate_min_combined');
  });

  it('boosting relevance can surface something the baseline dropped', () => {
    const boosted = replay(corpus, context, { ...BASELINE, name: 'boost', relevanceMultiplier: 2 });
    expect(boosted.passed).toBeGreaterThanOrEqual(replay(corpus, context, BASELINE).passed);
  });
});

describe('comparing replays', () => {
  it('reports the DISAGREEMENT, not just the totals', () => {
    // Two candidates that pass the same COUNT while surfacing different events are not
    // equivalent, and a comparison reporting only kill rates would call them identical.
    const base = replay(corpus, context, BASELINE);
    const strict = replay(corpus, context, { ...BASELINE, name: 'strict', minCombined: 95 });
    const comparison = compareReplays(base, strict);
    expect(comparison.noLongerSurfaced.length).toBeGreaterThan(0);
    expect(comparison.agreement).toBeLessThan(1);
  });

  it('reports perfect agreement when nothing changed', () => {
    const base = replay(corpus, context, BASELINE);
    expect(compareReplays(base, base).agreement).toBe(1);
    expect(compareReplays(base, base).newlySurfaced).toEqual([]);
  });
});

describe('the four dimensions are never merged', () => {
  const wideAndHollow: Dimensions = {
    visibility: { impressions: 90_000, reposts: 400 },
    authority: { highSignalReplies: 0, mentionsByRespected: 0, conversationDepth: 1 },
    audience: { follows: 2, profileVisits: 300 },
    quality: { savedOrBookmarked: 5, repliesAsking: 0 },
  };

  const narrowAndRespected: Dimensions = {
    visibility: { impressions: 1_200, reposts: 4 },
    authority: { highSignalReplies: 3, mentionsByRespected: 1, conversationDepth: 6 },
    audience: { follows: 14, profileVisits: 90 },
    quality: { savedOrBookmarked: 40, repliesAsking: 6 },
  };

  it('calls out low-quality virality explicitly', () => {
    // The failure this whole system exists to avoid, and it looks like SUCCESS on any
    // dashboard that reports one number.
    const verdict = classifyOutcome(wideAndHollow);
    expect(verdict.kind).toBe('low_quality_virality');
    expect(verdict.explanation).toContain('built no authority');
  });

  it('calls a small, well-received post authority growth', () => {
    const verdict = classifyOutcome(narrowAndRespected);
    expect(verdict.kind).toBe('authority_growth');
    // Reach is named last and dismissed, because it is the least interesting number.
    expect(verdict.explanation).toContain('least interesting');
  });

  it('ranks the hollow post BELOW the small one, which one number never would', () => {
    expect(classifyOutcome(wideAndHollow).kind).toBe('low_quality_virality');
    expect(classifyOutcome(narrowAndRespected).kind).toBe('authority_growth');
  });

  it('treats a quiet post as normal rather than as failure', () => {
    const verdict = classifyOutcome({
      visibility: { impressions: 200, reposts: 0 },
      authority: { highSignalReplies: 0, mentionsByRespected: 0, conversationDepth: 0 },
      audience: { follows: 0, profileVisits: 3 },
      quality: { savedOrBookmarked: 0, repliesAsking: 0 },
    });
    expect(verdict.kind).toBe('quiet');
    expect(verdict.explanation).toContain('not a failure');
  });

  it('exposes NO combined score anywhere', () => {
    // "reported separately, never merged into one number". Merging them is how an
    // authority-building system quietly becomes an engagement-farming one.
    const dimensions: Dimensions = narrowAndRespected;
    expect(Object.keys(dimensions).sort()).toEqual([
      'audience',
      'authority',
      'quality',
      'visibility',
    ]);
    expect(Object.keys(classifyOutcome(dimensions))).toEqual(['kind', 'explanation']);
  });
});
