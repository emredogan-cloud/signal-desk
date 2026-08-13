import {
  IMPORTANCE_WEIGHTS,
  CATEGORY_IMPORTANCE,
  RECENCY_HALF_LIFE_HOURS,
  CORROBORATION_SATURATION,
  TECHNICAL_IMPACT_TERMS,
  VELOCITY_WEIGHTS,
  VELOCITY_WINDOW_HOURS,
} from './weights.js';
import { component, toScore, clamp01, type Score, type ScorableEvent } from './types.js';

/**
 * Importance — "is this objectively a big deal?"
 *
 * Pure, deterministic, LLM-free. `ROADMAP.md` Phase 5: "Rules before models. This is
 * the gate that keeps ~90% of items away from the LLM."
 *
 * Every component returns a 0..1 value **and a sentence**. The sentence is not
 * decoration: it is what makes an 82 defensible, and an operator who cannot see why
 * something scored 82 will not trust the number.
 */

/** Hours between two instants, floored at zero. */
function hoursBetween(later: Date, earlier: Date): number {
  return Math.max(0, (later.getTime() - earlier.getTime()) / 3_600_000);
}

/**
 * Velocity — the substitute for the X signal that pricing removed.
 *
 * **INFERRED, NOT MEASURED.** `SOURCE-INTELLIGENCE.md` §0 and `THREAT-MODEL.md` §6
 * both record this as an unvalidated hypothesis that Phase 12 must confirm or
 * discard. It is exported separately so Phase 12 can evaluate it in isolation
 * against measured outcomes, rather than having to unpick it from importance.
 */
export function scoreVelocity(event: ScorableEvent, now: Date): Score {
  const evidence = [...event.evidence].sort(
    (a, b) => a.publishedAt.getTime() - b.publishedAt.getTime(),
  );
  const first = evidence[0];

  if (first === undefined) {
    return toScore([
      component('corroborationRate', 0, VELOCITY_WEIGHTS.corroborationRate, 'no evidence'),
      component('communityPickup', 0, VELOCITY_WEIGHTS.communityPickup, 'no evidence'),
      component('communityBreadth', 0, VELOCITY_WEIGHTS.communityBreadth, 'no evidence'),
    ]);
  }

  // How much corroboration arrived quickly. A story that six outlets carried within
  // six hours is moving; the same six over a week is not.
  const fastFollowers = evidence.filter(
    (item) =>
      item !== first && hoursBetween(item.publishedAt, first.publishedAt) <= VELOCITY_WINDOW_HOURS,
  ).length;
  const rate = clamp01(fastFollowers / CORROBORATION_SATURATION);

  const communitySources = new Set(
    evidence
      .filter((item) => item.sourceCategory === 'COMMUNITY_SIGNAL')
      .map((item) => item.sourceId),
  );

  void now;

  return toScore([
    component(
      'corroborationRate',
      rate,
      VELOCITY_WEIGHTS.corroborationRate,
      fastFollowers === 0
        ? 'no corroboration within 6h of the first report'
        : `${String(fastFollowers)} source(s) followed within ${String(VELOCITY_WINDOW_HOURS)}h`,
    ),
    component(
      'communityPickup',
      communitySources.size > 0 ? 1 : 0,
      VELOCITY_WEIGHTS.communityPickup,
      communitySources.size > 0
        ? `picked up by ${[...communitySources].join(', ')}`
        : 'no community discussion detected',
    ),
    component(
      'communityBreadth',
      clamp01(communitySources.size / 3),
      VELOCITY_WEIGHTS.communityBreadth,
      `${String(communitySources.size)} distinct community source(s)`,
    ),
  ]);
}

export function scoreImportance(event: ScorableEvent, now: Date): Score {
  const text = `${event.title}\n${event.summary}`;

  // ─── Source reliability: the best evidence, not the average.
  //
  // Averaging is wrong here. An official announcement corroborated by five comment
  // threads is exactly as authoritative as the announcement alone, and averaging
  // would drag it below a lone journalist's report.
  const bestReliability = event.evidence.reduce(
    (best, item) => Math.max(best, item.reliability),
    0,
  );
  const bestSource = event.evidence.reduce<(typeof event.evidence)[number] | undefined>(
    (best, item) => (best === undefined || item.reliability > best.reliability ? item : best),
    undefined,
  );

  // ─── Corroboration: distinct SOURCES, not distinct items.
  //
  // Six items from one feed is one source repeating itself. The distinction is what
  // stops a chatty publisher from manufacturing importance.
  const distinctSources = new Set(event.evidence.map((item) => item.sourceId)).size;
  const corroboration = clamp01(distinctSources / CORROBORATION_SATURATION);

  // ─── Novelty: is this the event, or a follow-up to it?
  const ageAtFirstSight = hoursBetween(event.firstSeenAt, event.eventOccurredAt);
  const novelty = event.occurredAtIsEstimated
    ? 0.5 // no publisher timestamp — cannot tell, and must not pretend to
    : clamp01(1 - ageAtFirstSight / 72);

  // ─── Technical impact: the strongest matching term wins.
  let technicalImpact = 0;
  let impactTerm = 'no impact-bearing terms found';
  for (const [pattern, weight] of TECHNICAL_IMPACT_TERMS) {
    const match = pattern.exec(text);
    if (match !== null && weight > technicalImpact) {
      technicalImpact = weight;
      impactTerm = `matched "${match[0]}"`;
    }
  }
  // Category sets a floor, so an AI event with dull wording still outranks a
  // gadget review with exciting wording.
  const categoryFloor = CATEGORY_IMPORTANCE[event.category] * 0.5;
  const impactValue = Math.max(technicalImpact, categoryFloor);

  // ─── Recency: exponential decay from when it happened.
  const ageHours = hoursBetween(now, event.eventOccurredAt);
  const recency = clamp01(Math.pow(0.5, ageHours / RECENCY_HALF_LIFE_HOURS));

  const velocity = scoreVelocity(event, now);

  return toScore([
    component(
      'sourceReliability',
      bestReliability,
      IMPORTANCE_WEIGHTS.sourceReliability,
      bestSource === undefined
        ? 'no evidence attached'
        : `best evidence is ${bestSource.sourceId} (${bestSource.sourceCategory}, reliability ${bestReliability.toFixed(2)})`,
    ),
    component(
      'corroboration',
      corroboration,
      IMPORTANCE_WEIGHTS.corroboration,
      `${String(distinctSources)} distinct source(s), saturating at ${String(CORROBORATION_SATURATION)}`,
    ),
    component(
      'novelty',
      novelty,
      IMPORTANCE_WEIGHTS.novelty,
      event.occurredAtIsEstimated
        ? 'publisher gave no timestamp — novelty cannot be determined, scored neutral'
        : `first seen ${ageAtFirstSight.toFixed(1)}h after it happened`,
    ),
    component(
      'technicalImpact',
      impactValue,
      IMPORTANCE_WEIGHTS.technicalImpact,
      technicalImpact > categoryFloor
        ? impactTerm
        : `no strong impact terms; floored by category "${event.category}"`,
    ),
    component(
      'velocity',
      velocity.value / 100,
      IMPORTANCE_WEIGHTS.velocity,
      `velocity ${String(velocity.value)}/100 (INFERRED proxy — HN/Reddit/GitHub, unvalidated until Phase 12)`,
    ),
    component(
      'recency',
      recency,
      IMPORTANCE_WEIGHTS.recency,
      `${ageHours.toFixed(1)}h old, half-life ${String(RECENCY_HALF_LIFE_HOURS)}h`,
    ),
  ]);
}
