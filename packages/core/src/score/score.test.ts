import { describe, it, expect } from 'vitest';
import type { ConfidenceLevel, EvidenceTag, SourceCategory } from '@signal-desk/shared';
import { EMPTY_ARTIFACTS, extractArtifacts } from '../normalize/artifacts.js';
import { scoreEvent } from './index.js';
import { scoreImportance, scoreVelocity } from './importance.js';
import { scoreBrandRelevance } from './relevance.js';
import { scoreConfidence, applyCaps, confidenceValue } from './confidence.js';
import { applyGate, summariseGate } from './gate.js';
import {
  IMPORTANCE_WEIGHTS,
  RELEVANCE_WEIGHTS,
  VELOCITY_WEIGHTS,
  GATE_MAX_AGE_DAYS,
  HIGH_CONFIDENCE_MIN_SOURCES,
} from './weights.js';
import type { EvidenceInput, ScorableEvent } from './types.js';

/**
 * ROADMAP.md Phase 5 TESTS: "Golden-file tests: a fixed set of events with expected
 * score ranges. Monotonicity (adding an official source never lowers confidence).
 * Boundary cases."
 *
 * ACCEPTANCE: "Confidence capping rules provably cannot be bypassed."
 *
 * The confidence caps get a property test rather than examples, because "provably"
 * is the word the criterion uses and a handful of cases proves nothing about the
 * combination that was not tried.
 */

const NOW = new Date('2026-08-13T12:00:00Z');

function evidence(
  sourceId: string,
  sourceCategory: SourceCategory,
  options: { isOfficial?: boolean; reliability?: number; hoursAgo?: number } = {},
): EvidenceInput {
  return {
    sourceId,
    sourceCategory,
    isOfficial: options.isOfficial ?? sourceCategory === 'OFFICIAL_SOURCE',
    reliability: options.reliability ?? (sourceCategory === 'OFFICIAL_SOURCE' ? 0.95 : 0.6),
    publishedAt: new Date(NOW.getTime() - (options.hoursAgo ?? 1) * 3_600_000),
  };
}

function event(overrides: Partial<ScorableEvent> = {}): ScorableEvent {
  const occurred = overrides.eventOccurredAt ?? new Date(NOW.getTime() - 3_600_000);
  return {
    id: 1,
    title: 'Anthropic releases claude-opus-5',
    summary: 'A new flagship model with a larger context window.',
    category: 'ai',
    entities: ['anthropic'],
    artifacts: extractArtifacts(
      'Anthropic releases claude-opus-5',
      'Anthropic releases claude-opus-5',
    ),
    eventOccurredAt: occurred,
    occurredAtIsEstimated: false,
    firstSeenAt: new Date(occurred.getTime() + 600_000),
    evidence: [evidence('anthropic-news-diff', 'OFFICIAL_SOURCE')],
    injectionFlagged: false,
    ...overrides,
  };
}

const relevanceContext = {
  entityRelevance: new Map([
    ['anthropic', 1.0],
    ['supabase', 0.9],
    ['apple', 0.25],
  ]),
};

describe('weights are internally consistent', () => {
  it.each([
    ['importance', IMPORTANCE_WEIGHTS],
    ['relevance', RELEVANCE_WEIGHTS],
    ['velocity', VELOCITY_WEIGHTS],
  ])('%s weights sum to 1.0', (_name, weights) => {
    const sum = Object.values(weights).reduce((total, weight) => total + weight, 0);
    expect(sum).toBeCloseTo(1, 6);
  });
});

