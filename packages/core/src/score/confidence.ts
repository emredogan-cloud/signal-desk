import type { ConfidenceLevel, EvidenceTag } from '@signal-desk/shared';
import {
  CONFIDENCE_BY_SOURCE_CATEGORY,
  CONFIDENCE_HIGH_THRESHOLD,
  CONFIDENCE_MED_THRESHOLD,
  HIGH_CONFIDENCE_MIN_SOURCES,
} from './weights.js';
import { component, clamp01, type ConfidenceResult, type ScorableEvent } from './types.js';

/**
 * Confidence — **computed, then capped by rule.**
 *
 * The caps are the point of this module, and they are not tunable weights. They come
 * straight from the threat model and they are what stands between this system and
 * the failure it exists to prevent:
 *
 * `THREAT-MODEL.md` §T-2 mitigation 4:
 *   "Events whose evidence is entirely non-official are hard-capped at
 *    `confidence = LOW`, forced to `SPECULATIVE`, and their recommended action is
 *    biased toward WAIT / VERIFY regardless of importance score."
 *
 * `THREAT-MODEL.md` §T-1 mitigation 7, the two-source rule:
 *   "A single unofficial source can never produce a VERIFIED claim, no matter what it
 *    says about itself."
 *
 * `ROADMAP.md` §5:
 *   "An event whose evidence is entirely unofficial cannot be emitted at
 *    `confidence = HIGH` — enforced in code, tested in `THREAT-MODEL.md` §5 test 7."
 *
 * ## Why caps rather than weights
 *
 * A weight can be outvoted. Six enthusiastic comment threads carry more *weighted*
 * confidence than one quiet official post, and a purely additive model would let
 * volume manufacture certainty — which is precisely how a rumour launders itself into
 * fact through repetition (§T-2, "rumour laundered into fact through repetition
 * across low-tier sources").
 *
 * A cap cannot be outvoted. No amount of corroboration from unofficial sources
 * produces HIGH, because the rule is applied *after* the arithmetic and only ever
 * lowers. `applyCaps` is monotonically non-increasing by construction, and that
 * property is tested directly.
 */

const LEVEL_ORDER: readonly ConfidenceLevel[] = ['LOW', 'MED', 'HIGH'];
const TAG_ORDER: readonly EvidenceTag[] = ['SPECULATIVE', 'INFERRED', 'OBSERVED', 'VERIFIED'];

function lower(a: ConfidenceLevel, b: ConfidenceLevel): ConfidenceLevel {
  return LEVEL_ORDER.indexOf(a) <= LEVEL_ORDER.indexOf(b) ? a : b;
}

function lowerTag(a: EvidenceTag, b: EvidenceTag): EvidenceTag {
  return TAG_ORDER.indexOf(a) <= TAG_ORDER.indexOf(b) ? a : b;
}

export function scoreConfidence(event: ScorableEvent): ConfidenceResult {
  const distinctSources = new Set(event.evidence.map((item) => item.sourceId));
  const officialEvidence = event.evidence.filter((item) => item.isOfficial);
  const hasOfficial = officialEvidence.length > 0;

  // The strongest evidence category present, not the average — same reasoning as
  // importance: an official post plus five comment threads is as authoritative as
  // the official post.
  const bestCategoryScore = event.evidence.reduce(
    (best, item) => Math.max(best, CONFIDENCE_BY_SOURCE_CATEGORY[item.sourceCategory]),
    0,
  );

  const corroborationScore = clamp01(distinctSources.size / HIGH_CONFIDENCE_MIN_SOURCES);

  const components = [
    component(
      'bestSourceCategory',
      bestCategoryScore,
      0.65,
      hasOfficial
        ? `backed by an official source (${officialEvidence.map((e) => e.sourceId).join(', ')})`
        : 'no official source among the evidence',
    ),
    component(
      'corroboration',
      corroborationScore,
      0.35,
      `${String(distinctSources.size)} distinct source(s)`,
    ),
  ];

  const raw = components.reduce((sum, item) => sum + item.contribution, 0);

  const computedLevel: ConfidenceLevel =
    raw >= CONFIDENCE_HIGH_THRESHOLD ? 'HIGH' : raw >= CONFIDENCE_MED_THRESHOLD ? 'MED' : 'LOW';
  const computedTag: EvidenceTag = hasOfficial
    ? 'VERIFIED'
    : distinctSources.size >= 2
      ? 'OBSERVED'
      : 'INFERRED';

  const capped = applyCaps(
    { level: computedLevel, tag: computedTag },
    {
      hasOfficial,
      distinctSourceCount: distinctSources.size,
      injectionFlagged: event.injectionFlagged,
      occurredAtIsEstimated: event.occurredAtIsEstimated,
    },
  );

  return { level: capped.level, tag: capped.tag, components, caps: capped.caps };
}

