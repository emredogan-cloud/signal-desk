import type { EntityRegistry } from '../entities/registry.js';
import { normalizeItem, type NormalizedItem } from '../normalize/normalize.js';
import { decideCluster, type ClusterCandidate } from './dedup.js';
import type { Embedder } from './embedder.js';
import { LABELLED_CLUSTERS, type LabelledCluster } from './labelled-fixtures.js';

/**
 * Measuring clustering quality against the labelled set.
 *
 * **Pairwise** precision and recall, not per-cluster accuracy. The unit is "should
 * these two items be in the same event?", because that is the decision the algorithm
 * actually makes and the one whose errors matter:
 *
 *   - a **false positive** is a wrong merge, which *hides* an event
 *   - a **false negative** is a missed merge, which shows a duplicate
 *
 * Those are not symmetric, which is why the acceptance bar is asymmetric too:
 * precision ≥0.95, recall ≥0.85. The operator can see and dismiss a duplicate; he
 * cannot see something that was absorbed into another event.
 */

export type MeasureResult = {
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly trueNegatives: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  readonly pairsEvaluated: number;
  readonly itemsEvaluated: number;
  /** Every wrong merge, for inspection. A number without these is not diagnosable. */
  readonly wrongMerges: readonly { a: string; b: string; stage: number; similarity?: number }[];
  readonly missedMerges: readonly { a: string; b: string }[];
};

export type MeasureOptions = {
  readonly registry: EntityRegistry;
  readonly embedder?: Embedder | undefined;
  readonly similarityThreshold?: number;
  readonly windowHours?: number;
  /** Restrict to one provenance, to report real and synthetic separately. */
  readonly provenance?: 'real' | 'synthetic';
  readonly clusters?: readonly LabelledCluster[];
};

/**
 * Run the labelled set through the real clustering path and score the result.
 *
 * Items are processed in publication order — the order they would really arrive —
 * and each is clustered against the events built so far. Feeding the algorithm the
 * whole set at once would let it see the future, which the live pipeline never can.
 */
export async function measureClustering(options: MeasureOptions): Promise<MeasureResult> {
  const clusters = (options.clusters ?? LABELLED_CLUSTERS).filter(
    (cluster) => options.provenance === undefined || cluster.provenance === options.provenance,
  );

  const labelled = clusters
    .flatMap((cluster) => cluster.items.map((item) => ({ ...item, label: cluster.label })))
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.id.localeCompare(b.id));

  const embeddings =
    options.embedder === undefined
      ? undefined
      : await options.embedder.embed(
          labelled.map((item) => {
            const normalized = toNormalized(item, options.registry);
            return normalized.embeddingText;
          }),
        );

  // Rebuild the clustering as the pipeline would, event by event.
  type BuiltEvent = {
    eventId: number;
    candidate: ClusterCandidate;
    memberIds: string[];
    embedding: Float32Array | undefined;
  };

  const built: BuiltEvent[] = [];
  const assignment = new Map<string, number>();
  const mergeInfo = new Map<string, { stage: number; similarity?: number }>();
  let nextEventId = 1;

  for (const [index, item] of labelled.entries()) {
    const normalized = toNormalized(item, options.registry);
    const embedding = embeddings?.[index];

    const decision = decideCluster(
      normalized,
      built.map((event) => event.candidate),
      embedding,
      {
        ...(options.similarityThreshold !== undefined
          ? { similarityThreshold: options.similarityThreshold }
          : {}),
        ...(options.windowHours !== undefined ? { windowHours: options.windowHours } : {}),
      },
    );

    if (decision.kind === 'merge') {
      const target = built.find((event) => event.eventId === decision.eventId);
      if (target !== undefined) {
        target.memberIds.push(item.id);
        target.candidate = mergeInto(target.candidate, normalized);
        assignment.set(item.id, target.eventId);
        mergeInfo.set(item.id, {
          stage: decision.stage,
          ...(decision.similarity !== undefined ? { similarity: decision.similarity } : {}),
        });
        continue;
      }
    }

    const eventId = nextEventId++;
    built.push({
      eventId,
      candidate: toCandidate(eventId, normalized, embedding),
      memberIds: [item.id],
      embedding,
    });
    assignment.set(item.id, eventId);
  }

  // ─── Score every pair.
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let trueNegatives = 0;
  const wrongMerges: { a: string; b: string; stage: number; similarity?: number }[] = [];
  const missedMerges: { a: string; b: string }[] = [];

  for (let i = 0; i < labelled.length; i++) {
    for (let j = i + 1; j < labelled.length; j++) {
      const a = labelled[i];
      const b = labelled[j];
      if (a === undefined || b === undefined) continue;

      const shouldMatch = a.label === b.label;
      const didMatch = assignment.get(a.id) === assignment.get(b.id);

      if (shouldMatch && didMatch) truePositives += 1;
      else if (!shouldMatch && didMatch) {
        falsePositives += 1;
        const info = mergeInfo.get(b.id) ?? mergeInfo.get(a.id);
        wrongMerges.push({
          a: a.id,
          b: b.id,
          stage: info?.stage ?? 0,
          ...(info?.similarity !== undefined ? { similarity: info.similarity } : {}),
        });
      } else if (shouldMatch && !didMatch) {
        falseNegatives += 1;
        missedMerges.push({ a: a.id, b: b.id });
      } else trueNegatives += 1;
    }
  }

  const precision =
    truePositives + falsePositives === 0 ? 1 : truePositives / (truePositives + falsePositives);
  const recall =
    truePositives + falseNegatives === 0 ? 1 : truePositives / (truePositives + falseNegatives);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    truePositives,
    falsePositives,
    falseNegatives,
    trueNegatives,
    precision,
    recall,
    f1,
    pairsEvaluated: (labelled.length * (labelled.length - 1)) / 2,
    itemsEvaluated: labelled.length,
    wrongMerges,
    missedMerges,
  };
}