describe('every score carries its explanation', () => {
  // ROADMAP.md Phase 5 acceptance: "Every score is reproducible and accompanied by a
  // component breakdown." An operator who cannot see why something scored 82 will
  // not trust the number.
  it('returns a component per weight, each with a readable sentence', () => {
    const scores = scoreEvent(event(), relevanceContext, NOW);

    for (const score of [scores.importance, scores.brandRelevance, scores.velocity]) {
      expect(score.components.length).toBeGreaterThan(0);
      for (const item of score.components) {
        expect(item.explanation.length, item.name).toBeGreaterThan(10);
        expect(item.value).toBeGreaterThanOrEqual(0);
        expect(item.value).toBeLessThanOrEqual(1);
        expect(item.contribution).toBeCloseTo(item.value * item.weight, 10);
      }
    }
  });

  it('has components that sum to the total', () => {
    const score = scoreImportance(event(), NOW);
    const sum = score.components.reduce((total, item) => total + item.contribution, 0);
    expect(score.value).toBe(Math.round(sum * 100));
  });

  it('is reproducible — same event and same clock, same numbers', () => {
    const target = event();
    const a = scoreEvent(target, relevanceContext, NOW);
    const b = scoreEvent(target, relevanceContext, NOW);
    expect(b).toEqual(a);
  });

  it('records the scorer version, so a Phase-12 refit can compare like with like', () => {
    expect(scoreEvent(event(), relevanceContext, NOW).scoredWith).toMatch(/^phase5-/);
  });
});

describe('importance', () => {
  it('ranks an official announcement above a lone comment thread', () => {
    const official = scoreImportance(event(), NOW);
    const chatter = scoreImportance(
      event({ evidence: [evidence('hn-frontpage', 'COMMUNITY_SIGNAL')] }),
      NOW,
    );
    expect(official.value).toBeGreaterThan(chatter.value);
  });

  it('takes the BEST evidence, not the average', () => {
    // An official post corroborated by five comment threads is exactly as
    // authoritative as the post alone. Averaging would drag it below a lone
    // journalist's report, which is the wrong ordering.
    const alone = scoreImportance(event(), NOW);
    const withChatter = scoreImportance(
      event({
        evidence: [
          evidence('anthropic-news-diff', 'OFFICIAL_SOURCE'),
          evidence('hn-frontpage', 'COMMUNITY_SIGNAL'),
          evidence('reddit-localllama', 'COMMUNITY_SIGNAL'),
        ],
      }),
      NOW,
    );
    expect(withChatter.value).toBeGreaterThanOrEqual(alone.value);
  });

  it('counts distinct sources, not distinct items', () => {
    // Six items from one feed is one source repeating itself.
    const oneSourceSixItems = scoreImportance(
      event({
        evidence: Array.from({ length: 6 }, () => evidence('techcrunch', 'JOURNALIST')),
      }),
      NOW,
    );
    const sixSources = scoreImportance(
      event({
        evidence: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => evidence(id, 'JOURNALIST')),
      }),
      NOW,
    );
    expect(sixSources.value).toBeGreaterThan(oneSourceSixItems.value);
  });

  it('decays with age', () => {
    const fresh = scoreImportance(event(), NOW);
    const old = scoreImportance(
      event({ eventOccurredAt: new Date(NOW.getTime() - 72 * 3_600_000) }),
      NOW,
    );
    expect(old.value).toBeLessThan(fresh.value);
  });

  it('scores novelty neutrally when the publisher gave no timestamp', () => {
    // Guessing would be worse than admitting ignorance: an estimated timestamp
    // cannot distinguish "brand new" from "we only just noticed".
    const estimated = scoreImportance(event({ occurredAtIsEstimated: true }), NOW);
    const novelty = estimated.components.find((item) => item.name === 'novelty');
    expect(novelty?.value).toBe(0.5);
    expect(novelty?.explanation).toContain('cannot be determined');
  });

  it('rates a breaking change above a benchmark result', () => {
    const breaking = scoreImportance(
      event({ title: 'Breaking change to the Messages API', summary: 'Deprecated parameters.' }),
      NOW,
    );
    const benchmark = scoreImportance(
      event({ title: 'New benchmark results published', summary: 'Outperforms the prior model.' }),
      NOW,
    );
    expect(breaking.value).toBeGreaterThan(benchmark.value);
  });

  it('never returns a value outside 0..100', () => {
    for (const target of [
      event(),
      event({ evidence: [] }),
      event({ eventOccurredAt: new Date('1999-01-01') }),
      event({ eventOccurredAt: new Date(NOW.getTime() + 86_400_000) }), // future-dated
    ]) {
      const value = scoreImportance(target, NOW).value;
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });
});

