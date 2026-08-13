import type {
  ConfidenceLevel,
  EventCategory,
  EvidenceTag,
  SourceCategory,
} from '@signal-desk/shared';
import type { Artifacts } from '../normalize/artifacts.js';

/**
 * Scoring inputs and outputs.
 *
 * The output shape is the whole point of this phase. `ROADMAP.md` Phase 5:
 *
 *   "**Score explanation**: every score returns its component breakdown, stored and
 *    rendered … an operator who cannot see why something scored 82 will not trust
 *    the number."
 *
 * So a score is never a bare number. It is a number plus the components that
 * produced it, each with its own value, weight, and a sentence a human can read.
 */

/** One contribution to a score. */
export type ScoreComponent = {
  readonly name: string;
  /** 0..1 before weighting. */
  readonly value: number;
  readonly weight: number;
  /** `value * weight`, on the same 0..1 scale as the total. */
  readonly contribution: number;
  /** Why this value. Rendered next to the number in the dashboard. */
  readonly explanation: string;
};

/** A score, 0..100, with everything needed to defend it. */
export type Score = {
  /** 0..100, rounded. */
  readonly value: number;
  readonly components: readonly ScoreComponent[];
};

export type ConfidenceResult = {
  readonly level: ConfidenceLevel;
  /** The strongest tag this evidence can support. */
  readonly tag: EvidenceTag;
  readonly components: readonly ScoreComponent[];
  /**
   * Caps that were applied, in order.
   *
   * Non-empty means a rule overrode the computed value. Rendered, because a capped
   * confidence is more informative than an uncapped one — it says *why* the system
   * will not stand behind the claim.
   */
  readonly caps: readonly string[];
};

/** Everything the scorers need about one piece of evidence. */
export type EvidenceInput = {
  readonly sourceId: string;
  readonly sourceCategory: SourceCategory;
  readonly isOfficial: boolean;
  readonly reliability: number;
  /** When this particular evidence was published. */
  readonly publishedAt: Date;
};

/** Everything the scorers need about an event. No database, no network. */
export type ScorableEvent = {
  readonly id: number;
  readonly title: string;
  readonly summary: string;
  readonly category: EventCategory;
  readonly entities: readonly string[];
  readonly artifacts: Artifacts;
  readonly eventOccurredAt: Date;
  readonly occurredAtIsEstimated: boolean;
  readonly firstSeenAt: Date;
  readonly evidence: readonly EvidenceInput[];
  /** True when any evidence carried an injection signal. */
  readonly injectionFlagged: boolean;
};

export type EventScores = {
  readonly importance: Score;
  readonly brandRelevance: Score;
  readonly velocity: Score;
  readonly confidence: ConfidenceResult;
  /**
   * The single number the gate and the dashboard sort by.
   *
   * `ROADMAP.md` §7 keeps importance and brand relevance deliberately independent,
   * "because 'important' and 'important *for me*' are different questions and merging
   * them hides the second". This combined value exists **only** for ordering and
   * gating; both components remain separately visible everywhere they are shown.
   */
  readonly combined: number;
  /** Reproducibility marker. Two runs of the same code on the same event must match. */
  readonly scoredWith: string;
};

/** Bumped whenever a weight or formula changes, so stored scores stay comparable. */
export const SCORER_VERSION = 'phase5-2026-08-13';

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function toScore(components: readonly ScoreComponent[]): Score {
  const total = components.reduce((sum, component) => sum + component.contribution, 0);
  return { value: Math.round(clamp01(total) * 100), components };
}

export function component(
  name: string,
  value: number,
  weight: number,
  explanation: string,
): ScoreComponent {
  const bounded = clamp01(value);
  return {
    name,
    value: bounded,
    weight,
    contribution: bounded * weight,
    explanation,
  };
}
