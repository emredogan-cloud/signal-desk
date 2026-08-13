/**
 * Forcing rules. **Unbypassable by any input.**
 *
 * `ROADMAP.md` Phase 7:
 *
 * > "Forcing rules: rumour/leak → WAIT-VERIFY; accusation/attribution → WAIT-VERIFY +
 * > manual flag"
 *
 * and its test requirement: "Forcing rules cannot be bypassed by any input."
 *
 * These sit in the same family as the Phase 5 confidence caps and the Phase 6 output
 * caps, and they work the same way: **compute, then force in code.** Not in a prompt,
 * because a prompt is a suggestion to a model that a hostile document may be steering.
 * Not as a weight, because a weight can be outvoted by volume — which is precisely how
 * a rumour becomes fact through repetition (`THREAT-MODEL.md` §T-2).
 *
 * ## Why an accusation is treated more severely than a rumour
 *
 * A rumour that turns out to be false costs the operator a correction. An accusation
 * amplified without verification — "X stole Y's code", "Z's benchmark is fraudulent" —
 * can damage a third party who had no say in it, and it is the failure `§A1` cannot
 * absorb. So an accusation forces WAIT-VERIFY **and** raises a manual flag: it is not
 * merely delayed, it is escalated to a human explicitly.
 */

export const FORCED_ACTIONS = ['WAIT', 'VERIFY'] as const;

export type ForcingResult = {
  /** True when a rule fired and the recommendation was overridden. */
  readonly forced: boolean;
  /** Which rule. Machine-readable — reporting must never group on prose. */
  readonly rule:
    'rumour_or_leak' | 'accusation' | 'thin_evidence' | 'injection_flagged' | undefined;
  /** True only for accusations. Surfaces the event for explicit human review. */
  readonly manualFlag: boolean;
  readonly reason: string;
};

/**
 * Rumour and leak markers.
 *
 * Matched against the **title and summary**, which is what a publisher wrote, rather
 * than against body text where the words often appear in quotation or analysis. A
 * post analysing "the rumour mill around Gemini" is not itself a rumour.
 */
const RUMOUR_PATTERNS: readonly RegExp[] = [
  /\b(?:rumou?r(?:ed|s)?|leaked?|leak)\b/i,
  /\b(?:reportedly|allegedly|purportedly|supposedly)\b/i,
  /\b(?:sources? (?:say|claim|tell|familiar)|people familiar with)\b/i,
  /\b(?:unconfirmed|not (?:yet )?confirmed|awaiting confirmation)\b/i,
  /\b(?:said to be|believed to be|understood to be)\b/i,
  /\b(?:in talks|exploring|considering|weighing)\s+(?:a|an|to)\b/i,
  /\bmay|might|could\s+(?:soon\s+)?(?:launch|release|announce|acquire|ship)\b/i,
];

/**
 * Accusation and attribution markers.
 *
 * Deliberately broad. A false positive costs one delayed post; a false negative means
 * the system recommended amplifying an unverified accusation about a named party.
 * That asymmetry is the whole reason this list errs toward catching too much.
 */
const ACCUSATION_PATTERNS: readonly RegExp[] = [
  /\b(?:accus\w+|alleg\w+|blames?|blamed)\b/i,
  /\b(?:stole|stolen|theft|plagiaris\w+|copied without|ripped off)\b/i,
  /\b(?:fraud\w*|scam|deceptive|misleading claims?|faked?|fabricat\w+)\b/i,
  /\b(?:lawsuit|sues?|sued|suing|legal action|cease and desist|injunction)\b/i,
  /\b(?:violat\w+|breach(?:ed|es)?|infring\w+)\b.{0,40}\b(?:licen[cs]e|terms|patent|copyright|contract)\b/i,
  /\b(?:attributed? to|linked to|traced to|blamed on)\b.{0,40}\b(?:attack|breach|hack|group|actor|state)\b/i,
  /\b(?:cheat\w+|gam(?:ed|ing) the benchmark|benchmark(?:s)? (?:were|was) (?:rigged|manipulated))\b/i,
  /\b(?:misconduct|unethical|wrongdoing|cover[- ]?up)\b/i,
];

export type ForcingInput = {
  readonly title: string;
  readonly summary: string;
  readonly hasOfficialSource: boolean;
  readonly distinctSourceCount: number;
  readonly injectionFlagged: boolean;
};

/**
 * Apply every forcing rule. Order is severity-first.
 *
 * Returns the FIRST rule that fires, because they all force the same pair of actions
 * and reporting the most severe one is what the operator needs to see. `manualFlag`
 * is set only by the accusation rule.
 */
export function applyForcingRules(input: ForcingInput): ForcingResult {
  // Title and summary only — see the RUMOUR_PATTERNS note.
  const text = `${input.title}\n${input.summary}`;

  // ─── 1. Accusation. The most severe, and the only one that escalates.
  for (const pattern of ACCUSATION_PATTERNS) {
    const match = pattern.exec(text);
    if (match !== null) {
      return {
        forced: true,
        rule: 'accusation',
        manualFlag: true,
        reason: `contains an accusation or attribution ("${match[0]}") — forced to WAIT/VERIFY and flagged for explicit human review; amplifying an unverified accusation can damage a third party who had no say in it`,
      };
    }
  }

  // ─── 2. Injection-flagged content.
  //
  // §T-1 mitigation 6 keeps a suspected injection visible rather than dropping it, so
  // the recommendation is where the doubt has to live. Recommending that the operator
  // post about a document that tried to manipulate the system would be absurd.
  if (input.injectionFlagged) {
    return {
      forced: true,
      rule: 'injection_flagged',
      manualFlag: false,
      reason:
        'injection signals were detected in this event’s evidence — forced to WAIT/VERIFY; the content is kept and visible, but nothing derived from it is recommended for publication',
    };
  }

  // ─── 3. Rumour or leak.
  for (const pattern of RUMOUR_PATTERNS) {
    const match = pattern.exec(text);
    if (match !== null) {
      return {
        forced: true,
        rule: 'rumour_or_leak',
        manualFlag: false,
        reason: `reads as a rumour or leak ("${match[0]}") — forced to WAIT/VERIFY; being early on something false costs more than being late on something true`,
      };
    }
  }

  // ─── 4. Thin evidence.
  //
  // Not named in the roadmap's forcing list, but it follows from the same principle
  // that §T-1 mitigation 7 and §T-2 mitigation 4 already encode elsewhere: a single
  // unofficial source cannot support a claim. Phase 5 caps its confidence and Phase 6
  // caps its recommendation; leaving the strategy layer free to recommend posting it
  // anyway would be a hole between two closed doors.
  if (!input.hasOfficialSource && input.distinctSourceCount < 2) {
    return {
      forced: true,
      rule: 'thin_evidence',
      manualFlag: false,
      reason: `a single unofficial source and no official confirmation — forced to WAIT/VERIFY (the two-source rule, THREAT-MODEL §T-1 mitigation 7)`,
    };
  }

  return {
    forced: false,
    rule: undefined,
    manualFlag: false,
    reason: 'no forcing rule applies',
  };
}