describe('velocity — the INFERRED X substitute', () => {
  it('rewards corroboration that arrives quickly', () => {
    const fast = scoreVelocity(
      event({
        evidence: [
          evidence('a', 'OFFICIAL_SOURCE', { hoursAgo: 6 }),
          evidence('b', 'JOURNALIST', { hoursAgo: 5 }),
          evidence('c', 'JOURNALIST', { hoursAgo: 4 }),
        ],
      }),
      NOW,
    );
    const slow = scoreVelocity(
      event({
        evidence: [
          evidence('a', 'OFFICIAL_SOURCE', { hoursAgo: 200 }),
          evidence('b', 'JOURNALIST', { hoursAgo: 100 }),
          evidence('c', 'JOURNALIST', { hoursAgo: 4 }),
        ],
      }),
      NOW,
    );
    expect(fast.value).toBeGreaterThan(slow.value);
  });

  it('labels itself as an unvalidated proxy in the importance breakdown', () => {
    // SOURCE-INTELLIGENCE.md §0 and THREAT-MODEL.md §6 both record this as INFERRED.
    // The label travels with the number so it cannot quietly become an assumption.
    const velocity = scoreImportance(event(), NOW).components.find(
      (item) => item.name === 'velocity',
    );
    expect(velocity?.explanation).toContain('INFERRED');
    expect(velocity?.explanation).toContain('Phase 12');
  });

  it('handles an event with no evidence', () => {
    expect(scoreVelocity(event({ evidence: [] }), NOW).value).toBe(0);
  });
});

describe('brand relevance', () => {
  it('ranks the operator’s own stack above a distant vendor', () => {
    const own = scoreBrandRelevance(event({ entities: ['anthropic'] }), relevanceContext);
    const distant = scoreBrandRelevance(event({ entities: ['apple'] }), relevanceContext);
    expect(own.value).toBeGreaterThan(distant.value);
  });

  it('takes the closest entity, not the average', () => {
    // An event touching Anthropic and Apple is an Anthropic event for this operator.
    const both = scoreBrandRelevance(event({ entities: ['anthropic', 'apple'] }), relevanceContext);
    const appleOnly = scoreBrandRelevance(event({ entities: ['apple'] }), relevanceContext);
    expect(both.value).toBeGreaterThan(appleOnly.value);
  });

  it('lowers differentiation when an expert has already covered it', () => {
    // SOURCE-INTELLIGENCE.md §3: "if he has already published the experiment, the
    // operator's angle must be different, not duplicative."
    const uncovered = scoreBrandRelevance(event(), relevanceContext);
    const covered = scoreBrandRelevance(
      event({
        evidence: [
          evidence('anthropic-news-diff', 'OFFICIAL_SOURCE'),
          evidence('simonwillison', 'EXPERT_ANALYST'),
        ],
      }),
      relevanceContext,
    );
    expect(covered.value).toBeLessThan(uncovered.value);
  });

  it('rewards something testable with a concrete artifact', () => {
    const concrete = scoreBrandRelevance(event(), relevanceContext);
    const vague = scoreBrandRelevance(
      event({
        title: 'Anthropic shares thoughts on the future',
        artifacts: EMPTY_ARTIFACTS,
      }),
      relevanceContext,
    );
    expect(concrete.value).toBeGreaterThan(vague.value);
  });

  it('handles an event with no recognised entity', () => {
    const score = scoreBrandRelevance(event({ entities: [] }), relevanceContext);
    expect(score.value).toBeGreaterThanOrEqual(0);
    expect(score.components.find((c) => c.name === 'entityProximity')?.explanation).toContain(
      'no known entity',
    );
  });
});

