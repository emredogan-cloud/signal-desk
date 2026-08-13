/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument --
   These tests drive `submitBatch` and `collectBatch` with minimal fake clients.
   Constructing a real `Anthropic` instance needs a key, and the point of every test
   here is the request shape and the result mapping, not the client's type. */
import { describe, it, expect, vi } from 'vitest';
import {
  submitBatch,
  collectBatch,
  measureBatchSaving,
  BATCH_DISCOUNT,
  type BatchOutcome,
} from './batch.js';
import { TRIAGE_JSON_SCHEMA } from './schema.js';
import { TRIAGE_SYSTEM } from './prompts.js';
import { callCostUsd } from './budget.js';
import type { EnvelopeItem } from './envelope.js';

/**
 * `ROADMAP.md` Phase 8 acceptance: "Batch API path confirmed working at reduced cost."
 *
 * These test the wiring — request shape, custom_id discipline, discount arithmetic —
 * against a fake client. Whether a real batch completes is PENDING-CREDENTIALS, and
 * `measureBatchSaving` is what reports it when credentials exist.
 */

const items: EnvelopeItem[] = [
  {
    evidenceId: 'ev-1',
    sourceId: 'anthropic-news-diff',
    title: 'Release',
    body: 'A new model.',
    url: 'https://example.com/1',
    publishedAt: '2026-08-13T10:00:00Z',
  },
];

/**
 * An async iterator over an in-memory array.
 *
 * The SDK's real `batches.results()` returns an async iterable, so the fake has to
 * match that surface. Written as a standalone generator rather than inline, because
 * an inline async method with nothing to await trips `require-await`.
 */
async function* asyncIterate<T>(entries: readonly T[]): AsyncGenerator<T> {
  for (const entry of entries) {
    yield await Promise.resolve(entry);
  }
}

const request = (customId: string, eventId: number) => ({
  customId,
  eventId,
  title: `Event ${String(eventId)}`,
  summary: 'A summary.',
  items,
});

function fakeClient(created: { requests?: unknown[] }) {
  return {
    messages: {
      batches: {
        create: vi.fn().mockImplementation((body: { requests: unknown[] }) => {
          created.requests = body.requests;
          return Promise.resolve({ id: 'batch_123' });
        }),
      },
    },
  };
}

describe('batch submission', () => {
  it('sends one request per event with the shared cached prefix', async () => {
    const created: { requests?: unknown[] } = {};
    const submission = await submitBatch(fakeClient(created) as any, {
      model: 'claude-haiku-4-5',
      systemCached: TRIAGE_SYSTEM,
      jsonSchema: TRIAGE_JSON_SCHEMA,
      maxTokens: 700,
      requests: [request('ev-1', 1), request('ev-2', 2)],
    });

    expect(submission.batchId).toBe('batch_123');
    expect(submission.requestCount).toBe(2);
    expect(created.requests).toHaveLength(2);
  });

  it('gives every request its OWN envelope delimiter', async () => {
    // Two requests in one batch are still two independent untrusted documents. A
    // shared delimiter would let one document's content forge another's fence.
    const created: { requests?: unknown[] } = {};
    await submitBatch(fakeClient(created) as any, {
      model: 'claude-haiku-4-5',
      systemCached: TRIAGE_SYSTEM,
      jsonSchema: TRIAGE_JSON_SCHEMA,
      maxTokens: 700,
      requests: [request('a', 1), request('b', 2)],
    });

    const delimiters = (created.requests ?? []).map((entry) => {
      const body = JSON.stringify(entry);
      return /UNTRUSTED_[0-9A-F]{32}/.exec(body)?.[0];
    });
    expect(delimiters[0]).toBeDefined();
    expect(delimiters[0]).not.toBe(delimiters[1]);
  });

  it('exposes no tools — same rule as the synchronous path', async () => {
    const created: { requests?: unknown[] } = {};
    await submitBatch(fakeClient(created) as any, {
      model: 'claude-haiku-4-5',
      systemCached: TRIAGE_SYSTEM,
      jsonSchema: TRIAGE_JSON_SCHEMA,
      maxTokens: 700,
      requests: [request('a', 1)],
    });
    expect(JSON.stringify(created.requests)).not.toContain('"tools"');
  });

  it('refuses a duplicate custom_id rather than corrupting the mapping', async () => {
    // A duplicate makes results unmatchable — silent corruption, not a failure.
    const created: { requests?: unknown[] } = {};
    await expect(
      submitBatch(fakeClient(created) as any, {
        model: 'claude-haiku-4-5',
        systemCached: TRIAGE_SYSTEM,
        jsonSchema: TRIAGE_JSON_SCHEMA,
        maxTokens: 700,
        requests: [request('same', 1), request('same', 2)],
      }),
    ).rejects.toThrow(/duplicate custom_id/);
  });

  it('refuses an empty batch', async () => {
    const created: { requests?: unknown[] } = {};
    await expect(
      submitBatch(fakeClient(created) as any, {
        model: 'claude-haiku-4-5',
        systemCached: TRIAGE_SYSTEM,
        jsonSchema: TRIAGE_JSON_SCHEMA,
        maxTokens: 700,
        requests: [],
      }),
    ).rejects.toThrow(/empty batch/);
  });
});

