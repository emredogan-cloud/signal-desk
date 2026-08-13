import type { EventCategory, SourceCategory } from '@signal-desk/shared';
import {
  hasArtifactOverlap,
  identityArtifactKeys,
  type Artifacts,
} from '../normalize/artifacts.js';
import type { NormalizedItem } from '../normalize/normalize.js';

/**
 * Three-stage deduplication. ARCHITECTURE.md §5 — **cheap first, expensive last.**
 *
 * | Stage | Method | Catches | Cost |
 * |---|---|---|---|
 * | 1 | canonical URL + content hash | re-fetches, syndication, feed duplicates | ~0 |
 * | 2 | entity + artifact + 48h window | "Anthropic ships Claude X" from six outlets | ~0 |
 * | 3 | embedding cosine, same category, in window | paraphrases with no shared artifact | local CPU |
 *
 * **Merges are reversible** and every merge writes an audit row. A silent wrong merge
 * *hides* an event, which is strictly worse than a visible duplicate: the operator
 * can see and ignore a duplicate, and cannot see something that was absorbed.
 *
 * This module performs no I/O. Candidates are passed in — already restricted to the
 * time window and, for stage 3, to the same category — and it returns a decision.
 */

/** An existing event, as much of it as clustering needs. */
export type ClusterCandidate = {
  readonly eventId: number;
  readonly category: EventCategory;
  readonly entities: readonly string[];
  readonly artifacts: Artifacts;
  readonly canonicalUrls: ReadonlySet<string>;
  readonly contentHashes: ReadonlySet<string>;
  readonly eventOccurredAt: Date;
  /** Absent when the event has no embedding yet; stage 3 then skips it. */
  readonly embedding?: Float32Array | undefined;
  /** Strongest evidence category so far. Drives primary-source selection. */
  readonly primarySourceCategory: SourceCategory;
};

export type MergeStage = 1 | 2 | 3;

export type ClusterDecision =
  | {
      readonly kind: 'merge';
      readonly eventId: number;
      readonly stage: MergeStage;
      readonly similarity: number | undefined;
      readonly reason: string;
    }
  | { readonly kind: 'new'; readonly reason: string };

export type DedupOptions = {
  /**
   * Stage-3 cosine threshold.
   *
   * ARCHITECTURE.md §5 carried **0.86** as an explicit starting guess. The value in
   * use is `DEDUP_SIMILARITY_THRESHOLD` below, measured against the labelled set.
   */
  readonly similarityThreshold?: number;
  /** Stage-2 and stage-3 window. ARCHITECTURE.md §5 says 48h. */
  readonly windowHours?: number;
  /**
   * Stage-2 requires a shared entity *and* a shared artifact. Without the artifact
   * requirement, every Anthropic item within 48 hours merges into one event —
   * which is the single most destructive failure this module can have, because it
   * makes a real launch invisible inside a cluster of unrelated blog posts.
   */
  readonly requireArtifactForStage2?: boolean;
};

/**
 * **MEASURED 2026-08-13 — 0.80**, replacing the 0.86 starting guess.
 *
 * Swept against the labelled set with the real `bge-small-en-v1.5` embedder
 * (`pnpm measure:dedup`):
 *
 * | threshold | precision | recall | wrong merges | missed |
 * |---|---|---|---|---|
 * | 0.75 | 1.0000 | 1.0000 | 0 | 0 |
 * | **0.78** | **1.0000** | **1.0000** | **0** | **0** |
 * | **0.80** | **1.0000** | **0.9500** | **0** | **1** |
 * | 0.84 | 1.0000 | 0.9000 | 0 | 2 |
 * | 0.86 *(old guess)* | 1.0000 | 0.9000 | 0 | 2 |
 * | 0.95 | 1.0000 | 0.9000 | 0 | 2 |
 *
 * **0.80 is chosen over the measured optimum of 0.78, deliberately.** The labelled
 * set is 25 items and 300 pairs — small enough that its exact optimum is a property
 * of the sample rather than of the world. Precision is 1.0 across the whole sweep
 * because `artifactsConflict` is what protects it, not the threshold; the threshold's
 * remaining job is guarding the case the set under-represents, which is two items
 * that carry *no artifacts on either side* and merge on prose alone. 0.80 keeps
 * margin there and still satisfies the acceptance criteria with room.
 *
 * Re-measure when the labelled set grows. `pnpm measure:dedup` prints the sweep.
 */