describe('confidence caps — provably cannot be bypassed', () => {
  const LEVELS: ConfidenceLevel[] = ['LOW', 'MED', 'HIGH'];
  const TAGS: EvidenceTag[] = ['SPECULATIVE', 'INFERRED', 'OBSERVED', 'VERIFIED'];
  const LEVEL_RANK = (level: ConfidenceLevel) => LEVELS.indexOf(level);
  const TAG_RANK = (tag: EvidenceTag) => TAGS.indexOf(tag);

  it('never RAISES confidence, for any combination of inputs', () => {
    // The property that makes "cannot be bypassed" meaningful. Exhaustive over the
    // whole input space — 3 levels × 4 tags × 2^3 flags × 4 source counts.
    for (const level of LEVELS) {
      for (const tag of TAGS) {
        for (const hasOfficial of [true, false]) {
          for (const injectionFlagged of [true, false]) {
            for (const occurredAtIsEstimated of [true, false]) {
              for (const distinctSourceCount of [0, 1, 2, 6]) {
                const result = applyCaps(
                  { level, tag },
                  {
                    hasOfficial,
                    distinctSourceCount,
                    injectionFlagged,
                    occurredAtIsEstimated,
                  },
                );
                expect(LEVEL_RANK(result.level)).toBeLessThanOrEqual(LEVEL_RANK(level));
                expect(TAG_RANK(result.tag)).toBeLessThanOrEqual(TAG_RANK(tag));
              }
            }
          }
        }
      }
    }
  });

  it('caps unofficial-only evidence at LOW / SPECULATIVE however much of it there is', () => {
    // THREAT-MODEL.md §5 test 7, and §T-2's rumour cap. No amount of corroboration
    // from unofficial sources manufactures certainty — which is exactly how a rumour
    // launders itself into fact through repetition.
    for (const count of [1, 2, 5, 50]) {
      const result = applyCaps(
        { level: 'HIGH', tag: 'VERIFIED' },
        {
          hasOfficial: false,
          distinctSourceCount: count,
          injectionFlagged: false,
          occurredAtIsEstimated: false,
        },
      );
      expect(result.level, `${String(count)} unofficial sources`).toBe('LOW');
      expect(result.tag).toBe('SPECULATIVE');
      expect(result.caps.join(' ')).toContain('T-2');
    }
  });

  it('enforces the two-source rule even for an official source', () => {
    // THREAT-MODEL.md §T-1 mitigation 7. One source is one source.
    const result = applyCaps(
      { level: 'HIGH', tag: 'VERIFIED' },
      {
        hasOfficial: true,
        distinctSourceCount: 1,
        injectionFlagged: false,
        occurredAtIsEstimated: false,
      },
    );
    expect(result.level).not.toBe('HIGH');
    expect(result.caps.join(' ')).toContain('two-source rule');
  });

  it('allows HIGH only with an official source AND corroboration', () => {
    const result = applyCaps(
      { level: 'HIGH', tag: 'VERIFIED' },
      {
        hasOfficial: true,
        distinctSourceCount: HIGH_CONFIDENCE_MIN_SOURCES,
        injectionFlagged: false,
        occurredAtIsEstimated: false,
      },
    );
    expect(result.level).toBe('HIGH');
    expect(result.tag).toBe('VERIFIED');
    expect(result.caps).toEqual([]);
  });

  it('caps injected content', () => {
    const result = applyCaps(
      { level: 'HIGH', tag: 'VERIFIED' },
      {
        hasOfficial: true,
        distinctSourceCount: 5,
        injectionFlagged: true,
        occurredAtIsEstimated: false,
      },
    );
    expect(result.level).toBe('LOW');
    expect(result.caps.join(' ')).toContain('injection');
  });

  it('refuses VERIFIED when the publisher gave no timestamp', () => {
    const result = applyCaps(
      { level: 'HIGH', tag: 'VERIFIED' },
      {
        hasOfficial: true,
        distinctSourceCount: 5,
        injectionFlagged: false,
        occurredAtIsEstimated: true,
      },
    );
    expect(result.tag).not.toBe('VERIFIED');
  });

  it('explains every cap that actually changed something', () => {
    // Only *effective* caps are reported. A cap that fires on an already-capped value
    // changed nothing, and listing it would pad the explanation with rules that did
    // no work — the operator is reading this to understand the verdict, not to audit
    // the control flow.
    const result = applyCaps(
      { level: 'HIGH', tag: 'VERIFIED' },
      {
        hasOfficial: true,
        distinctSourceCount: 1,
        injectionFlagged: true,
        occurredAtIsEstimated: false,
      },
    );
    expect(result.caps.length).toBeGreaterThan(1);
    for (const cap of result.caps) expect(cap.length).toBeGreaterThan(20);
  });

  it('reports no caps when none were needed', () => {
    const result = applyCaps(
      { level: 'MED', tag: 'OBSERVED' },
      {
        hasOfficial: true,
        distinctSourceCount: 3,
        injectionFlagged: false,
        occurredAtIsEstimated: false,
      },
    );
    expect(result.caps).toEqual([]);
  });
});

