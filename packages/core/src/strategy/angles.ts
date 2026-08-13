import type { EventCategory } from '@signal-desk/shared';

/**
 * The expert-angle engine. `ROADMAP.md` Phase 7, from brief §26.
 *
 * Eight angles: technical explanation, comparison, previous-version diff, benchmark
 * interpretation, cost implication, second-order effect, myth correction, skepticism.
 *
 * ## Why angles rather than "write a post about this"
 *
 * `ROADMAP.md` §7 frames the operator's question as "can he add something not already
 * said". An angle is the shape of that addition. Naming the shape first makes the
 * DON'T POST path possible: an event with no applicable angle is one he has nothing
 * to add to, and that is a *result*, not a failure to think of something.
 *
 * ## Deterministic, no model
 *
 * Angle applicability is decided by rules over the event and its analysis. That keeps
 * it explainable — the operator sees which angle fired and why — and it means the
 * whole strategy layer runs at zero marginal cost over events that already paid for
 * analysis.
 */

export const ANGLE_KINDS = [
  'technical_explanation',
  'comparison',
  'version_diff',
  'benchmark_interpretation',
  'cost_implication',
  'second_order_effect',
  'myth_correction',
  'skepticism',
] as const;
export type AngleKind = (typeof ANGLE_KINDS)[number];

export type Angle = {
  readonly kind: AngleKind;
  /** 0..1. How well this angle fits THIS event. */
  readonly strength: number;
  /** What the operator would actually write. Specific to the event, never generic. */
  readonly prompt: string;
  /** Why this angle applies here. Rendered next to it. */
  readonly rationale: string;
};

export type AngleInput = {
  readonly title: string;
  readonly summary: string;
  readonly category: EventCategory;
  readonly entities: readonly string[];
  /** True when the operator can run it himself — from the Phase 5 relevance scorer. */
  readonly testable: boolean;
  readonly hasVersionArtifact: boolean;
  readonly hasOfficialSource: boolean;
  readonly distinctSourceCount: number;
  readonly expertSourceCount: number;
  /** From the Phase 6 analysis, when one exists. */
  readonly stillUnknown: readonly string[];
  readonly whatChanged: string;
};

/** Terms that make a given angle applicable. Each is a claim about the event's shape. */
const SIGNALS: Record<AngleKind, RegExp> = {
  technical_explanation:
    /\b(?:how it works|architecture|implementation|under the hood|mechanism|algorithm|protocol|api|sdk|runtime)\b/i,
  comparison:
    /\b(?:versus|vs\.?|compared to|competitor|alternative|rival|outperform\w*|beats?|matches)\b/i,
  version_diff: /\b(?:v?\d+\.\d+|version|release|update|upgrade|changelog|migration|breaking)\b/i,
  benchmark_interpretation:
    /\b(?:benchmark|score[sd]?|eval|evaluation|sota|state[- ]of[- ]the[- ]art|leaderboard|accuracy|pass@)\b/i,
  cost_implication:
    /\b(?:price|pricing|cost|per million|per token|free tier|rate limit|quota|billing|\$)\b/i,
  second_order_effect:
    /\b(?:deprecat\w+|end[- ]of[- ]life|sunset|migration|breaking change|licen[cs]e|terms|policy)\b/i,
  myth_correction:
    /\b(?:actually|contrary to|misconception|myth|commonly believed|not what|clarif\w+|correction)\b/i,
  skepticism:
    /\b(?:claims?|reportedly|allegedly|according to|unconfirmed|rumou?r|leak|sources say|we believe)\b/i,
};

/**
 * Which angles apply, strongest first.
 *
 * Returns an empty array when nothing fits. That is the honest answer for most
 * events, and the DON'T POST path depends on it being reachable.
 */
