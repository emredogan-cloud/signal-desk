import type { ConfidenceLevel } from '@signal-desk/shared';
import { findAngles, type Angle, type AngleInput } from './angles.js';
import { applyForcingRules, type ForcingInput, type ForcingResult } from './forcing.js';

/**
 * The five options, the decisive recommendation, and the DON'T POST path.
 *
 * `ROADMAP.md` Phase 7: "For each high-priority event, produce the five options —
 * quote / reply / original / educational / wait — plus the one decisive
 * recommendation and its reasoning." And the WHY: "Analysis without a recommended
 * action leaves the hardest judgment to the operator at exactly the moment he is
 * short of time."
 *
 * ## The acceptance criterion that shapes everything here
 *
 * > "**≥30% of scored events over a representative week receive DON'T POST or WAIT** —
 * > a system that recommends action on everything has no judgment."
 *
 * So DON'T POST is not an error path. It is the expected outcome for most events, and
 * it comes with a specific reason from a closed list rather than a shrug. An event
 * with no applicable angle, or one an expert already covered, is one the operator
 * genuinely should skip — and saying so is the product.
 */

export const OPTION_KINDS = ['quote', 'reply', 'original', 'educational', 'wait'] as const;
export type OptionKind = (typeof OPTION_KINDS)[number];

export const DONT_POST_REASONS = [
  'saturated',
  'no_unique_angle',
  'weak_evidence',
  'better_explained_elsewhere',
  'low_authority_gain',
  'reputational_risk',
  'insufficient_information',
] as const;
export type DontPostReason = (typeof DONT_POST_REASONS)[number];

export type ContentOption = {
  readonly kind: OptionKind;
  /** 0..1. How good this option is for THIS event. */
  readonly fit: number;
  /** What he would actually do. Never generic. */
  readonly approach: string;
  /** Why this option, for this event. */
  readonly rationale: string;
  /** The angle this option leans on, when it leans on one. */
  readonly angle: AngleKind | undefined;
};

type AngleKind = Angle['kind'];

/**
 * The panel. `ROADMAP.md` Phase 7 names all four fields.
 *
 * These are the questions that decide whether a post is worth making, and asking them
 * explicitly is what separates a recommendation from an impulse.
 */
export type DecisionPanel = {
  /** Why now rather than tomorrow, or never. */
  readonly whyNow: string;
  /** Why him rather than anyone else. */
  readonly whyMe: string;
  /** What he adds that is not already published. */
  readonly whatCanIAdd: string;
  /** What good it does — honestly, including "probably not much". */
  readonly expectedOutcome: string;
};

export type Recommendation = {
  readonly action: 'POST_NOW' | 'POST_SOON' | 'WAIT' | 'VERIFY' | 'DONT_POST';
  readonly option: OptionKind | undefined;
  readonly confidence: ConfidenceLevel;
  readonly reasoning: string;
  /** Present only when the action is DONT_POST. */
  readonly dontPostReason: DontPostReason | undefined;
  /** True when a forcing rule escalated this for explicit human review. */
  readonly manualFlag: boolean;
  readonly forcing: ForcingResult;
};

export type StrategyInput = AngleInput &
  ForcingInput & {
    readonly eventId: number;
    readonly importance: number;
    readonly brandRelevance: number;
    readonly combined: number;
    readonly confidence: ConfidenceLevel;
    readonly hoursSinceEvent: number;
    /** From the Phase 6 analysis. Empty when none exists. */
    readonly doNotSay: readonly string[];
  };

export type Strategy = {
  readonly eventId: number;
  readonly angles: readonly Angle[];
  readonly options: readonly ContentOption[];
  readonly panel: DecisionPanel;
  readonly recommendation: Recommendation;
  readonly doNotSay: readonly string[];
};

/** Hours within which "be early" still means something. GUESS, like the score weights. */
export const EARLY_WINDOW_HOURS = 6;

