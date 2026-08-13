import type { ScorableEvent, EventScores } from '../score/types.js';
import { scoreEvent } from '../score/index.js';
import { applyGate } from '../score/gate.js';
import type { RelevanceContext } from '../score/relevance.js';

/**
 * Offline weight refitting. `ROADMAP.md` Phase 12.
 *
 * > "**Offline weight refitting** over immutable `raw_items` — replay three months of
 * > history under candidate weights at zero API cost and compare which events would
 * > have surfaced."
 *
 * ## Why this is possible at all
 *
 * Because two decisions made in Phase 3 and Phase 5 were made for this:
 *
 *   1. `raw_items` is **append-only and immutable**. Whatever the pipeline did to a
 *      document later, the document as fetched is still there.
 *   2. `scoreEvent` and `applyGate` are **pure functions taking `now` as a parameter**
 *      rather than reading the clock. A replay therefore reproduces exactly what the
 *      live run computed, rather than re-scoring history against today's date.
 *
 * Neither cost anything at the time. Both are what make a $0 refit possible instead of
 * a three-month wait, and the second is the one that is easy to get wrong: a scorer
 * calling `Date.now()` internally would make every replay meaningless while looking
 * like it worked.
 *
 * ## What a replay can and cannot tell you
 *
 * It answers "which events would have surfaced under these weights". It does **not**
 * answer "were those the right events" — that needs outcomes, and outcomes need posts,
 * and posts need the operator. A replay narrows the candidate weights; only measured
 * results choose between them.
 */

export type WeightOverride = {
  readonly name: string;
  /** Applied to the computed score for one axis. 1.0 leaves it unchanged. */
  readonly importanceMultiplier: number;
  readonly relevanceMultiplier: number;
  /** Gate floor override. Undefined keeps the shipped constant. */
  readonly minCombined: number | undefined;
  readonly maxAgeDays: number | undefined;
};

export const BASELINE: WeightOverride = {
  name: 'shipped',
  importanceMultiplier: 1,
  relevanceMultiplier: 1,
  minCombined: undefined,
  maxAgeDays: undefined,
};

export type ReplayEvent = {
  readonly event: ScorableEvent;
  /** The instant the live run scored it. Replaying against `new Date()` would be wrong. */
  readonly scoredAt: Date;
  readonly sourceIds: readonly string[];
};

export type ReplayResult = {
  readonly candidate: string;
  readonly total: number;
  readonly passed: number;
  readonly killRate: number;
  /** Event ids that passed the gate under this candidate. */
  readonly passedIds: readonly number[];
  readonly byKillRule: Record<string, number>;
};

/**
 * Replay a corpus under one candidate.
 *
 * Deterministic: the same corpus and the same candidate always produce the same
 * result, because `scoredAt` comes from the stored row rather than from the clock.
 * `ROADMAP.md` Phase 12 TESTS require exactly this ("Replay determinism").
 */
export function replay(
  corpus: readonly ReplayEvent[],
  context: RelevanceContext,
  candidate: WeightOverride,
): ReplayResult {
  const passedIds: number[] = [];
  const byKillRule: Record<string, number> = {};

  for (const entry of corpus) {
    const base = scoreEvent(entry.event, context, entry.scoredAt);

    // Multipliers are applied to the computed axis scores rather than to the
    // constants, so a candidate can be evaluated without rebuilding the module. That
    // is a coarser knob than refitting individual component weights — and the honest
    // framing is that this explores the SHAPE of the weighting, not its detail.
    const adjusted: EventScores = {
      ...base,
      importance: {
        ...base.importance,
        value: clampScore(base.importance.value * candidate.importanceMultiplier),
      },
      brandRelevance: {
        ...base.brandRelevance,
        value: clampScore(base.brandRelevance.value * candidate.relevanceMultiplier),
      },
      combined: clampScore(
        base.importance.value * candidate.importanceMultiplier * 0.55 +
          base.brandRelevance.value * candidate.relevanceMultiplier * 0.45,
      ),
    };

    const decision = applyGate(entry.event, adjusted, {
      sourceIds: entry.sourceIds,
      now: entry.scoredAt,
    });

    // A candidate that raises the floor is simulated by re-checking it here, because
    // `applyGate` reads the shipped constant. Explicit rather than clever: a candidate
    // that silently failed to apply would look like "no difference".
    const belowCandidateFloor =
      candidate.minCombined !== undefined && adjusted.combined < candidate.minCombined;

    const tooOldForCandidate =
      candidate.maxAgeDays !== undefined &&
      (entry.scoredAt.getTime() - entry.event.eventOccurredAt.getTime()) / 86_400_000 >
        candidate.maxAgeDays;

    if (decision.passed && !belowCandidateFloor && !tooOldForCandidate) {
      passedIds.push(entry.event.id);
      continue;
    }

    const rule = belowCandidateFloor
      ? 'candidate_min_combined'
      : tooOldForCandidate
        ? 'candidate_max_age'
        : (decision.killedBy ?? 'unknown');
    byKillRule[rule] = (byKillRule[rule] ?? 0) + 1;
  }

  return {
    candidate: candidate.name,
    total: corpus.length,
    passed: passedIds.length,
    killRate: corpus.length === 0 ? 0 : (corpus.length - passedIds.length) / corpus.length,
    passedIds,
    byKillRule,
  };
}

