import type Anthropic from '@anthropic-ai/sdk';
import { buildEnvelope, newDelimiter, type EnvelopeItem } from './envelope.js';
import { framingBlock } from './prompts.js';
import { callCostUsd, type TokenUsage } from './budget.js';

/**
 * The Batch API path — 50% cost for work that is not urgent.
 *
 * `ROADMAP.md` Phase 6: "Batch API path for non-urgent work at 50% cost."
 * Phase 8: "Runs nightly via the Batch API (50% cost)" and, as an acceptance
 * criterion, "Batch API path confirmed working at reduced cost."
 *
 * ## What belongs here and what does not
 *
 * Batches complete within 24 hours, usually within one. That is fine for the nightly
 * educational sweep, and useless for an outage the operator wants to post about in
 * the next twenty minutes. So the split is not "cheap versus expensive" — it is
 * **deadline versus no deadline**:
 *
 * | Work                          | Path        | Why                                    |
 * |-------------------------------|-------------|----------------------------------------|
 * | Triage of a breaking event    | Synchronous | The value decays in hours              |
 * | Deep analysis above threshold | Synchronous | Feeds a POST_NOW recommendation        |
 * | Nightly educational sweep     | **Batch**   | Teaching content does not depend on being first |
 * | Backfill after a budget pause | **Batch**   | Already late; half price is the win    |
 *
 * ## Results arrive in ANY order
 *
 * Keyed by `custom_id`, never by position. This is the single most common Batch API
 * mistake and it produces a silent, plausible-looking mis-attribution — analysis for
 * event 40 stored against event 12 — which is far worse than a crash.
 */

export const BATCH_DISCOUNT = 0.5;

export type BatchRequest = {
  /** Must be unique in the batch, and is the ONLY safe way to match results back. */
  readonly customId: string;
  readonly eventId: number;
  readonly title: string;
  readonly summary: string;
  readonly items: readonly EnvelopeItem[];
};

export type BatchSubmission = {
  readonly batchId: string;
  readonly requestCount: number;
  readonly submittedAt: Date;
};

export type BatchOutcome = {
  readonly customId: string;
  readonly status: 'succeeded' | 'errored' | 'canceled' | 'expired';
  readonly json: unknown;
  readonly usage: TokenUsage;
  /** Already halved. Batch work is billed at 50% of standard rates. */
  readonly costUsd: number;
  readonly error: string | undefined;
};

/**
 * Submit a batch.
 *
 * The system prompt is the same cached prefix the synchronous path uses, so a batch
 * run also benefits from any cache entry a synchronous run wrote — and vice versa.
 * Keeping the two prompts identical is the reason they live in one module.
 */
export async function submitBatch(
  client: Anthropic,
  input: {
    readonly model: string;
    readonly systemCached: string;
    readonly jsonSchema: Record<string, unknown>;
    readonly maxTokens: number;
    readonly requests: readonly BatchRequest[];
  },
): Promise<BatchSubmission> {
  if (input.requests.length === 0) {
    throw new Error('refusing to submit an empty batch');
  }

  const seen = new Set<string>();
  for (const request of input.requests) {
    if (seen.has(request.customId)) {
      // A duplicate custom_id makes results unmatchable, which is silent corruption
      // rather than a failure. Refuse before submitting.
      throw new Error(`duplicate custom_id in batch: ${request.customId}`);
    }
    seen.add(request.customId);
  }

  const batch = await client.messages.batches.create({
    requests: input.requests.map((request) => {
      // A fresh delimiter per REQUEST, not per batch. Two requests in one batch are
      // still two independent untrusted documents (THREAT-MODEL §T-1 mitigation 4).
      const delimiter = newDelimiter();
      const envelope = buildEnvelope(request.items, delimiter);

      return {
        custom_id: request.customId,
        params: {
          model: input.model,
          max_tokens: input.maxTokens,
          system: [
            {
              type: 'text' as const,
              text: input.systemCached,
              cache_control: { type: 'ephemeral' as const },
            },
            { type: 'text' as const, text: framingBlock(delimiter) },
          ],
          messages: [
            {
              role: 'user' as const,
              content: [
                `EVENT: ${request.title}`,
                `SUMMARY: ${request.summary}`,
                `EVIDENCE IDS YOU MAY CITE: ${request.items.map((item) => item.evidenceId).join(', ') || '(none)'}`,
                '',
                envelope.text,
              ].join('\n'),
            },
          ],
          output_config: {
            format: { type: 'json_schema' as const, schema: input.jsonSchema },
          },
          // NO tools. Same rule as the synchronous path — §T-1 mitigation 1.
        },
      };
    }),
  });

  return {
    batchId: batch.id,
    requestCount: input.requests.length,
    submittedAt: new Date(),
  };
}

