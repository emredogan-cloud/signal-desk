import {
  GATE_MIN_COMBINED_SCORE,
  GATE_MIN_IMPORTANCE,
  GATE_MAX_AGE_DAYS,
  GATE_REQUIRE_CORROBORATION_OR_ARTIFACT,
  CORROBORATION_REQUIRED_SOURCES,
  NOISE_TITLE_PATTERNS,
  OFF_TOPIC_CATEGORIES,
  ACTIVITY_ONLY_SOURCES,
  ACTIVITY_NOISE_PATTERNS,
} from './weights.js';
import type { EventScores, ScorableEvent } from './types.js';

/**
 * The rule gate — **the cost-control mechanism for the entire system.**
 *
 * `ARCHITECTURE.md` §4: "The rule gate before the LLM is the single most important
 * cost decision in the system. It is what makes the difference between a $150/month
 * toy and a $15/month tool."
 *
 * Every filter here is deterministic and free. Nothing in this file calls a model,
 * and nothing in it may: the whole point is to decide *without spending* whether
 * spending is warranted.
 *
 * ## Killing is not deleting
 *
 * A killed event is stored, scored, and visible. It simply does not reach the LLM.
 * That distinction matters for the same reason §T-1 mitigation 6 refuses to silently
 * drop suspected injections: a filter the operator cannot inspect is one he cannot
 * trust, and "why didn't we detect this?" must always be answerable.
 */

export type GateDecision = {
  readonly passed: boolean;
  /** The rule that killed it, or undefined when it passed. */
  readonly killedBy: string | undefined;
  /** A sentence the operator can read. Always present. */
  readonly reason: string;
};

export type GateContext = {
  /** Source ids attached to this event, for the corroboration gate. */
  readonly sourceIds: readonly string[];
  /** Evaluation time. A parameter, so a replay gates as the live run gated. */
  readonly now: Date;
};

/**
 * Decide whether an event may reach the LLM.
 *
 * Ordered cheapest-first and most-certain-first: a structural noise filter costs a
 * regex and is never wrong, while a score floor is a judgment call. Running the
 * judgment calls first would spend effort deciding about promo-code listings.
 */
