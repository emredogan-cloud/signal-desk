import {
  RELEVANCE_WEIGHTS,
  TESTABLE_ENTITIES,
  TEACHING_TERMS,
  DIFFERENTIATION_PENALTY_PER_EXPERT_SOURCE,
} from './weights.js';
import { component, toScore, clamp01, type Score, type ScorableEvent } from './types.js';

/**
 * Brand relevance — "is this a big deal **for this operator**?"
 *
 * `ROADMAP.md` §7 keeps this deliberately independent of importance, "because
 * 'important' and 'important *for me*' are different questions and merging them
 * hides the second". A Blackwell launch is objectively enormous and something this
 * operator can add nothing to; a Supabase edge-function change is objectively small
 * and something he can test in ten minutes and write about credibly.
 *
 * The single strongest question, per §7, is **whether he can test it** — that is what
 * separates a post worth reading from a summary of the press release.
 */

export type RelevanceContext = {
  /** Entity relevance from the registry, 0..1 by entity id. */
  readonly entityRelevance: ReadonlyMap<string, number>;
};

export function scoreBrandRelevance(event: ScorableEvent, context: RelevanceContext): Score {
  const text = `${event.title}\n${event.summary}`;

  // ─── Entity proximity: the closest entity, not the average.
  //
  // An event touching Anthropic and Apple is an Anthropic event for this operator.
  // Averaging would let an irrelevant co-mention drag a highly relevant one down.
  let entityProximity = 0;
  let closestEntity: string | undefined;
  for (const entity of event.entities) {
    const relevance = context.entityRelevance.get(entity) ?? 0;
    if (relevance > entityProximity) {
      entityProximity = relevance;
      closestEntity = entity;
    }
  }

  // ─── Testability: can he run it today, free, on his own machine?
  let testability = 0;
  let testableVia: string | undefined;
  for (const entity of event.entities) {
    const score = TESTABLE_ENTITIES[entity] ?? 0;
    if (score > testability) {
      testability = score;
      testableVia = entity;
    }
  }
  // Without something concrete to install, "testable" is aspirational.
  //
  // This started as a +0.1 bonus and was wrong: for the entities the operator works
  // with most, base testability is already 1.0, so the bonus saturated and could not
  // discriminate at exactly the top of the list where discrimination matters. An
  // Anthropic *policy post* is not testable in any sense a reader would recognise,
  // and it was scoring identically to a model release.
  //
  // Scaling instead of adding makes the artifact load-bearing everywhere.
  const hasArtifact = event.artifacts.models.length > 0 || event.artifacts.versions.length > 0;
  testability = clamp01(testability * (hasArtifact ? 1 : 0.6));

  // ─── Differentiation: is the obvious angle already taken?
  //
  // SOURCE-INTELLIGENCE.md §3 on Simon Willison: "if he has already published the
  // experiment, the operator's angle must be different, not duplicative." Heavy
  // expert coverage LOWERS the value of adding another voice.
  const expertSources = new Set(
    event.evidence
      .filter((item) => item.sourceCategory === 'EXPERT_ANALYST')
      .map((item) => item.sourceId),
  );
  const differentiation = clamp01(
    1 - expertSources.size * DIFFERENTIATION_PENALTY_PER_EXPERT_SOURCE,
  );

  // ─── Teaching potential.
  const teachingMatches = TEACHING_TERMS.filter((pattern) => pattern.test(text)).length;
  const teachingPotential = clamp01(teachingMatches / 3);

  return toScore([
    component(
      'entityProximity',
      entityProximity,
      RELEVANCE_WEIGHTS.entityProximity,
      closestEntity === undefined
        ? 'no known entity identified'
        : `closest entity is "${closestEntity}" (relevance ${entityProximity.toFixed(2)})`,
    ),
    component(
      'testability',
      testability,
      RELEVANCE_WEIGHTS.testability,
      testableVia === undefined
        ? 'nothing here he can run himself'
        : hasArtifact
          ? `can be tested via ${testableVia}, and names a concrete artifact to install`
          : `related to ${testableVia}, but names nothing concrete to run — not directly testable`,
    ),
    component(
      'differentiation',
      differentiation,
      RELEVANCE_WEIGHTS.differentiation,
      expertSources.size === 0
        ? 'no expert analyst has covered this yet'
        : `${String(expertSources.size)} expert source(s) already covering it (${[...expertSources].join(', ')}) — a duplicate angle is worth less`,
    ),
    component(
      'teachingPotential',
      teachingPotential,
      RELEVANCE_WEIGHTS.teachingPotential,
      teachingMatches === 0
        ? 'nothing obviously teachable'
        : `${String(teachingMatches)} teaching signal(s) in the text`,
    ),
  ]);
}

/** Build the entity-relevance lookup from registry rows. */
export function entityRelevanceMap(
  entities: readonly { id: string; operatorRelevance: number }[],
): Map<string, number> {
  return new Map(entities.map((entity) => [entity.id, entity.operatorRelevance]));
}
