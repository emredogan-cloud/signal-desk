import type { ConfidenceLevel } from '@signal-desk/shared';
import { analysisSchema, triageSchema, type Analysis, type TriageResult } from './schema.js';
import type { RecommendedAction } from './schema.js';

/**
 * Validation of model output. **The security boundary on the way back.**
 *
 * The envelope defends the way in; this defends the way out. Structured outputs make
 * a malformed shape unlikely, but "unlikely" is not a control — and the rules that
 * actually matter are semantic, which JSON Schema cannot express:
 *
 * - **`THREAT-MODEL.md` §5 test 6:** "An analysis containing a number with no evidence
 *   id fails validation."
 * - **§5 test 7:** "An event whose evidence is entirely unofficial can never be
 *   emitted with `confidence = HIGH` or with a recommendation other than
 *   WAIT/VERIFY."
 *
 * Both are enforced here, in code, over the model's output — not requested politely
 * in the prompt. A prompt is a suggestion to a model that an attacker may be
 * steering; this function is not.
 */

export class ProvenanceError extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
    this.name = 'ProvenanceError';
  }
}

/**
 * Digits that carry a factual claim.
 *
 * Deliberately narrow. Matching every digit would flag "one of the two options" and
 * make the check unusable, so it looks for numbers in the shapes that assert
 * something: quantities, percentages, prices, versions, multipliers, token counts.
 *
 * Ordinary prose numbers ("the first", "a second reason") are words, not digits, and
 * do not match. The check is deliberately biased toward false positives over false
 * negatives — a wrongly-flagged sentence costs one analysis; an unsourced benchmark
 * that reaches the operator's audience costs his credibility, which is the asset
 * `THREAT-MODEL.md` §A1 exists to protect.
 */
const FACTUAL_NUMBER =
  // Measurement-SHAPED numbers only. A bare single digit does not qualify, and that
  // exclusion was forced by real output: "Claude Opus 5" tripped the check, because
  // the 5 in a product name is not a measurement and there is nothing to source. The
  // same applies to "GPT-4", "v2", "Gemini 3".
  //
  // Something counts as a factual number when it is multi-digit, decimal, separated,
  // or carries a unit — the shapes an assertion about magnitude actually takes:
  //   94.2%   1M tokens   $5   40%   128000   2.5x   300ms
  /\$\s?\d[\d,._]*|\b\d[\d,._]*\s*(?:%|x\b|k\b|m\b|bn?\b|tokens?\b|ms\b|gb\b|tb\b)|\b\d[\d,._]*[.,]\d+|\b\d{2,}\b/i;

/** Text that is safely numeric without asserting a measurement. */
const NUMERIC_EXEMPT: readonly RegExp[] = [
  /^\s*$/,
  // A bare year in a date-like context is a timestamp, not a claim about magnitude.
  /^(?:[^\d]*\b(?:19|20)\d{2}\b[^\d]*)$/,
];

export function containsFactualNumber(text: string): boolean {
  if (NUMERIC_EXEMPT.some((pattern) => pattern.test(text))) return false;
  return FACTUAL_NUMBER.test(text);
}

export type ValidationContext = {
  /** Evidence ids the model was actually shown. Citing anything else is a failure. */
  readonly allowedEvidenceIds: ReadonlySet<string>;
  /** True when at least one evidence item came from an OFFICIAL_SOURCE. */
  readonly hasOfficialSource: boolean;
};

export function validateTriage(raw: unknown): TriageResult {
  const parsed = triageSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProvenanceError('triage output did not match the schema', parsed.error.message);
  }
  return parsed.data;
}

/**
 * Validate an analysis, then apply the caps that the model does not get to override.
 *
 * Order matters: shape, then provenance, then caps. Provenance failures **throw** —
 * an analysis with an unsourced number is discarded, not repaired, because repairing
 * it means deciding which evidence supports a claim the model could not attribute.
 * Confidence violations are **capped rather than thrown**, because the analysis text
 * is still useful; only the certainty attached to it was wrong.
 */
export function validateAnalysis(raw: unknown, context: ValidationContext): Analysis {
  const parsed = analysisSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProvenanceError('analysis output did not match the schema', parsed.error.message);
  }
  const analysis = parsed.data;

  // ─── Every cited evidence id must be one we actually showed the model.
  //
  // A hallucinated or injected id would render as a citation the operator could click
  // and could not verify — worse than no citation at all, because it looks checked.
  for (const claim of analysis.claims) {
    for (const id of claim.evidenceIds) {
      if (!context.allowedEvidenceIds.has(id)) {
        throw new ProvenanceError(
          'analysis cited an evidence id that was not provided',
          `claim "${claim.text.slice(0, 80)}" cites "${id}", which is not among the ${String(context.allowedEvidenceIds.size)} ids supplied`,
        );
      }
    }
  }

  // ─── THREAT-MODEL §5 test 6: a number in the prose with no claim behind it.
  //
  // The narrative fields are where an unsourced figure does damage, because they are
  // what gets read and quoted. A number there must also appear in a claim.
  const narrative = [analysis.whatHappened, analysis.whatChanged, analysis.before, analysis.after];
  const claimText = analysis.claims.map((claim) => claim.text).join(' ');

  for (const field of narrative) {
    if (!containsFactualNumber(field)) continue;
    const numbers = field.match(new RegExp(FACTUAL_NUMBER, 'gi')) ?? [];
    for (const number of numbers) {
      const trimmed = number.trim();
      if (trimmed.length === 0) continue;
      if (!claimText.includes(trimmed)) {
        throw new ProvenanceError(
          'analysis states a number that no sourced claim supports',
          `"${trimmed}" appears in the narrative but in no claim with an evidence id (THREAT-MODEL §5 test 6)`,
        );
      }
    }
  }

  // ─── THREAT-MODEL §5 test 7 / §T-2 mitigation 4: the rumour cap.
  //
  // Applied AFTER the model has spoken and regardless of what it said. The model may
  // be reading an injected document that insists it is authoritative; this rule does
  // not consult the document.
  const capped = applyOutputCaps(analysis, context);
  return capped;
}

const ALLOWED_WHEN_LOW: readonly RecommendedAction[] = ['WAIT', 'VERIFY', 'IGNORE'];

/**
 * Force confidence and recommendation into what the evidence can support.
 *
 * Exported and tested directly. Like the scorer's `applyCaps`, it only ever lowers,
 * and the property is asserted rather than assumed.
 */
export function applyOutputCaps(analysis: Analysis, context: ValidationContext): Analysis {
  let confidence: ConfidenceLevel = analysis.confidence;
  let recommendedAction: RecommendedAction = analysis.recommendedAction;

  if (!context.hasOfficialSource) {
    // No official source → LOW, whatever the model concluded.
    confidence = 'LOW';
  }

  if (confidence === 'LOW' && !ALLOWED_WHEN_LOW.includes(recommendedAction)) {
    recommendedAction = 'VERIFY';
  }

  // Injection-flagged content cannot carry a publish recommendation. §T-1 mitigation 6
  // keeps the item visible rather than dropping it, so the recommendation carries the
  // doubt instead.
  if (analysis.injectionObserved) {
    confidence = 'LOW';
    if (!ALLOWED_WHEN_LOW.includes(recommendedAction)) recommendedAction = 'VERIFY';
  }

  if (confidence === analysis.confidence && recommendedAction === analysis.recommendedAction) {
    return analysis;
  }
  return { ...analysis, confidence, recommendedAction };
}