export const DEDUP_SIMILARITY_THRESHOLD = 0.8;

export const DEDUP_WINDOW_HOURS = 48;

/**
 * Extra similarity demanded when two items were assigned different categories.
 *
 * **MEASURED.** Category inference is rule-based and therefore noisy; treating a
 * mismatch as disqualifying cost three real merges in the labelled set. Treating it
 * as free cost precision. This margin is the middle, chosen by the same sweep that
 * chose the threshold.
 */
export const CROSS_CATEGORY_MARGIN = 0.04;

/**
 * True when both sides name artifacts and none of them agree.
 *
 * The asymmetry matters: an item with NO artifacts conflicts with nothing, because
 * absence is not disagreement. Only when both sides make a positive identity claim
 * and those claims differ is a merge ruled out.
 */
export function artifactsConflict(a: Artifacts, b: Artifacts): boolean {
  // Identity artifacts only. A shared repository does not make two releases the same
  // release, so it must not suppress the conflict between b10405 and b10408.
  const keysA = identityArtifactKeys(a);
  const keysB = identityArtifactKeys(b);
  if (keysA.size === 0 || keysB.size === 0) return false;

  for (const key of keysB) {
    if (keysA.has(key)) return false;
  }
  return true;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function withinWindow(a: Date, b: Date, windowHours: number): boolean {
  return Math.abs(a.getTime() - b.getTime()) <= windowHours * 3_600_000;
}

function sharesEntity(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const set = new Set(a);
  return b.some((entity) => set.has(entity));
}

/**
 * Decide where an item belongs.
 *
 * Candidates are evaluated stage by stage across the whole set before moving to the
 * next stage — not candidate by candidate. A stage-1 match anywhere beats a stage-3
 * match anywhere, because stage 1 is certainty and stage 3 is inference.
 */
export function decideCluster(
  item: NormalizedItem,
  candidates: readonly ClusterCandidate[],
  itemEmbedding: Float32Array | undefined,
  options: DedupOptions = {},
): ClusterDecision {
  const threshold = options.similarityThreshold ?? DEDUP_SIMILARITY_THRESHOLD;
  const windowHours = options.windowHours ?? DEDUP_WINDOW_HOURS;
  const requireArtifact = options.requireArtifactForStage2 ?? true;

  // ─── Stage 1 — exact identity. No window: a re-fetch of a two-year-old post is
  // still the same post, and applying a window here would create duplicates of
  // anything older than the window.
  for (const candidate of candidates) {
    if (candidate.canonicalUrls.has(item.canonicalUrl)) {
      return {
        kind: 'merge',
        eventId: candidate.eventId,
        stage: 1,
        similarity: undefined,
        reason: `same canonical URL (${item.canonicalUrl})`,
      };
    }
    if (candidate.contentHashes.has(item.contentHash)) {
      return {
        kind: 'merge',
        eventId: candidate.eventId,
        stage: 1,
        similarity: undefined,
        reason: 'identical content hash',
      };
    }
  }

  // ─── Stage 2 — the same named thing, close in time.
  for (const candidate of candidates) {
    if (!withinWindow(item.eventOccurredAt, candidate.eventOccurredAt, windowHours)) continue;
    if (!sharesEntity(item.entities, candidate.entities)) continue;

    const artifactOverlap = hasArtifactOverlap(item.artifacts, candidate.artifacts);
    if (requireArtifact && !artifactOverlap) continue;

    return {
      kind: 'merge',
      eventId: candidate.eventId,
      stage: 2,
      similarity: undefined,
      reason: artifactOverlap
        ? `shared entity and artifact within ${String(windowHours)}h`
        : `shared entity within ${String(windowHours)}h`,
    };
  }

  // ─── Stage 3 — paraphrase, by embedding.
  if (itemEmbedding !== undefined) {
    let best: { candidate: ClusterCandidate; similarity: number } | undefined;

    for (const candidate of candidates) {
      if (candidate.embedding === undefined) continue;
      if (!withinWindow(item.eventOccurredAt, candidate.eventOccurredAt, windowHours)) continue;

      // MEASURED FIX. Two consecutive llama.cpp builds — "b10400" and "b10405" —
      // embed at cosine 0.9649, because their text is nearly identical. They are two
      // releases, and merging them hides one. Artifacts are the high-precision
      // identity signal: when BOTH sides name a version or model and those names are
      // disjoint, no amount of textual similarity should override that.
      if (artifactsConflict(item.artifacts, candidate.artifacts)) continue;

      // Category is a SIGNAL, not a gate.
      //
      // ARCHITECTURE.md §5 originally restricted stage 3 to same-category candidates.
      // Measurement showed that costs more than it buys: rule-based category
      // inference is noisy, and it split three genuine clusters — an outage reported
      // by a status page ("software") and by Hacker News ("ai"), and a model release
      // whose vendor post mentioned a licence ("policy_platform") while the community
      // thread mentioned benchmarks ("ai"). A mismatched category now demands a
      // higher bar instead of blocking outright.
      const effectiveThreshold =
        candidate.category === item.category ? threshold : threshold + CROSS_CATEGORY_MARGIN;

      const similarity = cosineSimilarity(itemEmbedding, candidate.embedding);
      if (
        similarity >= effectiveThreshold &&
        (best === undefined || similarity > best.similarity)
      ) {
        best = { candidate, similarity };
      }
    }

    if (best !== undefined) {
      return {
        kind: 'merge',
        eventId: best.candidate.eventId,
        stage: 3,
        similarity: best.similarity,
        reason: `embedding similarity ${best.similarity.toFixed(4)} ≥ ${String(threshold)}`,
      };
    }
  }

  return {
    kind: 'new',
    reason:
      candidates.length === 0
        ? 'no candidates in window'
        : `no candidate matched at any stage (${String(candidates.length)} considered)`,
  };
}

// ───────────────────── primary-source selection ─────────────────────

/**
 * Source-category authority, highest first. ARCHITECTURE.md §5:
 *
 *   "`primary_source_id` is chosen by source category, not by arrival order:
 *    `OFFICIAL_SOURCE` outranks `JOURNALIST` even if the journalist published
 *    first. A journalist's report *about* a launch is evidence; the launch post is
 *    the record."
 */
const SOURCE_AUTHORITY: Record<SourceCategory, number> = {
  OFFICIAL_SOURCE: 100,
  TECHNICAL_RESEARCHER: 70,
  EXPERT_ANALYST: 60,
  EARLY_SIGNAL: 50,
  JOURNALIST: 40,
  COMMUNITY_SIGNAL: 20,
  AMPLIFIER: 10,
};

export function sourceAuthority(category: SourceCategory): number {
  return SOURCE_AUTHORITY[category];
}

/**
 * Should `incoming` replace `current` as the event's primary source?
 *
 * Strictly greater, never equal: on a tie the earlier evidence keeps the role, so
 * the primary source does not churn between two official sources on every poll.
 */
export function shouldReplacePrimary(current: SourceCategory, incoming: SourceCategory): boolean {
  return sourceAuthority(incoming) > sourceAuthority(current);
}

/** Evidence role, from how the item relates to the event it joined. */
export type EvidenceRole = 'primary' | 'corroborating' | 'reaction';

export function evidenceRole(
  item: { sourceCategory: SourceCategory },
  isPrimary: boolean,
): EvidenceRole {
  if (isPrimary) return 'primary';
  return item.sourceCategory === 'COMMUNITY_SIGNAL' || item.sourceCategory === 'AMPLIFIER'
    ? 'reaction'
    : 'corroborating';
}