export function findAngles(input: AngleInput): Angle[] {
  const text = `${input.title}\n${input.summary}\n${input.whatChanged}`;
  const angles: Angle[] = [];

  const push = (kind: AngleKind, strength: number, prompt: string, rationale: string): void => {
    if (strength <= 0) return;
    angles.push({ kind, strength: Math.min(1, strength), prompt, rationale });
  };

  const matches = (kind: AngleKind): boolean => SIGNALS[kind].test(text);
  const subject = input.title.slice(0, 90);

  // ─── Technical explanation. The operator's strongest position, but only when he
  // can actually run the thing — otherwise it is a summary of someone else's post.
  if (input.testable && (matches('technical_explanation') || input.hasVersionArtifact)) {
    push(
      'technical_explanation',
      input.testable ? 0.9 : 0.4,
      `Run it and explain what actually happens: "${subject}". Show the call, the output, and the part that surprised you.`,
      'he can test this directly, and a walkthrough from someone who ran it beats a summary of the announcement',
    );
  }

  // ─── Comparison. Needs two things to compare, which usually means an artifact.
  if (matches('comparison') && input.hasVersionArtifact) {
    push(
      'comparison',
      0.7,
      `Compare "${subject}" against what he already uses, on a task he actually runs — not on the vendor's benchmark.`,
      'a like-for-like comparison on his own workload is something the announcement cannot provide',
    );
  }

  // ─── Version diff. The most reliably useful angle for a release.
  if (input.hasVersionArtifact && matches('version_diff')) {
    push(
      'version_diff',
      0.75,
      `What changed between the previous version and this one, in behaviour rather than in release notes: "${subject}".`,
      'release notes describe intent; a diff of observed behaviour describes reality',
    );
  }

  // ─── Benchmark interpretation. Higher value when the methodology is missing,
  // because that gap IS the contribution.
  if (matches('benchmark_interpretation')) {
    const gapNoted = input.stillUnknown.some((item) => /method|how|measur|detail/i.test(item));
    push(
      'benchmark_interpretation',
      gapNoted ? 0.8 : 0.55,
      gapNoted
        ? `Explain what the benchmark in "${subject}" does and does not measure — the methodology is not stated, and that is the story.`
        : `Explain what the benchmark in "${subject}" actually measures, and what it would take for the number to matter to a working developer.`,
      gapNoted
        ? 'the evidence itself records the methodology as unknown — pointing that out is a real contribution'
        : 'benchmark numbers travel further than their caveats do',
    );
  }

  // ─── Cost implication. Concrete, checkable, and useful to everyone.
  if (matches('cost_implication')) {
    push(
      'cost_implication',
      0.85,
      `Work out what "${subject}" costs on a real workload of his — actual numbers from an actual project, not the price-per-token table.`,
      'pricing pages state a rate; what it costs to run a real thing is a different and more useful number',
    );
  }

  // ─── Second-order effect. The angle least likely to be duplicated.
  if (matches('second_order_effect')) {
    push(
      'second_order_effect',
      0.8,
      `What follows from "${subject}" that is not in the announcement — who has to change what, and by when.`,
      'the first-order news is covered everywhere within an hour; the consequence is not',
    );
  }

  // ─── Myth correction. Only when there is a correction to make.
  if (matches('myth_correction')) {
    push(
      'myth_correction',
      0.7,
      `Correct what is being said about "${subject}" — state the widely-repeated claim, then what the evidence actually shows.`,
      'a correction is high-value and high-risk; it requires being right, which is why it must cite evidence',
    );
  }

  // ─── Skepticism. Rises sharply when the sourcing is thin.
  const thinlySourced = !input.hasOfficialSource || input.distinctSourceCount < 2;
  if (matches('skepticism') || thinlySourced) {
    push(
      'skepticism',
      thinlySourced ? 0.75 : 0.5,
      `Ask what would have to be true for "${subject}" to hold up — and say plainly what the evidence does not establish.`,
      thinlySourced
        ? 'the evidence is thin, and saying so early is worth more than being first to repeat it'
        : 'the claim invites scrutiny that the coverage is not applying',
    );
  }

  // ─── Crowding penalty.
  //
  // SOURCE-INTELLIGENCE.md §3: if an expert has already published the experiment,
  // "the operator's angle must be different, not duplicative". Applied uniformly
  // because crowding reduces the value of every angle, not of any particular one.
  const crowding = Math.min(0.6, input.expertSourceCount * 0.2);
  const adjusted = angles.map((angle) => ({
    ...angle,
    strength: angle.strength * (1 - crowding),
  }));

  return adjusted.sort((a, b) => b.strength - a.strength);
}