function toNormalized(
  item: {
    id: string;
    sourceId: string;
    sourceCategory: string;
    isOfficial: boolean;
    title: string;
    body: string;
    url: string;
    publishedAt: string;
  },
  registry: EntityRegistry,
): NormalizedItem {
  const published = new Date(item.publishedAt);
  return normalizeItem(
    {
      // The fixture id is a string; `rawItemId` is numeric in the real pipeline and
      // is not used by any clustering decision, so a stable hash is sufficient here.
      rawItemId: stableId(item.id),
      source: {
        id: item.sourceId,
        category: item.sourceCategory as NormalizedItem['sourceCategory'],
        isOfficial: item.isOfficial,
        reliability: item.isOfficial ? 0.95 : 0.6,
        entity: null,
      },
      title: item.title,
      body: item.body,
      url: item.url,
      contentHash: `hash-${item.id}`,
      publishedAt: published,
      fetchedAt: published,
    },
    registry,
  );
}

function stableId(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function toCandidate(
  eventId: number,
  item: NormalizedItem,
  embedding: Float32Array | undefined,
): ClusterCandidate {
  return {
    eventId,
    category: item.category,
    entities: item.entities,
    artifacts: item.artifacts,
    canonicalUrls: new Set([item.canonicalUrl]),
    contentHashes: new Set([item.contentHash]),
    eventOccurredAt: item.eventOccurredAt,
    embedding,
    primarySourceCategory: item.sourceCategory,
  };
}

/**
 * Fold a newly attached item into the event's matching surface.
 *
 * The event accumulates URLs, hashes, entities, and artifacts. Its *timestamp* stays
 * at the earliest evidence — the event happened when it happened, and letting it
 * drift forward with each new mention would slide the 48-hour window along behind a
 * long-running story and eventually absorb the follow-up three days later.
 */
function mergeInto(candidate: ClusterCandidate, item: NormalizedItem): ClusterCandidate {
  return {
    ...candidate,
    entities: [...new Set([...candidate.entities, ...item.entities])],
    artifacts: {
      models: [...new Set([...candidate.artifacts.models, ...item.artifacts.models])],
      versions: [...new Set([...candidate.artifacts.versions, ...item.artifacts.versions])],
      repos: [...new Set([...candidate.artifacts.repos, ...item.artifacts.repos])],
      titleModels: [
        ...new Set([...candidate.artifacts.titleModels, ...item.artifacts.titleModels]),
      ],
      titleVersions: [
        ...new Set([...candidate.artifacts.titleVersions, ...item.artifacts.titleVersions]),
      ],
    },
    canonicalUrls: new Set([...candidate.canonicalUrls, item.canonicalUrl]),
    contentHashes: new Set([...candidate.contentHashes, item.contentHash]),
    eventOccurredAt:
      item.eventOccurredAt < candidate.eventOccurredAt
        ? item.eventOccurredAt
        : candidate.eventOccurredAt,
  };
}

/** Sweep thresholds, for choosing one with evidence instead of by feel. */
export async function sweepThreshold(
  options: Omit<MeasureOptions, 'similarityThreshold'>,
  thresholds: readonly number[] = [0.75, 0.78, 0.8, 0.82, 0.84, 0.86, 0.88, 0.9, 0.92, 0.95],
): Promise<{ threshold: number; result: MeasureResult }[]> {
  const out: { threshold: number; result: MeasureResult }[] = [];
  for (const threshold of thresholds) {
    out.push({
      threshold,
      result: await measureClustering({ ...options, similarityThreshold: threshold }),
    });
  }
  return out;
}