function buildOptions(input: StrategyInput, angles: readonly Angle[]): ContentOption[] {
  const best = angles[0];
  const options: ContentOption[] = [];

  // ─── QUOTE. Amplify with a take. Cheapest to produce, weakest by itself.
  options.push({
    kind: 'quote',
    // Quoting is only worth it when he has something to add AND the story is fresh —
    // a quote-tweet of a two-day-old announcement is noise with his name on it.
    fit:
      best === undefined
        ? 0.15
        : Math.min(0.85, best.strength * (input.hoursSinceEvent <= EARLY_WINDOW_HOURS ? 1 : 0.5)),
    approach:
      best === undefined
        ? `Quote the announcement with a one-line observation. He has no distinctive angle here, so this is amplification with a byline.`
        : `Quote it and lead with the ${best.kind.replace(/_/g, ' ')}: ${best.prompt}`,
    rationale:
      best === undefined
        ? 'no angle applies, so a quote adds his name but not his expertise'
        : `${best.rationale}, and a quote puts that in front of people already reading about it`,
    angle: best?.kind,
  });

  // ─── REPLY. Enters an existing conversation.
  options.push({
    kind: 'reply',
    // Worth more when experts are already discussing it — that is where the
    // conversation is — but worth much less if he has nothing specific to say.
    fit:
      best === undefined
        ? 0.1
        : Math.min(0.7, best.strength * (input.expertSourceCount > 0 ? 0.9 : 0.5)),
    approach:
      best === undefined
        ? `Skip. A reply with no specific contribution is the lowest-value thing he can post.`
        : `Reply to the strongest thread with the concrete part only: ${best.prompt}`,
    rationale:
      input.expertSourceCount > 0
        ? `${String(input.expertSourceCount)} expert source(s) are already discussing it, so the conversation exists and a specific contribution lands in it`
        : 'there is no established conversation to join yet, which limits what a reply can reach',
    angle: best?.kind,
  });

  // ─── ORIGINAL. His own post. The highest-value and highest-cost option.
  const testableBonus = input.testable ? 0.15 : 0;
  options.push({
    kind: 'original',
    fit: best === undefined ? 0.1 : Math.min(1, best.strength + testableBonus),
    approach:
      best === undefined
        ? `Skip. An original post needs something to say that is not already said.`
        : `Write it as an original post: ${best.prompt}`,
    rationale: input.testable
      ? 'he can test this himself, which is the difference between a post worth reading and a summary of the press release'
      : best === undefined
        ? 'nothing here is his to say'
        : `${best.rationale} — strong enough to carry a post of its own`,
    angle: best?.kind,
  });

  // ─── EDUCATIONAL. Teaches something reusable. Outlives the news.
  const teachable = angles.find((angle) =>
    [
      'technical_explanation',
      'cost_implication',
      'benchmark_interpretation',
      'myth_correction',
    ].includes(angle.kind),
  );
  options.push({
    kind: 'educational',
    // Educational content is less time-sensitive by nature, so staleness costs it
    // much less than it costs a quote.
    fit: teachable === undefined ? 0.1 : Math.min(0.9, teachable.strength * 0.95),
    approach:
      teachable === undefined
        ? `Skip. Nothing here generalises past the news itself.`
        : `Teach the general lesson, using this as the example: ${teachable.prompt}`,
    rationale:
      teachable === undefined
        ? 'this event does not illustrate anything reusable'
        : 'the specific event dates quickly; the technique it illustrates does not, which is what makes this worth more than a news post',
    angle: teachable?.kind,
  });

  // ─── WAIT. Always available, and frequently correct.
  options.push({
    kind: 'wait',
    fit: input.confidence === 'LOW' ? 0.9 : input.stillUnknown.length > 2 ? 0.6 : 0.2,
    approach:
      input.stillUnknown.length > 0
        ? `Wait for: ${input.stillUnknown.slice(0, 3).join('; ')}`
        : `Wait for independent confirmation or a second source.`,
    rationale:
      input.confidence === 'LOW'
        ? 'the evidence does not currently support a confident statement, and being wrong publicly costs more than being late'
        : `${String(input.stillUnknown.length)} open question(s) remain that would change what he would say`,
    angle: undefined,
  });

  // ─── Confidence discounts every PUBLISHING option, not just the recommendation.
  //
  // A test caught this: at LOW confidence, `original` still ranked above `wait`,
  // because option fit measured how well the option suited the event and ignored
  // whether the evidence could support saying anything at all. Showing "write an
  // original post" as the best-fitting option for evidence the system will then
  // refuse to stand behind is incoherent — the fit of every publishing option is
  // bounded by how much the evidence supports publishing.
  //
  // `wait` is deliberately exempt: waiting gets *better* as confidence falls.
  const confidenceFactor =
    input.confidence === 'HIGH' ? 1 : input.confidence === 'MED' ? 0.75 : 0.4;

  return options
    .map((option) =>
      option.kind === 'wait' ? option : { ...option, fit: option.fit * confidenceFactor },
    )
    .sort((a, b) => b.fit - a.fit);
}