export function applyGate(
  event: ScorableEvent,
  scores: EventScores,
  context: GateContext,
): GateDecision {
  // ─── 1. Structurally not an event.
  for (const pattern of NOISE_TITLE_PATTERNS) {
    const match = pattern.exec(event.title);
    if (match !== null) {
      return {
        passed: false,
        killedBy: 'noise_title',
        reason: `title matches a known-noise pattern ("${match[0]}") — promotional listings are not events`,
      };
    }
  }

  // ─── 2. Activity chatter from a personal GitHub feed.
  //
  // `github.com/{user}.atom` emits "commented on an issue" and "pushed X" all day.
  // A release from the same feed is a real event; a comment is not. The artifact is
  // what separates them.
  const fromActivityFeed = context.sourceIds.some((id) => ACTIVITY_ONLY_SOURCES.has(id));
  if (fromActivityFeed) {
    const isActivity = ACTIVITY_NOISE_PATTERNS.some((pattern) => pattern.test(event.title));
    const hasRelease = event.artifacts.versions.length > 0 || event.artifacts.models.length > 0;
    if (isActivity && !hasRelease) {
      return {
        passed: false,
        killedBy: 'activity_noise',
        reason:
          'personal GitHub activity with no version or model artifact — a comment or push, not a release',
      };
    }
  }

  // ─── 3. Too old to act on.
  //
  // The largest filter here, and the one the first measurement was missing. Recency
  // was only a score component, so an event from 2023 lost points and still cleared
  // the floor. ROADMAP.md §1 optimises for EARLY — "before the conversation moves
  // on" — and no score makes a two-year-old changelog entry actionable.
  const ageDays = (context.now.getTime() - event.eventOccurredAt.getTime()) / 86_400_000;
  if (ageDays > GATE_MAX_AGE_DAYS) {
    return {
      passed: false,
      killedBy: 'too_old',
      reason: `${ageDays.toFixed(1)} days old — past the ${String(GATE_MAX_AGE_DAYS)}-day window in which the operator could still be early`,
    };
  }

  // ─── 4. Uncorroborated and unspecific.
  //
  // One source, no named artifact. THREAT-MODEL.md §T-1 mitigation 7 caps such an
  // event's confidence and §T-2 biases its recommendation toward WAIT/VERIFY, so
  // paying for deep analysis buys a recommendation the rules already determined.
  if (GATE_REQUIRE_CORROBORATION_OR_ARTIFACT) {
    const distinctSources = new Set(context.sourceIds).size;
    const hasArtifact =
      event.artifacts.titleModels.length > 0 || event.artifacts.titleVersions.length > 0;
    if (distinctSources < 2 && !hasArtifact) {
      return {
        passed: false,
        killedBy: 'uncorroborated_and_unspecific',
        reason:
          'a single source and no named model or version — confidence is capped and the recommendation is already WAIT/VERIFY, so analysis would buy nothing',
      };
    }
  }

  // ─── 5. Off-topic category.
  if (OFF_TOPIC_CATEGORIES.has(event.category)) {
    return {
      passed: false,
      killedBy: 'off_topic',
      reason: `category "${event.category}" is out of scope`,
    };
  }

  // ─── 6. The arXiv corroboration gate.
  //
  // NOT a tunable preference. SOURCE-INTELLIGENCE.md §2 states it directly: 344 items
  // in one pull, and ungated it "would dominate ingestion volume and burn the LLM
  // budget on papers that will never become content". A paper reaches the LLM only
  // once something else has picked it up.
  const requiresCorroboration = context.sourceIds.some((id) =>
    CORROBORATION_REQUIRED_SOURCES.has(id),
  );
  if (requiresCorroboration) {
    const corroboratingSources = new Set(
      context.sourceIds.filter((id) => !CORROBORATION_REQUIRED_SOURCES.has(id)),
    );
    if (corroboratingSources.size === 0) {
      return {
        passed: false,
        killedBy: 'arxiv_uncorroborated',
        reason:
          'arXiv item with no corroboration from a discussion or official source (SOURCE-INTELLIGENCE §2)',
      };
    }
  }

  // ─── 7. Score floors.
  if (scores.importance.value < GATE_MIN_IMPORTANCE) {
    return {
      passed: false,
      killedBy: 'below_importance_floor',
      reason: `importance ${String(scores.importance.value)} is below the floor of ${String(GATE_MIN_IMPORTANCE)}`,
    };
  }

  if (scores.combined < GATE_MIN_COMBINED_SCORE) {
    return {
      passed: false,
      killedBy: 'below_combined_floor',
      reason: `combined score ${String(scores.combined)} is below the floor of ${String(GATE_MIN_COMBINED_SCORE)}`,
    };
  }

  return {
    passed: true,
    killedBy: undefined,
    reason: `passed: importance ${String(scores.importance.value)}, relevance ${String(scores.brandRelevance.value)}, combined ${String(scores.combined)}`,
  };
}

export type GateStats = {
  readonly total: number;
  readonly passed: number;
  readonly killed: number;
  /** The acceptance criterion: ≥0.85. */
  readonly killRate: number;
  readonly byRule: Record<string, number>;
};

export function summariseGate(decisions: readonly GateDecision[]): GateStats {
  const byRule: Record<string, number> = {};
  let killed = 0;

  for (const decision of decisions) {
    if (decision.passed) continue;
    killed += 1;
    const rule = decision.killedBy ?? 'unknown';
    byRule[rule] = (byRule[rule] ?? 0) + 1;
  }

  return {
    total: decisions.length,
    passed: decisions.length - killed,
    killed,
    killRate: decisions.length === 0 ? 0 : killed / decisions.length,
    byRule,
  };
}
