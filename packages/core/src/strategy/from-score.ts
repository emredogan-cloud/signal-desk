import type { ConfidenceLevel, EventCategory } from '@signal-desk/shared';
import { buildStrategy, type Strategy } from './options.js';
import { TESTABLE_ENTITIES } from '../score/weights.js';

/**
 * Turn a stored score row plus its evidence into a strategy.
 *
 * Extracted because three callers were doing it independently — the `strategy` CLI,
 * the dashboard's data layer, and the `alerts` CLI — and the third one had already
 * drifted: it hard-coded `recommendedAction: 'POST_SOON'` rather than deriving it, so
 * the alert path could never fire. Three derivations of the same thing become three
 * different answers, and the one that drifts is the one nobody is looking at.
 *
 * This lives in `core` rather than `db` because it is a *judgement* over stored rows,
 * not a query. `db` should not know what an expert angle is.
 */

export type ScoredRow = {
  readonly eventId: number;
  readonly title: string;
  readonly category: EventCategory;
  readonly entities: readonly string[];
  readonly eventOccurredAt: Date;
  readonly importance: number;
  readonly brandRelevance: number;
  readonly combined: number;
  readonly confidence: ConfidenceLevel;
  readonly distinctSourceCount: number;
  /** The stored Phase 5 component breakdown, if present. */
  readonly breakdown: unknown;
};

export type RowEvidence = {
  readonly title: string;
  readonly isOfficial: boolean;
  readonly sourceId: string;
  readonly sourceCategory: string;
};

export function strategyFromScore(
  row: ScoredRow,
  evidence: readonly RowEvidence[],
  now: Date,
): Strategy {
  const breakdown = row.breakdown as {
    brandRelevance?: { name: string; value: number }[];
  } | null;

  // Reuse the MEASURED testability component when the breakdown has one, and fall back
  // to the entity table otherwise. Reusing it keeps the strategy layer consistent with
  // the score the operator is shown, rather than computing a second opinion.
  const measured = breakdown?.brandRelevance?.find((c) => c.name === 'testability')?.value ?? 0;

  return buildStrategy({
    eventId: row.eventId,
    title: row.title,
    summary: '',
    category: row.category,
    entities: [...row.entities],
    testable:
      measured > 0.5 || row.entities.some((entity) => (TESTABLE_ENTITIES[entity] ?? 0) >= 0.8),
    hasVersionArtifact: evidence.some((item) => /v?\d+\.\d+|\bb\d{4,}\b/.test(item.title)),
    hasOfficialSource: evidence.some((item) => item.isOfficial),
    distinctSourceCount: row.distinctSourceCount,
    expertSourceCount: new Set(
      evidence.filter((item) => item.sourceCategory === 'EXPERT_ANALYST').map((i) => i.sourceId),
    ).size,
    // These come from a Phase 6 analysis. Empty is honest when none exists — filling
    // them with plausible defaults would put invented gaps in front of the operator.
    stillUnknown: [],
    whatChanged: '',
    importance: row.importance,
    brandRelevance: row.brandRelevance,
    combined: row.combined,
    confidence: row.confidence,
    hoursSinceEvent: Math.max(0, (now.getTime() - row.eventOccurredAt.getTime()) / 3_600_000),
    doNotSay: [],
    injectionFlagged: false,
  });
}