export type BatchStatus = {
  readonly batchId: string;
  readonly processingStatus: string;
  readonly ended: boolean;
  readonly succeeded: number;
  readonly errored: number;
  readonly processing: number;
};

export async function checkBatch(client: Anthropic, batchId: string): Promise<BatchStatus> {
  const batch = await client.messages.batches.retrieve(batchId);
  return {
    batchId,
    processingStatus: batch.processing_status,
    ended: batch.processing_status === 'ended',
    succeeded: batch.request_counts.succeeded,
    errored: batch.request_counts.errored,
    processing: batch.request_counts.processing,
  };
}

/**
 * Collect results, keyed by `custom_id`.
 *
 * Returns a Map rather than an array, because an array invites the position-based
 * indexing that silently mis-attributes results. The type makes the correct usage the
 * only convenient one.
 */
export async function collectBatch(
  client: Anthropic,
  batchId: string,
): Promise<Map<string, BatchOutcome>> {
  const outcomes = new Map<string, BatchOutcome>();

  for await (const entry of await client.messages.batches.results(batchId)) {
    const base = { customId: entry.custom_id };

    if (entry.result.type !== 'succeeded') {
      outcomes.set(entry.custom_id, {
        ...base,
        status: entry.result.type,
        json: undefined,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0,
        error:
          entry.result.type === 'errored'
            ? `${entry.result.error.type}: batch request failed`
            : `batch request ${entry.result.type}`,
      });
      continue;
    }

    const message = entry.result.message;
    const usage: TokenUsage = {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
    };

    const textBlock = message.content.find((block) => block.type === 'text');
    let json: unknown;
    let error: string | undefined;

    if (textBlock === undefined) {
      error = `no text block (stop_reason: ${message.stop_reason ?? 'null'})`;
    } else {
      try {
        json = JSON.parse(textBlock.text);
      } catch {
        error = 'response was not valid JSON despite structured outputs';
      }
    }

    outcomes.set(entry.custom_id, {
      ...base,
      status: 'succeeded',
      json,
      usage,
      // The discount is applied here rather than left to the caller, so the ledger
      // records what was actually billed. A batch row priced at the synchronous rate
      // would overstate spend and make the budget guard stop early for no reason.
      costUsd: (callCostUsd(message.model, usage) ?? 0) * BATCH_DISCOUNT,
      error,
    });
  }

  return outcomes;
}

/**
 * What the batch actually saved, measured.
 *
 * Phase 8's acceptance criterion is "Batch API path **confirmed working at reduced
 * cost**" — confirmed, not assumed. This computes both figures from the same recorded
 * usage so the saving is arithmetic over real tokens rather than an assertion that
 * the discount was applied.
 */
export function measureBatchSaving(
  outcomes: ReadonlyMap<string, BatchOutcome>,
  model: string,
): {
  requests: number;
  batchCostUsd: number;
  syncCostUsd: number;
  savedUsd: number;
  savedFraction: number;
} {
  let batchCost = 0;
  let syncCost = 0;
  let requests = 0;

  for (const outcome of outcomes.values()) {
    if (outcome.status !== 'succeeded') continue;
    requests += 1;
    batchCost += outcome.costUsd;
    syncCost += callCostUsd(model, outcome.usage) ?? 0;
  }

  return {
    requests,
    batchCostUsd: batchCost,
    syncCostUsd: syncCost,
    savedUsd: syncCost - batchCost,
    savedFraction: syncCost === 0 ? 0 : (syncCost - batchCost) / syncCost,
  };
}