describe('batch results', () => {
  const usage = {
    input_tokens: 1000,
    output_tokens: 200,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };

  function resultsClient(entries: unknown[]) {
    return {
      messages: {
        batches: {
          results: vi.fn().mockResolvedValue({
            [Symbol.asyncIterator]: () => asyncIterate(entries),
          }),
        },
      },
    };
  }

  it('keys results by custom_id, never by position', async () => {
    // Results arrive in ANY order. Position-based matching produces a silent,
    // plausible-looking mis-attribution, which is worse than a crash.
    const client = resultsClient([
      {
        custom_id: 'ev-99',
        result: {
          type: 'succeeded',
          message: {
            content: [{ type: 'text', text: '{"a":2}' }],
            usage,
            model: 'claude-haiku-4-5',
            stop_reason: 'end_turn',
          },
        },
      },
      {
        custom_id: 'ev-1',
        result: {
          type: 'succeeded',
          message: {
            content: [{ type: 'text', text: '{"a":1}' }],
            usage,
            model: 'claude-haiku-4-5',
            stop_reason: 'end_turn',
          },
        },
      },
    ]);

    const outcomes = await collectBatch(client as any, 'batch_123');
    expect(outcomes.get('ev-1')?.json).toEqual({ a: 1 });
    expect(outcomes.get('ev-99')?.json).toEqual({ a: 2 });
  });

  it('applies the 50% discount to the recorded cost', async () => {
    const client = resultsClient([
      {
        custom_id: 'ev-1',
        result: {
          type: 'succeeded',
          message: {
            content: [{ type: 'text', text: '{}' }],
            usage,
            model: 'claude-haiku-4-5',
            stop_reason: 'end_turn',
          },
        },
      },
    ]);
    const outcomes = await collectBatch(client as any, 'batch_123');

    const full = callCostUsd('claude-haiku-4-5', {
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    // The ledger must record what was BILLED. A batch row priced at the synchronous
    // rate would overstate spend and stop the budget guard early for no reason.
    expect(outcomes.get('ev-1')?.costUsd).toBeCloseTo((full ?? 0) * BATCH_DISCOUNT, 10);
  });

  it('records a failed request without losing the rest of the batch', async () => {
    const client = resultsClient([
      { custom_id: 'ev-1', result: { type: 'errored', error: { type: 'invalid_request' } } },
      {
        custom_id: 'ev-2',
        result: {
          type: 'succeeded',
          message: {
            content: [{ type: 'text', text: '{}' }],
            usage,
            model: 'claude-haiku-4-5',
            stop_reason: 'end_turn',
          },
        },
      },
    ]);
    const outcomes = await collectBatch(client as any, 'batch_123');
    expect(outcomes.get('ev-1')?.status).toBe('errored');
    expect(outcomes.get('ev-1')?.error).toContain('invalid_request');
    expect(outcomes.get('ev-2')?.status).toBe('succeeded');
  });

  it('records non-JSON output as an error rather than throwing', async () => {
    const client = resultsClient([
      {
        custom_id: 'ev-1',
        result: {
          type: 'succeeded',
          message: {
            content: [{ type: 'text', text: 'not json' }],
            usage,
            model: 'claude-haiku-4-5',
            stop_reason: 'end_turn',
          },
        },
      },
    ]);
    const outcomes = await collectBatch(client as any, 'batch_123');
    expect(outcomes.get('ev-1')?.error).toContain('not valid JSON');
  });
});

describe('measuring the saving', () => {
  it('computes both figures from the same recorded usage', () => {
    // "Confirmed working at reduced cost" — confirmed, not assumed. The saving is
    // arithmetic over real tokens rather than an assertion that a discount applied.
    const outcomes = new Map<string, BatchOutcome>([
      [
        'a',
        {
          customId: 'a',
          status: 'succeeded',
          json: {},
          usage: {
            inputTokens: 10_000,
            outputTokens: 1_000,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          costUsd:
            (callCostUsd('claude-haiku-4-5', {
              inputTokens: 10_000,
              outputTokens: 1_000,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            }) ?? 0) * BATCH_DISCOUNT,
          error: undefined,
        },
      ],
    ]);

    const saving = measureBatchSaving(outcomes, 'claude-haiku-4-5');
    expect(saving.requests).toBe(1);
    expect(saving.savedFraction).toBeCloseTo(0.5, 6);
    expect(saving.batchCostUsd).toBeLessThan(saving.syncCostUsd);
  });

  it('handles an empty result set without dividing by zero', () => {
    expect(measureBatchSaving(new Map(), 'claude-haiku-4-5').savedFraction).toBe(0);
  });

  it('ignores failed requests when measuring', () => {
    const outcomes = new Map<string, BatchOutcome>([
      [
        'a',
        {
          customId: 'a',
          status: 'errored',
          json: undefined,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costUsd: 0,
          error: 'x',
        },
      ],
    ]);
    expect(measureBatchSaving(outcomes, 'claude-haiku-4-5').requests).toBe(0);
  });
});
