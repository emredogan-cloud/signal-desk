import {
  clusterCandidates,
  findEventByUrlOrHash,
  createEvent,
  attachEvidence,
  refreshEventAggregates,
  setPrimarySource,
  upsertEventEmbedding,
  recordMergeAudit,
  operatorUnmergedRawItems,
  eventPrimarySourceCategory,
  unclusteredRawItemIds,
  loadRawItemsWithSource,
  type Db,
} from '@signal-desk/db';
import {
  normalizeItem,
  decideCluster,
  evidenceRole,
  shouldReplacePrimary,
  embeddingToBuffer,
  bufferToEmbedding,
  DEDUP_WINDOW_HOURS,
  type EntityRegistry,
  type Embedder,
  type NormalizedItem,
  type ClusterCandidate,
  type ClusterDecision,
} from '@signal-desk/core';
import { withTrace, type Logger, type SourceCategory } from '@signal-desk/shared';

/**
 * `raw_items` → `events`. ARCHITECTURE.md §4, the stage after ingestion.
 *
 * Two properties this must have, and both are acceptance criteria:
 *
 *  1. **Deterministic.** The same rows processed twice produce the same clusters.
 *     Items are therefore processed in `raw_items.id` order — arrival order, which
 *     is stable — rather than in whatever order a query returns them.
 *  2. **Re-runnable.** `events` is derived. Clearing it and re-running over
 *     `raw_items` must reproduce the same result, which is what makes changing the
 *     algorithm safe and what Phase 12's offline replay depends on.
 */

export type PipelineOptions = {
  readonly db: Db;
  readonly registry: EntityRegistry;
  readonly logger: Logger;
  /** Absent → stages 1 and 2 only, and the summary says so. */
  readonly embedder?: Embedder | undefined;
  readonly now?: Date;
  readonly batchSize?: number;
  readonly windowHours?: number;
  readonly similarityThreshold?: number;
};

export type PipelineSummary = {
  readonly processed: number;
  readonly newEvents: number;
  readonly merged: { readonly stage1: number; readonly stage2: number; readonly stage3: number };
  readonly skippedOperatorUnmerged: number;
  readonly injectionFlagged: number;
  readonly embedded: number;
  readonly embeddingAvailable: boolean;
  readonly durationMs: number;
};

type LoadedItem = {
  readonly rawItemId: number;
  readonly normalized: NormalizedItem;
};

/** Load and normalise a batch, preserving id order for determinism. */
function loadBatch(db: Db, ids: readonly number[], registry: EntityRegistry): LoadedItem[] {
  return loadRawItemsWithSource(db, ids).map((row) => ({
    rawItemId: row.id,
    normalized: normalizeItem(
      {
        rawItemId: row.id,
        source: {
          id: row.sourceId,
          category: row.sourceCategory as SourceCategory,
          isOfficial: row.isOfficial,
          reliability: row.reliability,
          entity: row.sourceEntity,
        },
        title: row.title,
        body: row.body,
        url: row.url,
        contentHash: row.contentHash,
        publishedAt: row.publishedAt,
        fetchedAt: row.fetchedAt,
      },
      registry,
    ),
  }));
}

function toCandidate(row: ReturnType<typeof clusterCandidates>[number]): ClusterCandidate {
  return {
    eventId: row.eventId,
    category: row.category,
    entities: row.entities,
    artifacts: row.artifacts,
    canonicalUrls: new Set(row.canonicalUrls),
    contentHashes: new Set(row.contentHashes),
    eventOccurredAt: row.eventOccurredAt,
    embedding: row.embedding === null ? undefined : bufferToEmbedding(row.embedding),
    primarySourceCategory: row.primarySourceCategory as SourceCategory,
  };
}