function buildPanel(input: StrategyInput, best: Angle | undefined): DecisionPanel {
  const fresh = input.hoursSinceEvent <= EARLY_WINDOW_HOURS;

  return {
    whyNow: fresh
      ? `${input.hoursSinceEvent.toFixed(1)}h old — inside the window where being early still counts for something.`
      : input.hoursSinceEvent <= 48
        ? `${input.hoursSinceEvent.toFixed(1)}h old — the first wave of coverage has happened, so speed is no longer the advantage; the angle has to be.`
        : `${input.hoursSinceEvent.toFixed(1)}h old — no timeliness advantage remains. Post this only if the angle stands on its own.`,

    whyMe: input.testable
      ? `He can run this himself. That is the whole answer: an operator who tested it knows something a summariser does not.`
      : input.entities.length > 0
        ? `It touches ${input.entities.slice(0, 3).join(', ')}, which he works with — but he cannot test this one directly, so the claim to authority is weaker.`
        : `No strong claim. He has no particular standing on this, which is a reason to skip it rather than a problem to write around.`,

    whatCanIAdd:
      best === undefined
        ? `Nothing identified. No angle applies, which usually means the announcement already says everything he would say.`
        : `${best.prompt}`,

    expectedOutcome:
      best === undefined
        ? `Little. Posting without an angle spends attention he will want later.`
        : input.expertSourceCount > 0
          ? `Modest. ${String(input.expertSourceCount)} expert source(s) already cover this, so the marginal reader is someone who has not seen their version — a smaller audience than it looks.`
          : input.testable && best.strength > 0.7
            ? `Good. Untouched by the experts so far, directly testable, and specific enough to be quotable.`
            : `Moderate. Worth doing if it is quick; not worth reordering the day for.`,
  };
}

/**
 * Decide. One recommendation, with reasoning.
 *
 * Order is deliberate and mirrors the rest of the system: **forcing rules first**,
 * then the DON'T POST checks, then the positive recommendation. A forcing rule that
 * ran after the positive decision could be argued with; running it first means there
 * is nothing to argue with.
 */