export type CapInputs = {
  readonly hasOfficial: boolean;
  readonly distinctSourceCount: number;
  readonly injectionFlagged: boolean;
  readonly occurredAtIsEstimated: boolean;
};

/**
 * Apply every cap. **Only ever lowers.**
 *
 * Exported and tested directly, because "provably cannot be bypassed" is one of this
 * phase's acceptance criteria and the proof is a property test over this function:
 * for every input, the output level and tag are ≤ the input's.
 */
export function applyCaps(
  computed: { level: ConfidenceLevel; tag: EvidenceTag },
  inputs: CapInputs,
): { level: ConfidenceLevel; tag: EvidenceTag; caps: string[] } {
  let level = computed.level;
  let tag = computed.tag;
  const caps: string[] = [];

  // CAP 1 — no official source → LOW / SPECULATIVE, whatever the arithmetic said.
  // THREAT-MODEL.md §T-2 mitigation 4. This is the rumour cap, and it is the reason
  // repetition across low-tier sources cannot manufacture certainty.
  if (!inputs.hasOfficial) {
    if (level !== 'LOW' || tag !== 'SPECULATIVE') {
      caps.push(
        'no official source among the evidence → capped at LOW / SPECULATIVE (THREAT-MODEL §T-2)',
      );
    }
    level = lower(level, 'LOW');
    tag = lowerTag(tag, 'SPECULATIVE');
  }

  // CAP 2 — the two-source rule. A single source, even an official one, is one
  // source. THREAT-MODEL.md §T-1 mitigation 7.
  if (inputs.distinctSourceCount < HIGH_CONFIDENCE_MIN_SOURCES) {
    if (level === 'HIGH') {
      caps.push(
        `only ${String(inputs.distinctSourceCount)} source → HIGH requires ${String(HIGH_CONFIDENCE_MIN_SOURCES)} (two-source rule, THREAT-MODEL §T-1)`,
      );
    }
    level = lower(level, 'MED');
  }

  // CAP 3 — injected content. §T-1 mitigation 6 keeps the item visible rather than
  // dropping it, so its confidence must carry the doubt instead.
  if (inputs.injectionFlagged) {
    if (level !== 'LOW' || tag === 'VERIFIED') {
      caps.push('injection signals detected in the evidence → capped at LOW / INFERRED');
    }
    level = lower(level, 'LOW');
    tag = lowerTag(tag, 'INFERRED');
  }

  // CAP 4 — no publisher timestamp. Nothing can be VERIFIED when the system cannot
  // establish when it happened; "stale information presented as current" is one of
  // §T-2's named contributing causes.
  if (inputs.occurredAtIsEstimated) {
    if (tag === 'VERIFIED') {
      caps.push('no publisher timestamp → cannot be VERIFIED, reduced to OBSERVED');
    }
    tag = lowerTag(tag, 'OBSERVED');
  }

  return { level, tag, caps };
}

/** Numeric confidence, for sorting and for the gate. */
export function confidenceValue(level: ConfidenceLevel): number {
  return level === 'HIGH' ? 1 : level === 'MED' ? 0.6 : 0.25;
}
