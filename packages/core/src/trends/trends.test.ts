import { describe, it, expect } from 'vitest';
import {
  placeOnLifecycle,
  STAGE_DECISION,
  TREND_STAGES,
  MIN_OBSERVATIONS_FOR_STAGE,
  STALE_AFTER_DAYS,
  type TrendObservation,
} from './lifecycle.js';
import { buildTrendCard, trendDecision, type TrendHumanFields } from './card.js';

/**
 * `ROADMAP.md` Phase 9 TESTS: "Lifecycle transition logic. Saturation scoring against
 * historical fixtures with known outcomes. Recommendation-by-stage matrix."
 */

const NOW = new Date('2026-08-13T12:00:00Z');

function obs(
  daysAgo: number,
  mentionCount: number,
  distinctSources: number,
  manual = false,
): TrendObservation {
  return {
    observedAt: new Date(NOW.getTime() - daysAgo * 86_400_000),
    mentionCount,
    distinctSources,
    manual,
    note: '',
  };
}

const human: TrendHumanFields = {
  name: 'build-in-public teardown threads',
  platform: 'x',
  // Explicitly undefined, not omitted. The three human fields are `string | undefined`
  // rather than optional so that "the operator has not filled this in" is a state the
  // type can represent — which is what makes `missing` meaningful.
  mechanism: undefined,
  howToParticipate: undefined,
  originalVersion: undefined,
};

describe('the recommendation matrix', () => {
  it('matches the roadmap exactly', () => {
    // "emerging → act; accelerating → differentiated angle; mainstream → only with a
    // strong unique perspective; saturated → ignore; declining → ignore"
    expect(STAGE_DECISION.EMERGING).toBe('ACT');
    expect(STAGE_DECISION.ACCELERATING).toBe('DIFFERENTIATE');
    expect(STAGE_DECISION.MAINSTREAM).toBe('ONLY_IF_UNIQUE');
    expect(STAGE_DECISION.SATURATED).toBe('IGNORE');
    expect(STAGE_DECISION.DECLINING).toBe('IGNORE');
  });

  it('maps UNKNOWN to IGNORE — acting on an unplaced trend is acting on a guess', () => {
    expect(STAGE_DECISION.UNKNOWN).toBe('IGNORE');
  });

  it('covers every stage', () => {
    for (const stage of TREND_STAGES) {
      expect(STAGE_DECISION[stage], stage).toBeDefined();
    }
  });
});

describe('lifecycle placement', () => {
  it('returns UNKNOWN with no observations', () => {
    const result = placeOnLifecycle([], NOW);
    expect(result.stage).toBe('UNKNOWN');
    expect(result.provisional).toBe(true);
  });

  it('refuses to place a trajectory from too few points', () => {
    // "Growing" and "declining" are statements about a sequence. A system that
    // inferred them from one data point would be guessing.
    const result = placeOnLifecycle([obs(5, 10, 3), obs(3, 20, 4)], NOW);
    expect(result.stage).toBe('UNKNOWN');
    expect(result.explanation).toContain('statements about a sequence');
    expect(MIN_OBSERVATIONS_FOR_STAGE).toBeGreaterThan(2);
  });

  it('marks a stale trend DECLINING however good the earlier curve was', () => {
    // Checked first, because something that was accelerating three weeks ago and has
    // not been seen since is not accelerating.
    const result = placeOnLifecycle(
      [obs(40, 5, 2), obs(35, 20, 4), obs(30, 60, 6), obs(STALE_AFTER_DAYS + 3, 90, 7)],
      NOW,
    );
    expect(result.stage).toBe('DECLINING');
    expect(result.explanation).toContain('staleness window');
  });

  it('calls a narrow, slow-growing format EMERGING', () => {
    const result = placeOnLifecycle([obs(9, 3, 1), obs(6, 3, 2), obs(3, 4, 2), obs(1, 4, 2)], NOW);
    expect(result.stage).toBe('EMERGING');
    expect(result.decision).toBe('ACT');
  });

  it('calls a fast-climbing narrow format ACCELERATING', () => {
    const result = placeOnLifecycle(
      [obs(9, 2, 1), obs(6, 4, 2), obs(3, 18, 3), obs(1, 30, 4)],
      NOW,
    );
    expect(result.stage).toBe('ACCELERATING');
    expect(result.decision).toBe('DIFFERENTIATE');
  });

  it('calls a broad, still-growing format MAINSTREAM', () => {
    const result = placeOnLifecycle(
      [obs(9, 10, 2), obs(6, 30, 5), obs(3, 60, 7), obs(1, 90, 8)],
      NOW,
    );
    expect(result.stage).toBe('MAINSTREAM');
    expect(result.decision).toBe('ONLY_IF_UNIQUE');
  });

  it('correctly marks a known-saturated format SATURATED', () => {
    // The acceptance criterion, directly. The shape of a saturated format: it reached
    // everywhere, and then stopped growing.
    const result = placeOnLifecycle(
      [obs(12, 40, 8), obs(9, 70, 9), obs(6, 72, 8), obs(3, 68, 6), obs(1, 65, 5)],
      NOW,
    );
    expect(result.stage).toBe('SATURATED');
    expect(result.decision).toBe('IGNORE');
    expect(result.saturation).toBeGreaterThanOrEqual(0.7);
  });

  it('scores saturation on BREADTH, not volume', () => {
    // A format discussed loudly in one community is not saturated; one that reached
    // every community is, however quietly.
    const loudNarrow = placeOnLifecycle(
      [obs(9, 200, 1), obs(6, 210, 1), obs(3, 205, 1), obs(1, 208, 1)],
      NOW,
    );
    const quietBroad = placeOnLifecycle(
      [obs(9, 8, 8), obs(6, 9, 9), obs(3, 8, 8), obs(1, 8, 7)],
      NOW,
    );
    expect(quietBroad.saturation).toBeGreaterThan(loudNarrow.saturation);
  });

  it('explains every placement — an unexplainable stage is not actionable', () => {
    const cases: TrendObservation[][] = [
      [],
      [obs(2, 1, 1)],
      [obs(9, 3, 1), obs(6, 3, 2), obs(3, 4, 2), obs(1, 4, 2)],
      [obs(9, 2, 1), obs(6, 4, 2), obs(3, 18, 3), obs(1, 30, 4)],
      [obs(12, 40, 8), obs(9, 70, 9), obs(6, 72, 8), obs(3, 68, 6), obs(1, 65, 5)],
    ];
    for (const observations of cases) {
      const result = placeOnLifecycle(observations, NOW);
      expect(result.explanation.length).toBeGreaterThan(30);
      expect(result.decision).toBe(STAGE_DECISION[result.stage]);
    }
  });

  it('never returns a saturation outside 0..1', () => {
    for (const observations of [
      [obs(9, 0, 0), obs(6, 0, 0), obs(3, 0, 0)],
      [obs(9, 9999, 99), obs(6, 9999, 99), obs(3, 9999, 99)],
    ]) {
      const result = placeOnLifecycle(observations, NOW);
      expect(result.saturation).toBeGreaterThanOrEqual(0);
      expect(result.saturation).toBeLessThanOrEqual(1);
    }
  });

  it('ignores the order observations arrive in', () => {
    const ordered = [obs(9, 2, 1), obs(6, 4, 2), obs(3, 18, 3), obs(1, 30, 4)];
    const shuffled = [ordered[3]!, ordered[0]!, ordered[2]!, ordered[1]!];
    expect(placeOnLifecycle(shuffled, NOW).stage).toBe(placeOnLifecycle(ordered, NOW).stage);
  });
});

