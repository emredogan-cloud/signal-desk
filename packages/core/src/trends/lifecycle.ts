/**
 * Trend lifecycle. `ROADMAP.md` Phase 9.
 *
 * ## The honest scoping, restated because it governs the whole module
 *
 * > "Without paid social data, automated cross-platform trend detection is weak.
 * > Formats on X, TikTok, and Instagram are largely invisible to free feeds. The
 * > realistic design is **human-observed, machine-tracked**: the operator enters a
 * > trend he has seen; the system tracks its trajectory, scores saturation, generates
 * > a differentiated angle, and tells him when the window has closed. Claiming
 * > automated cross-platform trend detection would be the kind of overclaim this whole
 * > system is built to avoid."
 *
 * So **manual entry is a first-class feature, not a fallback**, and the module is
 * designed around a trend whose existence a human asserted. What the machine adds is
 * the part humans are bad at: tracking a trajectory over weeks, noticing saturation
 * before it is obvious, and saying plainly when the window has closed.
 *
 * The automated signal exists and is deliberately narrow — repetition of a technical
 * format across HN, Reddit, Lobsters, and GitHub. It will not see a video format on
 * TikTok, and the acceptance criterion says so: if automated detection surfaces
 * nothing over a month, "that is documented as a limitation rather than papered over".
 */

export const TREND_STAGES = [
  'UNKNOWN',
  'EMERGING',
  'ACCELERATING',
  'MAINSTREAM',
  'SATURATED',
  'DECLINING',
] as const;
export type TrendStage = (typeof TREND_STAGES)[number];

export const TREND_DECISIONS = ['ACT', 'DIFFERENTIATE', 'ONLY_IF_UNIQUE', 'IGNORE'] as const;
export type TrendDecision = (typeof TREND_DECISIONS)[number];

/**
 * The recommendation matrix. `ROADMAP.md` Phase 9 states it directly:
 *
 * > "emerging → act; accelerating → differentiated angle; mainstream → only with a
 * > strong unique perspective; saturated → ignore; declining → ignore"
 *
 * `UNKNOWN` is not in the roadmap's list because it is not a real stage — it is the
 * state of a trend with too little history to place. It maps to IGNORE, which is the
 * conservative reading: acting on something the system cannot characterise is acting
 * on a guess.
 */
export const STAGE_DECISION: Record<TrendStage, TrendDecision> = {
  UNKNOWN: 'IGNORE',
  EMERGING: 'ACT',
  ACCELERATING: 'DIFFERENTIATE',
  MAINSTREAM: 'ONLY_IF_UNIQUE',
  SATURATED: 'IGNORE',
  DECLINING: 'IGNORE',
};

export const STAGE_RATIONALE: Record<TrendStage, string> = {
  UNKNOWN:
    'not enough observation history to place this on the lifecycle — acting now would be acting on a guess',
  EMERGING: 'few people are doing this yet, so being early is itself the differentiation',
  ACCELERATING:
    'adoption is climbing and the obvious takes are being made now — a distinct angle is required, not just participation',
  MAINSTREAM:
    'everyone with an interest has seen it; only a genuinely unique perspective adds anything',
  SATURATED: 'the format is exhausted and participating now reads as late rather than informed',
  DECLINING: 'interest is falling; the window has closed',
};

/**
 * One observation of a trend at a point in time.
 *
 * The series is the data. A single observation cannot place a trend on the lifecycle —
 * "growing" and "declining" are statements about a sequence, and a system that
 * inferred them from one data point would be guessing.
 */
export type TrendObservation = {
  readonly observedAt: Date;
  /** How many distinct places it was seen. Manual or automated. */
  readonly mentionCount: number;
  /** How many distinct sources/communities. Breadth matters more than volume. */
  readonly distinctSources: number;
  /** True when the operator entered this by hand. */
  readonly manual: boolean;
  readonly note: string;
};

export type LifecycleResult = {
  readonly stage: TrendStage;
  readonly decision: TrendDecision;
  /** Why this stage. Rendered — an unexplainable stage is not actionable. */
  readonly explanation: string;
  /** 0..1. How exhausted the format is. */
  readonly saturation: number;
  /** True when there is too little history to be confident. */
  readonly provisional: boolean;
};

/** Observations needed before a stage is more than a guess. */
export const MIN_OBSERVATIONS_FOR_STAGE = 3;

/** Days after which a trend with no new observations is considered to be declining. */
export const STALE_AFTER_DAYS = 14;

/**
 * Place a trend on the lifecycle.
 *
 * `ROADMAP.md` Phase 9 acceptance: "Lifecycle stage transitions are **explainable**."
 * So every branch returns the numbers it decided on, not just a label.
 */
