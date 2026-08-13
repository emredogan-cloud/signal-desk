import { scoreImportance, scoreVelocity } from './importance.js';
import { scoreBrandRelevance, type RelevanceContext } from './relevance.js';
import { scoreConfidence, confidenceValue } from './confidence.js';
import { SCORER_VERSION, type EventScores, type ScorableEvent } from './types.js';

export * from './types.js';
export * from './weights.js';
export * from './importance.js';
export * from './relevance.js';
export * from './confidence.js';
export * from './gate.js';

/**
 * Score an event on every axis.
 *
 * Pure and deterministic: same event, same `now`, same numbers. `now` is a parameter
 * rather than read from the clock precisely so that a replay produces the scores the
 * live run produced — Phase 12 refits weights by replaying three months of history,
 * and a scorer that read `Date.now()` internally would make that comparison
 * meaningless.
 */
export function scoreEvent(
  event: ScorableEvent,
  context: RelevanceContext,
  now: Date,
): EventScores {
  const importance = scoreImportance(event, now);
  const brandRelevance = scoreBrandRelevance(event, context);
  const velocity = scoreVelocity(event, now);
  const confidence = scoreConfidence(event);

  // The combined value exists ONLY for ordering and gating. ROADMAP.md §7 keeps the
  // two axes independent "because 'important' and 'important for me' are different
  // questions and merging them hides the second" — so both remain separately visible
  // everywhere they are rendered, and nothing downstream reads `combined` alone.
  //
  // Confidence multiplies rather than adds: a high-importance rumour must not sort
  // above a well-sourced smaller story, which is the T-2 failure in ranking form.
  const combined = Math.round(
    (importance.value * 0.55 + brandRelevance.value * 0.45) *
      (0.6 + 0.4 * confidenceValue(confidence.level)),
  );

  return {
    importance,
    brandRelevance,
    velocity,
    confidence,
    combined,
    scoredWith: SCORER_VERSION,
  };
}
