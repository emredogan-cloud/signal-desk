import {
  placeOnLifecycle,
  STAGE_DECISION,
  type LifecycleResult,
  type TrendObservation,
  type TrendStage,
} from './lifecycle.js';

/**
 * The trend card. `ROADMAP.md` Phase 9:
 *
 * > "`trends` table and the full trend card: name, platform, first observed, growth,
 * > maturity, mechanism, how to participate, original version, creator adaptation,
 * > risk, decision"
 *
 * ## Which fields the machine can fill, and which it cannot
 *
 * This split is the honest part of the module, and it is why the type separates them:
 *
 * | Field                | Source  | Why                                                |
 * |----------------------|---------|----------------------------------------------------|
 * | name, platform       | Human   | The machine cannot see TikTok or X formats         |
 * | mechanism            | Human   | Why a format works is a judgement, not a count     |
 * | howToParticipate     | Human   | Requires knowing the format from the inside        |
 * | originalVersion      | Human   | Provenance is research, not detection              |
 * | firstObserved        | Either  | Manual entry or the first automated sighting       |
 * | growth, maturity     | Machine | A trajectory over a series — what machines are for |
 * | saturation           | Machine | Same                                                |
 * | creatorAdaptation    | Machine | Derived from stage + the operator's own position   |
 * | risk                 | Machine | Derived from stage and saturation                  |
 * | decision             | Machine | The stage matrix, fixed by the roadmap             |
 *
 * A card with human fields empty is still a valid card — it just says less. What it
 * must never do is *invent* the human fields, because a fabricated mechanism ("this
 * format works because it triggers curiosity") reads exactly like a real one.
 */

export const TREND_PLATFORMS = [
  'x',
  'tiktok',
  'instagram',
  'youtube',
  'hn',
  'reddit',
  'github',
  'lobsters',
  'other',
] as const;
export type TrendPlatform = (typeof TREND_PLATFORMS)[number];

/** What only a human can supply. An empty card is honest, not degraded. */
export type TrendHumanFields = {
  readonly name: string;
  readonly platform: TrendPlatform;
  /**
   * Why the format works. A judgement, never inferred.
   *
   * `string | undefined` rather than `?: string`, because under
   * `exactOptionalPropertyTypes` those differ: an explicit `undefined` — which is
   * exactly what a CLI flag that was not passed produces — is not assignable to an
   * optional property. Making absence representable is the point.
   */
  readonly mechanism: string | undefined;
  readonly howToParticipate: string | undefined;
  /** Where it started, if known. */
  readonly originalVersion: string | undefined;
};

export type TrendCard = {
  readonly name: string;
  readonly platform: TrendPlatform;
  readonly firstObserved: Date;
  readonly lastObserved: Date;
  readonly observationCount: number;
  /** True when a human entered this rather than the automated signal finding it. */
  readonly humanObserved: boolean;

  readonly mechanism: string | undefined;
  readonly howToParticipate: string | undefined;
  readonly originalVersion: string | undefined;

  readonly lifecycle: LifecycleResult;
  /** How the operator specifically should adapt it, given the stage. */
  readonly creatorAdaptation: string;
  readonly risk: string;

  /**
   * Fields the machine could not fill.
   *
   * Listed explicitly rather than left as silent `undefined`, so the operator can see
   * what the card is missing instead of assuming it is complete.
   */
  readonly missing: readonly string[];
};

const ADAPTATION: Record<TrendStage, string> = {
  UNKNOWN: 'Record more observations before adapting anything. One sighting is an anecdote.',
  EMERGING:
    'Participate directly and early, in his own voice. At this stage the format itself is the differentiation, so a straight execution is enough — he does not need a clever twist yet.',
  ACCELERATING:
    'Do it with the technical angle nobody else has. The obvious executions are being posted right now; his version has to carry something only someone who builds would notice.',
  MAINSTREAM:
    'Only worth doing if he can invert it or show where it breaks. A straight execution now reads as following rather than leading.',
  SATURATED:
    'Skip it. If he genuinely has something new, the format is no longer the vehicle for it — write the thing directly instead.',
  DECLINING:
    'Skip it. A post-mortem of why it faded is more interesting than a late entry, if he cares enough to write one.',
};

const RISK: Record<TrendStage, string> = {
  UNKNOWN: 'Low risk, low information. Acting on an unplaced trend is acting on a guess.',
  EMERGING:
    'Moderate. Early formats sometimes do not go anywhere, so the cost of a miss is one post that reads as odd in hindsight.',
  ACCELERATING:
    'Low if the angle is genuinely his; moderate if not. A me-too post at this stage is visible precisely because so many others are posting.',
  MAINSTREAM:
    'Moderate. Participating without a distinct perspective is the clearest signal of following rather than leading.',
  SATURATED:
    'High. Late participation in an exhausted format is the most legible form of being behind, and it is the kind of post people remember.',
  DECLINING: 'High, and for no upside. The audience has already moved on.',
};

/**
 * Build a card from what is known.
 *
 * Human fields are copied verbatim when present and left `undefined` when absent —
 * never guessed. `missing` names each gap so an incomplete card cannot be mistaken
 * for a complete one.
 */
export function buildTrendCard(
  human: TrendHumanFields,
  observations: readonly TrendObservation[],
  now: Date,
): TrendCard {
  const sorted = [...observations].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  const lifecycle = placeOnLifecycle(sorted, now);

  const missing: string[] = [];
  if (human.mechanism === undefined)
    missing.push('mechanism — why the format works (human judgement)');
  if (human.howToParticipate === undefined)
    missing.push('howToParticipate — requires knowing the format from the inside');
  if (human.originalVersion === undefined)
    missing.push('originalVersion — provenance is research, not detection');
  if (sorted.length < 3)
    missing.push(
      `observation history — ${String(sorted.length)} of the 3 needed to place a trajectory`,
    );

  return {
    name: human.name,
    platform: human.platform,
    firstObserved: sorted[0]?.observedAt ?? now,
    lastObserved: sorted[sorted.length - 1]?.observedAt ?? now,
    observationCount: sorted.length,
    humanObserved: sorted.some((observation) => observation.manual),

    mechanism: human.mechanism,
    howToParticipate: human.howToParticipate,
    originalVersion: human.originalVersion,

    lifecycle,
    creatorAdaptation: ADAPTATION[lifecycle.stage],
    risk: RISK[lifecycle.stage],
    missing,
  };
}

/** The decision, restated at the card level for callers that want only that. */
export function trendDecision(card: TrendCard): string {
  return `${STAGE_DECISION[card.lifecycle.stage]} — ${card.lifecycle.explanation}`;
}