export function placeOnLifecycle(
  observations: readonly TrendObservation[],
  now: Date,
): LifecycleResult {
  const sorted = [...observations].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());

  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  if (first === undefined || last === undefined) {
    return {
      stage: 'UNKNOWN',
      decision: STAGE_DECISION.UNKNOWN,
      explanation: 'no observations recorded — nothing to place',
      saturation: 0,
      provisional: true,
    };
  }

  const daysSinceLast = (now.getTime() - last.observedAt.getTime()) / 86_400_000;
  const daysTracked = (last.observedAt.getTime() - first.observedAt.getTime()) / 86_400_000;

  // ─── Declining beats everything.
  //
  // Checked first because a trend that has gone quiet is the one case where the shape
  // of the earlier curve does not matter. Something that was accelerating three weeks
  // ago and has not been seen since is not accelerating.
  if (daysSinceLast > STALE_AFTER_DAYS) {
    return {
      stage: 'DECLINING',
      decision: STAGE_DECISION.DECLINING,
      explanation: `last observed ${daysSinceLast.toFixed(0)} days ago, past the ${String(STALE_AFTER_DAYS)}-day staleness window — ${STAGE_RATIONALE.DECLINING}`,
      saturation: 0.9,
      provisional: false,
    };
  }

  // ─── Too little history to characterise a trajectory.
  if (sorted.length < MIN_OBSERVATIONS_FOR_STAGE) {
    return {
      stage: 'UNKNOWN',
      decision: STAGE_DECISION.UNKNOWN,
      explanation: `${String(sorted.length)} observation(s) — a trajectory needs at least ${String(MIN_OBSERVATIONS_FOR_STAGE)}; "growing" and "declining" are statements about a sequence`,
      saturation: 0,
      provisional: true,
    };
  }

  // ─── Growth: compare the recent half against the earlier half.
  //
  // Halves rather than first-versus-last, because a single spike in either position
  // would otherwise decide the stage on its own.
  const midpoint = Math.floor(sorted.length / 2);
  const earlier = sorted.slice(0, midpoint);
  const recent = sorted.slice(midpoint);

  const mean = (
    list: readonly TrendObservation[],
    pick: (o: TrendObservation) => number,
  ): number => (list.length === 0 ? 0 : list.reduce((sum, o) => sum + pick(o), 0) / list.length);

  const earlyMentions = mean(earlier, (o) => o.mentionCount);
  const recentMentions = mean(recent, (o) => o.mentionCount);
  const growth =
    earlyMentions === 0
      ? recentMentions > 0
        ? 1
        : 0
      : (recentMentions - earlyMentions) / earlyMentions;

  // ─── Recent momentum: is it still moving NOW?
  //
  // Distinct from `growth`, and a test forced the distinction. A format that ramped
  // hard and then plateaued still shows strong overall growth, because the early half
  // contains the ramp — so a plainly saturated curve (40, 70, 72, 68, 65) reported
  // +24% growth and was placed MAINSTREAM instead of SATURATED.
  //
  // Overall growth answers "how far has it come since we started watching". Momentum
  // answers "is it still climbing", which is the question saturation turns on. The
  // last two observations against the two before them is the shortest window that is
  // not a single point.
  const tail = sorted.slice(-2);
  const preTail = sorted.slice(-4, -2);
  const tailMentions = mean(tail, (o) => o.mentionCount);
  const preTailMentions = mean(preTail.length > 0 ? preTail : earlier, (o) => o.mentionCount);
  const momentum =
    preTailMentions === 0
      ? tailMentions > 0
        ? 1
        : 0
      : (tailMentions - preTailMentions) / preTailMentions;

  const peakBreadth = Math.max(...sorted.map((o) => o.distinctSources));
  const recentBreadth = mean(recent, (o) => o.distinctSources);

  // ─── Saturation.
  //
  // Breadth, not volume. A format discussed loudly in one community is not saturated;
  // one that has reached every community is, however quietly. Falling breadth after a
  // wide peak is the clearest saturation signal available without paid social data.
  const breadthSaturation = Math.min(1, peakBreadth / 8);
  const decayFromPeak =
    peakBreadth === 0 ? 0 : Math.max(0, (peakBreadth - recentBreadth) / peakBreadth);
  const saturation = Math.min(1, breadthSaturation * 0.6 + decayFromPeak * 0.4);

  const detail = `${sorted.length} observations over ${daysTracked.toFixed(0)} days; mentions ${earlyMentions.toFixed(1)} → ${recentMentions.toFixed(1)} (${growth >= 0 ? '+' : ''}${(growth * 100).toFixed(0)}% overall, ${momentum >= 0 ? '+' : ''}${(momentum * 100).toFixed(0)}% recent), breadth peaked at ${String(peakBreadth)} source(s), now ${recentBreadth.toFixed(1)}`;

  // ─── SATURATED. Wide reach AND no longer moving.
  //
  // Gated on MOMENTUM rather than overall growth — see the note above.
  if (saturation >= 0.7 && momentum <= 0.1) {
    return {
      stage: 'SATURATED',
      decision: STAGE_DECISION.SATURATED,
      explanation: `${detail} — reach is wide and it has stopped climbing, so ${STAGE_RATIONALE.SATURATED}`,
      saturation,
      provisional: false,
    };
  }

  // ─── MAINSTREAM. Wide reach, still growing a little.
  if (peakBreadth >= 5) {
    return {
      stage: 'MAINSTREAM',
      decision: STAGE_DECISION.MAINSTREAM,
      explanation: `${detail} — it has reached ${String(peakBreadth)} distinct sources, so ${STAGE_RATIONALE.MAINSTREAM}`,
      saturation,
      provisional: false,
    };
  }

  // ─── ACCELERATING. Growing fast, not yet everywhere.
  if (growth >= 0.5) {
    return {
      stage: 'ACCELERATING',
      decision: STAGE_DECISION.ACCELERATING,
      explanation: `${detail} — climbing quickly, so ${STAGE_RATIONALE.ACCELERATING}`,
      saturation,
      provisional: false,
    };
  }

  // ─── EMERGING. Present, narrow, not yet moving fast.
  if (growth >= 0) {
    return {
      stage: 'EMERGING',
      decision: STAGE_DECISION.EMERGING,
      explanation: `${detail} — still narrow, so ${STAGE_RATIONALE.EMERGING}`,
      saturation,
      provisional: sorted.length < MIN_OBSERVATIONS_FOR_STAGE + 2,
    };
  }

  // ─── Falling while still being observed.
  return {
    stage: 'DECLINING',
    decision: STAGE_DECISION.DECLINING,
    explanation: `${detail} — mentions are falling, so ${STAGE_RATIONALE.DECLINING}`,
    saturation,
    provisional: false,
  };
}