function clampScore(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.round(Math.max(0, Math.min(100, value)));
}

export type ReplayComparison = {
  readonly baseline: ReplayResult;
  readonly candidate: ReplayResult;
  /** Events the candidate surfaces that the baseline did not. */
  readonly newlySurfaced: readonly number[];
  /** Events the baseline surfaced that the candidate drops. */
  readonly noLongerSurfaced: readonly number[];
  readonly agreement: number;
};

/**
 * Compare two replays.
 *
 * The interesting output is the **disagreement**, not the totals. Two candidates that
 * pass the same count while surfacing different events are not equivalent, and a
 * comparison reporting only kill rates would call them identical.
 */
export function compareReplays(baseline: ReplayResult, candidate: ReplayResult): ReplayComparison {
  const baseSet = new Set(baseline.passedIds);
  const candSet = new Set(candidate.passedIds);

  const newlySurfaced = candidate.passedIds.filter((id) => !baseSet.has(id));
  const noLongerSurfaced = baseline.passedIds.filter((id) => !candSet.has(id));

  const union = new Set([...baseSet, ...candSet]);
  const intersection = [...baseSet].filter((id) => candSet.has(id)).length;

  return {
    baseline,
    candidate,
    newlySurfaced,
    noLongerSurfaced,
    agreement: union.size === 0 ? 1 : intersection / union.size,
  };
}

// ─────────────────────────────────────────────────────────────────────
// The four dimensions — brief §40, ROADMAP.md Phase 12
// ─────────────────────────────────────────────────────────────────────

/**
 * > "Four tracked dimensions kept separate (brief §40): **visibility**, **authority**,
 * > **audience**, **content quality**"
 *
 * Acceptance: "reported separately, **never merged into one number**."
 *
 * The separation is the point. A single "engagement score" is exactly the metric that
 * rewards low-quality virality — a post that goes wide and teaches nothing scores the
 * same as one that earns a reply from someone worth hearing from. Merging them is how
 * an authority-building system quietly becomes an engagement-farming one.
 *
 * The type therefore has **no** combined field, and no function here produces one.
 */
export type Dimensions = {
  /** How many people saw it. The easiest to move and the least meaningful. */
  readonly visibility: { impressions: number; reposts: number };
  /** Who engaged, weighted by whether they are worth hearing from. */
  readonly authority: {
    highSignalReplies: number;
    mentionsByRespected: number;
    conversationDepth: number;
  };
  /** Whether it brought the right people. */
  readonly audience: { follows: number; profileVisits: number };
  /** Whether it was any good, independent of who saw it. */
  readonly quality: { savedOrBookmarked: number; repliesAsking: number };
};

export type ViralityVerdict = {
  readonly kind: 'authority_growth' | 'low_quality_virality' | 'quiet' | 'mixed';
  readonly explanation: string;
};

/**
 * Classify a post's outcome. **Reported explicitly**, per the roadmap.
 *
 * "Low-quality virality" is the failure this whole system is meant to avoid, and it
 * looks like success on every dashboard that reports one number: high impressions,
 * high reposts, and nobody worth hearing from in the replies.
 */
export function classifyOutcome(dimensions: Dimensions): ViralityVerdict {
  const { visibility, authority, audience } = dimensions;

  const wide = visibility.impressions > 10_000 || visibility.reposts > 50;
  const authoritative =
    authority.highSignalReplies > 0 ||
    authority.mentionsByRespected > 0 ||
    authority.conversationDepth >= 3;
  const grew = audience.follows > 0;

  if (wide && !authoritative) {
    return {
      kind: 'low_quality_virality',
      explanation: `${String(visibility.impressions)} impressions and ${String(visibility.reposts)} reposts, but no reply from anyone the registry rates as high-signal and no conversation deeper than ${String(authority.conversationDepth)} turns. This looks like success on an engagement dashboard and built no authority.`,
    };
  }

  if (authoritative && grew) {
    return {
      kind: 'authority_growth',
      explanation: `${String(authority.highSignalReplies)} high-signal reply/replies, ${String(authority.mentionsByRespected)} mention(s) by respected accounts, and ${String(audience.follows)} new follower(s). Reach was ${String(visibility.impressions)} impressions — which is the least interesting number here.`,
    };
  }

  if (authoritative) {
    return {
      kind: 'mixed',
      explanation:
        'The right people engaged but the audience did not grow. Worth repeating the substance; the distribution is what did not work.',
    };
  }

  return {
    kind: 'quiet',
    explanation: `${String(visibility.impressions)} impressions, no high-signal engagement, no growth. Nothing happened — which is the most common outcome and not a failure.`,
  };
}