describe('confidence monotonicity', () => {
  it('adding an official source never LOWERS confidence', () => {
    // ROADMAP.md Phase 5 TESTS names this property directly.
    const before = scoreConfidence(event({ evidence: [evidence('techcrunch', 'JOURNALIST')] }));
    const after = scoreConfidence(
      event({
        evidence: [
          evidence('techcrunch', 'JOURNALIST'),
          evidence('anthropic-news-diff', 'OFFICIAL_SOURCE'),
        ],
      }),
    );
    expect(confidenceValue(after.level)).toBeGreaterThanOrEqual(confidenceValue(before.level));
  });

  it('adding more sources never lowers confidence', () => {
    let previous = 0;
    for (let count = 1; count <= 6; count++) {
      const result = scoreConfidence(
        event({
          evidence: [
            evidence('anthropic-news-diff', 'OFFICIAL_SOURCE'),
            ...Array.from({ length: count - 1 }, (_v, i) =>
              evidence(`outlet-${String(i)}`, 'JOURNALIST'),
            ),
          ],
        }),
      );
      const value = confidenceValue(result.level);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('gives an event with no evidence the lowest confidence', () => {
    const result = scoreConfidence(event({ evidence: [] }));
    expect(result.level).toBe('LOW');
    expect(result.tag).toBe('SPECULATIVE');
  });
});

describe('the rule gate', () => {
  const gateContext = (sourceIds: string[]) => ({ sourceIds, now: NOW });

  function gateFor(target: ScorableEvent, sourceIds?: string[]) {
    const scores = scoreEvent(target, relevanceContext, NOW);
    return applyGate(
      target,
      scores,
      gateContext(sourceIds ?? target.evidence.map((item) => item.sourceId)),
    );
  }

  it('passes a well-sourced recent launch', () => {
    const decision = gateFor(
      event({
        evidence: [
          evidence('anthropic-news-diff', 'OFFICIAL_SOURCE'),
          evidence('techcrunch', 'JOURNALIST'),
        ],
      }),
    );
    expect(decision.passed).toBe(true);
  });

  it('kills anything past the staleness window', () => {
    // The largest filter, and the one the first measurement was missing entirely:
    // recency was a score component, so an event from 2023 lost points and still
    // cleared the floor.
    const decision = gateFor(
      event({
        eventOccurredAt: new Date(NOW.getTime() - (GATE_MAX_AGE_DAYS + 1) * 86_400_000),
        evidence: [
          evidence('anthropic-news-diff', 'OFFICIAL_SOURCE'),
          evidence('techcrunch', 'JOURNALIST'),
        ],
      }),
    );
    expect(decision.passed).toBe(false);
    expect(decision.killedBy).toBe('too_old');
  });

  it('kills promotional listings', () => {
    const decision = gateFor(event({ title: 'Bose Promo Code: 40% Off for August 2026' }));
    expect(decision.killedBy).toBe('noise_title');
  });

  it('kills personal GitHub activity with no release artifact', () => {
    const decision = gateFor(
      event({
        title: 'simonw commented on an issue in sqlite-utils',
        artifacts: EMPTY_ARTIFACTS,
        evidence: [evidence('gh-user-simonw', 'EARLY_SIGNAL')],
      }),
      ['gh-user-simonw'],
    );
    expect(decision.killedBy).toBe('activity_noise');
  });

  it('does NOT kill a release from the same activity feed', () => {
    const decision = gateFor(
      event({
        title: 'simonw pushed sqlite-utils v3.38.0',
        artifacts: extractArtifacts('sqlite-utils v3.38.0', 'sqlite-utils v3.38.0'),
        evidence: [evidence('gh-user-simonw', 'EARLY_SIGNAL')],
      }),
      ['gh-user-simonw'],
    );
    expect(decision.killedBy).not.toBe('activity_noise');
  });

  it('kills an uncorroborated arXiv paper', () => {
    // SOURCE-INTELLIGENCE.md §2 states the rule directly. 344 items in one pull would
    // otherwise dominate ingestion and burn the budget on papers that never become
    // content.
    const decision = gateFor(
      event({
        title: 'Retrieval-Augmented Generation with Confidence-Aware Reranking',
        entities: [],
        artifacts: EMPTY_ARTIFACTS,
        evidence: [evidence('arxiv-cs-ai', 'TECHNICAL_RESEARCHER')],
      }),
      ['arxiv-cs-ai'],
    );
    expect(decision.passed).toBe(false);
  });

  it('passes an arXiv paper once something else picks it up', () => {
    const decision = gateFor(
      event({
        title: 'A paper about claude-opus-5 that Hacker News noticed',
        evidence: [
          evidence('arxiv-cs-ai', 'TECHNICAL_RESEARCHER'),
          evidence('hn-frontpage', 'COMMUNITY_SIGNAL'),
          evidence('anthropic-news-diff', 'OFFICIAL_SOURCE'),
        ],
      }),
      ['arxiv-cs-ai', 'hn-frontpage', 'anthropic-news-diff'],
    );
    expect(decision.killedBy).not.toBe('arxiv_uncorroborated');
  });

  it('kills a single-source event with nothing specific in it', () => {
    const decision = gateFor(
      event({
        title: 'Some thoughts on the industry',
        artifacts: EMPTY_ARTIFACTS,
        evidence: [evidence('techcrunch', 'JOURNALIST')],
      }),
      ['techcrunch'],
    );
    expect(decision.killedBy).toBe('uncorroborated_and_unspecific');
  });

  it('always explains itself, whether it passed or killed', () => {
    for (const target of [event(), event({ title: 'Promo Codes for August 2026' })]) {
      expect(gateFor(target).reason.length).toBeGreaterThan(20);
    }
  });

  it('summarises a batch into a kill rate', () => {
    const decisions = [
      gateFor(
        event({
          evidence: [
            evidence('anthropic-news-diff', 'OFFICIAL_SOURCE'),
            evidence('techcrunch', 'JOURNALIST'),
          ],
        }),
      ),
      gateFor(event({ title: '50% Off promo codes' })),
      gateFor(event({ title: '20% Off deals' })),
    ];

    const stats = summariseGate(decisions);
    expect(stats.total).toBe(3);
    expect(stats.killed).toBe(2);
    expect(stats.killRate).toBeCloseTo(2 / 3);
    expect(stats.byRule.noise_title).toBe(2);
  });

  it('handles an empty batch', () => {
    expect(summariseGate([]).killRate).toBe(0);
  });
});

describe('combined score', () => {
  it('sorts a well-sourced smaller story above a high-importance rumour', () => {
    // The T-2 failure in ranking form. Confidence multiplies rather than adds
    // precisely so importance cannot outvote sourcing.
    const rumour = scoreEvent(
      event({
        title: 'Rumour: Anthropic to release claude-opus-6 imminently',
        evidence: [evidence('reddit-localllama', 'COMMUNITY_SIGNAL')],
      }),
      relevanceContext,
      NOW,
    );
    const solid = scoreEvent(
      event({
        title: 'Anthropic ships claude-opus-5',
        evidence: [
          evidence('anthropic-news-diff', 'OFFICIAL_SOURCE'),
          evidence('techcrunch', 'JOURNALIST'),
        ],
      }),
      relevanceContext,
      NOW,
    );

    expect(rumour.confidence.level).toBe('LOW');
    expect(solid.combined).toBeGreaterThan(rumour.combined);
  });

  it('keeps the two axes separately visible', () => {
    // ROADMAP.md §7: merging them "hides the second". The combined value exists only
    // for ordering, and both components stay readable.
    const scores = scoreEvent(event(), relevanceContext, NOW);
    expect(scores.importance.value).toBeGreaterThan(0);
    expect(scores.brandRelevance.value).toBeGreaterThan(0);
    expect(scores.combined).toBeGreaterThan(0);
  });
});