export async function runPipeline(options: PipelineOptions): Promise<PipelineSummary> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? 200;
  const windowHours = options.windowHours ?? DEDUP_WINDOW_HOURS;
  const startedAt = Date.now();

  // Drain the queue rather than taking one bounded slice of it. The first real run
  // processed 5,000 of 5,208 items and reported success, because the query's limit
  // was being read as a ceiling.
  const QUEUE_PAGE = 5000;
  const pending: number[] = [];
  for (let after = 0; ;) {
    const batch = unclusteredRawItemIds(options.db, QUEUE_PAGE, after);
    if (batch.length === 0) break;
    pending.push(...batch);
    after = batch[batch.length - 1] ?? after;
    if (batch.length < QUEUE_PAGE) break;
  }

  const operatorUnmerged = operatorUnmergedRawItems(options.db);

  const merged = { stage1: 0, stage2: 0, stage3: 0 };
  let newEvents = 0;
  let processed = 0;
  let injectionFlagged = 0;
  let embedded = 0;
  let skippedOperatorUnmerged = 0;

  for (let offset = 0; offset < pending.length; offset += batchSize) {
    const batch = loadBatch(
      options.db,
      pending.slice(offset, offset + batchSize),
      options.registry,
    );

    // Embed the whole batch in one forward pass. Per-item embedding costs the same
    // model call sixty times over.
    const embeddings =
      options.embedder === undefined
        ? undefined
        : await options.embedder.embed(batch.map((item) => item.normalized.embeddingText));

    for (const [index, item] of batch.entries()) {
      processed += 1;

      // An item the operator pulled out of an event by hand must not be silently
      // put back by the next pipeline run. Operator intent outranks the algorithm.
      if (operatorUnmerged.has(item.rawItemId)) {
        skippedOperatorUnmerged += 1;
        continue;
      }

      const logger = withTrace(options.logger, `cluster-${String(item.rawItemId)}`);
      const embedding = embeddings?.[index];
      const normalized = item.normalized;

      if (normalized.injectionSignals.length > 0) {
        injectionFlagged += 1;
        // §T-1 mitigation 6: surfaced, never silently dropped. The item is still
        // clustered and stored; what changes is that it is visible as suspicious.
        logger.warn(
          {
            raw_item_id: item.rawItemId,
            source_id: normalized.sourceId,
            signals: normalized.injectionSignals.map((s) => s.kind),
          },
          'injection signals detected in ingested content',
        );
      }

      // Stage 1 is checked against the whole table, not just the window: a re-fetch
      // of an old post is the same post.
      const exact = findEventByUrlOrHash(
        options.db,
        normalized.canonicalUrl,
        normalized.contentHash,
      );

      const decision: ClusterDecision =
        exact !== undefined
          ? {
              kind: 'merge',
              eventId: exact,
              stage: 1,
              similarity: undefined,
              reason: 'exact URL or content hash',
            }
          : decideCluster(
              normalized,
              clusterCandidates(
                options.db,
                new Date(normalized.eventOccurredAt.getTime() - windowHours * 3_600_000),
              ).map(toCandidate),
              embedding,
              {
                windowHours,
                ...(options.similarityThreshold !== undefined
                  ? { similarityThreshold: options.similarityThreshold }
                  : {}),
              },
            );

      if (decision.kind === 'merge') {
        merged[`stage${String(decision.stage)}` as 'stage1' | 'stage2' | 'stage3'] += 1;
        attachToEvent(options.db, decision.eventId, normalized, decision, now);
      } else {
        newEvents += 1;
        const eventId = openEvent(options.db, normalized, now);
        if (embedding !== undefined && options.embedder !== undefined) {
          upsertEventEmbedding(
            options.db,
            {
              eventId,
              model: options.embedder.name,
              dimensions: options.embedder.dimensions,
              embedding: embeddingToBuffer(embedding),
              sourceText: normalized.embeddingText,
            },
            now,
          );
          embedded += 1;
        }
      }
    }
  }

  return {
    processed,
    newEvents,
    merged,
    skippedOperatorUnmerged,
    injectionFlagged,
    embedded,
    embeddingAvailable: options.embedder !== undefined,
    durationMs: Date.now() - startedAt,
  };
}

function openEvent(db: Db, item: NormalizedItem, now: Date): number {
  const eventId = createEvent(
    db,
    {
      title: item.title,
      summary: item.summary,
      category: item.category,
      entities: [...item.entities],
      artifacts: {
        models: [...item.artifacts.models],
        versions: [...item.artifacts.versions],
        repos: [...item.artifacts.repos],
        titleModels: [...item.artifacts.titleModels],
        titleVersions: [...item.artifacts.titleVersions],
      },
      firstSeenAt: item.fetchedAt,
      eventOccurredAt: item.eventOccurredAt,
      occurredAtIsEstimated: item.occurredAtIsEstimated,
      primarySourceId: item.sourceId,
      primaryRawItemId: item.rawItemId,
      hasOfficialSource: item.isOfficial,
      injectionFlagged: item.injectionSignals.length > 0,
    },
    now,
  );

  attachEvidence(
    db,
    {
      eventId,
      rawItemId: item.rawItemId,
      sourceId: item.sourceId,
      role: 'primary',
      mergeStage: null,
      similarity: null,
      canonicalUrl: item.canonicalUrl,
      contentHash: item.contentHash,
    },
    now,
  );

  refreshEventAggregates(db, eventId, now);
  return eventId;
}

function attachToEvent(
  db: Db,
  eventId: number,
  item: NormalizedItem,
  decision: Extract<ClusterDecision, { kind: 'merge' }>,
  now: Date,
): void {
  // Primary-source selection is by category, not arrival order (ARCHITECTURE.md §5).
  // A journalist's report about a launch is evidence; the launch post is the record —
  // even when the journalist published first.
  //
  // One targeted read. This previously loaded every event and all of its evidence on
  // every merge, which is quadratic and was measured doing real damage.
  const currentPrimary = eventPrimarySourceCategory(db, eventId);
  const promote =
    currentPrimary !== undefined &&
    shouldReplacePrimary(currentPrimary as SourceCategory, item.sourceCategory);

  const attached = attachEvidence(
    db,
    {
      eventId,
      rawItemId: item.rawItemId,
      sourceId: item.sourceId,
      role: evidenceRole({ sourceCategory: item.sourceCategory }, promote),
      mergeStage: decision.stage,
      similarity: decision.similarity ?? null,
      canonicalUrl: item.canonicalUrl,
      contentHash: item.contentHash,
    },
    now,
  );

  if (!attached) return; // already attached; nothing to audit or recount

  if (promote) {
    setPrimarySource(db, eventId, item.sourceId, item.rawItemId, now);
  }

  recordMergeAudit(
    db,
    {
      action: 'merge',
      rawItemId: item.rawItemId,
      fromEventId: null,
      toEventId: eventId,
      stage: decision.stage,
      similarity: decision.similarity ?? null,
      reason: decision.reason,
      actor: 'pipeline',
    },
    now,
  );

  refreshEventAggregates(db, eventId, now);
}