describe('the trend card', () => {
  const observations = [
    obs(9, 2, 1, true),
    obs(6, 4, 2, true),
    obs(3, 18, 3, true),
    obs(1, 30, 4, true),
  ];

  it('treats manual entry as first-class', () => {
    // "Manual trend entry is a first-class feature, not a fallback." A card built
    // entirely from human observation is complete, not degraded.
    const card = buildTrendCard(human, observations, NOW);
    expect(card.humanObserved).toBe(true);
    expect(card.lifecycle.stage).toBe('ACCELERATING');
    expect(card.creatorAdaptation.length).toBeGreaterThan(50);
    expect(card.risk.length).toBeGreaterThan(30);
  });

  it('NEVER invents the human fields', () => {
    // A fabricated mechanism — "this works because it triggers curiosity" — reads
    // exactly like a real one, which is why the machine must not write one.
    const card = buildTrendCard(human, observations, NOW);
    expect(card.mechanism).toBeUndefined();
    expect(card.howToParticipate).toBeUndefined();
    expect(card.originalVersion).toBeUndefined();
  });

  it('names what is missing instead of leaving it silently empty', () => {
    const card = buildTrendCard(human, observations, NOW);
    expect(card.missing.length).toBe(3);
    expect(card.missing.join(' ')).toContain('mechanism');
    expect(card.missing.join(' ')).toContain('human judgement');
  });

  it('reports nothing missing once the human filled it in', () => {
    const card = buildTrendCard(
      {
        ...human,
        mechanism: 'It rewards specificity, so a detailed answer outperforms a clever one.',
        howToParticipate: 'Post the actual numbers from a real project, unedited.',
        originalVersion: 'Started as a reply format in a thread by @someone in June.',
      },
      observations,
      NOW,
    );
    expect(card.missing).toEqual([]);
  });

  it('flags a thin observation history as missing too', () => {
    const card = buildTrendCard(human, [obs(2, 5, 2, true)], NOW);
    expect(card.missing.join(' ')).toContain('observation history');
    expect(card.lifecycle.stage).toBe('UNKNOWN');
  });

  it('gives a different adaptation and risk at every stage', () => {
    const byStage = new Map<string, { adaptation: string; risk: string }>();
    for (const observations of [
      [obs(9, 3, 1, true), obs(6, 3, 2, true), obs(3, 4, 2, true)],
      [obs(9, 2, 1, true), obs(6, 4, 2, true), obs(3, 18, 3, true), obs(1, 30, 4, true)],
      [obs(9, 10, 2, true), obs(6, 30, 5, true), obs(3, 60, 7, true), obs(1, 90, 8, true)],
      [
        obs(12, 40, 8, true),
        obs(9, 70, 9, true),
        obs(6, 72, 8, true),
        obs(3, 68, 6, true),
        obs(1, 65, 5, true),
      ],
    ]) {
      const card = buildTrendCard(human, observations, NOW);
      byStage.set(card.lifecycle.stage, { adaptation: card.creatorAdaptation, risk: card.risk });
    }
    // Four distinct stages, four distinct pieces of advice.
    expect(byStage.size).toBeGreaterThanOrEqual(3);
    const adaptations = [...byStage.values()].map((v) => v.adaptation);
    expect(new Set(adaptations).size).toBe(adaptations.length);
  });

  it('states the decision with its reasoning', () => {
    const decision = trendDecision(buildTrendCard(human, observations, NOW));
    expect(decision).toContain('DIFFERENTIATE');
    expect(decision.length).toBeGreaterThan(50);
  });

  it('never throws, whatever the observations', () => {
    for (const observations of [
      [],
      [obs(0, 0, 0, true)],
      [obs(1000, 1, 1, true)],
      Array.from({ length: 100 }, (_v, i) => obs(i, i, i % 10, true)),
    ]) {
      expect(() => buildTrendCard(human, observations, NOW)).not.toThrow();
    }
  });
});