function decide(
  input: StrategyInput,
  angles: readonly Angle[],
  options: readonly ContentOption[],
  forcing: ForcingResult,
): Recommendation {
  const best = angles[0];
  const bestOption = options.find((option) => option.kind !== 'wait');

  // ─── 1. Forcing rules. Unbypassable.
  if (forcing.forced) {
    return {
      action: forcing.rule === 'accusation' ? 'VERIFY' : 'WAIT',
      option: 'wait',
      confidence: 'LOW',
      reasoning: forcing.reason,
      dontPostReason: undefined,
      manualFlag: forcing.manualFlag,
      forcing,
    };
  }

  // ─── 2. DON'T POST, with a specific reason from the closed list.
  const dontPost = (reason: DontPostReason, why: string): Recommendation => ({
    action: 'DONT_POST',
    option: undefined,
    confidence: input.confidence,
    reasoning: why,
    dontPostReason: reason,
    manualFlag: false,
    forcing,
  });

  if (best === undefined) {
    return dontPost(
      'no_unique_angle',
      'no expert angle applies to this event — nothing here is his to add, and posting anyway is amplification with a byline',
    );
  }

  if (input.expertSourceCount >= 3) {
    return dontPost(
      'saturated',
      `${String(input.expertSourceCount)} expert sources already cover this; the obvious angles are taken and a fourth voice adds noise rather than signal`,
    );
  }

  if (input.expertSourceCount >= 1 && best.strength < 0.5) {
    return dontPost(
      'better_explained_elsewhere',
      `an expert has already covered this and the strongest remaining angle is weak (${best.strength.toFixed(2)}) — a duplicate of someone else's better version`,
    );
  }

  if (input.confidence === 'LOW') {
    return dontPost(
      'weak_evidence',
      'the evidence cannot support a confident public statement; the Phase 5 caps already record why',
    );
  }

  if (input.stillUnknown.length >= 4) {
    return dontPost(
      'insufficient_information',
      `${String(input.stillUnknown.length)} material questions are open — enough that what he wrote today would likely need correcting`,
    );
  }

  if (input.brandRelevance < 30) {
    return dontPost(
      'low_authority_gain',
      `brand relevance is ${String(input.brandRelevance)} — this is far enough from what he is known for that posting it builds no authority`,
    );
  }

  if (input.doNotSay.length >= 5) {
    return dontPost(
      'reputational_risk',
      `${String(input.doNotSay.length)} distinct things must not be said about this event — a topic with that many traps is one to write about slowly or not at all`,
    );
  }

  // ─── 3. A positive recommendation.
  if (bestOption === undefined) {
    return dontPost('no_unique_angle', 'no publishable option was generated for this event');
  }

  const fresh = input.hoursSinceEvent <= EARLY_WINDOW_HOURS;
  const strong = bestOption.fit >= 0.6 && input.combined >= 50;

  return {
    action: strong && fresh ? 'POST_NOW' : 'POST_SOON',
    option: bestOption.kind,
    confidence: input.confidence,
    reasoning: `${bestOption.kind}: ${bestOption.rationale}. ${
      fresh
        ? `Still inside the ${String(EARLY_WINDOW_HOURS)}h early window.`
        : `Past the early window at ${input.hoursSinceEvent.toFixed(1)}h, so the angle carries it rather than the timing.`
    }`,
    dontPostReason: undefined,
    manualFlag: false,
    forcing,
  };
}

export function buildStrategy(input: StrategyInput): Strategy {
  const angles = findAngles(input);
  const options = buildOptions(input, angles);
  const forcing = applyForcingRules(input);
  const panel = buildPanel(input, angles[0]);
  const recommendation = decide(input, angles, options, forcing);

  return {
    eventId: input.eventId,
    angles,
    options,
    panel,
    recommendation,
    doNotSay: input.doNotSay,
  };
}

export type StrategyStats = {
  readonly total: number;
  readonly byAction: Record<string, number>;
  readonly byDontPostReason: Record<string, number>;
  /** The acceptance criterion: DON'T POST + WAIT + VERIFY as a share of the whole. */
  readonly restraintRate: number;
  readonly manualFlags: number;
};

export function summariseStrategies(strategies: readonly Strategy[]): StrategyStats {
  const byAction: Record<string, number> = {};
  const byDontPostReason: Record<string, number> = {};
  let restrained = 0;
  let manualFlags = 0;

  for (const strategy of strategies) {
    const { action, dontPostReason, manualFlag } = strategy.recommendation;
    byAction[action] = (byAction[action] ?? 0) + 1;
    if (dontPostReason !== undefined) {
      byDontPostReason[dontPostReason] = (byDontPostReason[dontPostReason] ?? 0) + 1;
    }
    if (action === 'DONT_POST' || action === 'WAIT' || action === 'VERIFY') restrained += 1;
    if (manualFlag) manualFlags += 1;
  }

  return {
    total: strategies.length,
    byAction,
    byDontPostReason,
    restraintRate: strategies.length === 0 ? 0 : restrained / strategies.length,
    manualFlags,
  };
}
