import Anthropic from '@anthropic-ai/sdk';
import { NO_USAGE, type TokenUsage } from './budget.js';

/**
 * The Anthropic client wrapper.
 *
 * Thin on purpose. It owns exactly three things the callers should not each
 * reimplement: **no tools, ever**; the cached-prefix layout; and usage extraction.
 *
 * ## No tools. Ever.
 *
 * `THREAT-MODEL.md` §T-1 mitigation 1 — the one all the others sit behind:
 *
 * > "No web fetch, no filesystem, no shell, no publishing. A perfect injection wins
 * > the ability to put wrong text in a JSON field. It cannot act."
 *
 * There is no `tools` parameter in this file and no way for a caller to pass one.
 * That is the containment: an analysis model that has been fully compromised can
 * still only return a JSON object that a human then reads next to its cited evidence.
 * A test asserts the request body carries no `tools` key.
 */

export type CompletionRequest = {
  readonly model: string;
  /** The stable, cached prefix. Must be byte-identical across requests. */
  readonly systemCached: string;
  /** Per-request system content — the envelope framing. Never cached. */
  readonly systemDynamic: string;
  readonly userContent: string;
  readonly jsonSchema: Record<string, unknown>;
  readonly maxTokens: number;
  /** `low` for triage, higher for analysis. Omitted lets the API default apply. */
  readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
};

export type CompletionResult = {
  readonly json: unknown;
  readonly usage: TokenUsage;
  readonly model: string;
  readonly stopReason: string | null;
};

export class AiRefusalError extends Error {
  constructor(readonly category: string | undefined) {
    super(
      `the model declined this request (${category ?? 'no category given'}); the item is kept and marked, not dropped`,
    );
    this.name = 'AiRefusalError';
  }
}

export class AiSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiSchemaError';
  }
}

export function createClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, maxRetries: 2 });
}

/**
 * Read `stop_details.category` off a refusal.
 *
 * The field is documented and present on the wire, but `@anthropic-ai/sdk@0.72.1`
 * does not yet declare it on `Message` — SDK typings lag new response fields. Rather
 * than cast the whole response to `any` (which would silence every other type error
 * in this function too), this narrows just the one property and tolerates its absence.
 * When the typings catch up, this can collapse to `response.stop_details?.category`.
 */
function refusalCategory(response: unknown): string | undefined {
  if (typeof response !== 'object' || response === null) return undefined;
  const details = (response as { stop_details?: unknown }).stop_details;
  if (typeof details !== 'object' || details === null) return undefined;
  const category = (details as { category?: unknown }).category;
  return typeof category === 'string' ? category : undefined;
}

/**
 * One structured call.
 *
 * ## Cache layout
 *
 * Render order is `tools` → `system` → `messages`, so the breakpoint goes on the
 * **last cached system block**, with the volatile content strictly after it:
 *
 * ```
 *   system[0]  stable prompt         ← cache_control breakpoint
 *   system[1]  per-request framing   (delimiter — changes every call)
 *   messages   the envelope          (changes every call)
 * ```
 *
 * Putting the framing before the breakpoint would invalidate the cache on every
 * request, since the delimiter is fresh each time — the classic silent invalidator.
 *
 * Haiku's 4096-token minimum is why `TRIAGE_SYSTEM` is long. Below the floor there is
 * no error, just `cache_creation_input_tokens: 0` and full price forever.
 */
export async function complete(
  client: Anthropic,
  request: CompletionRequest,
): Promise<CompletionResult> {
  const response = await client.messages.create({
    model: request.model,
    max_tokens: request.maxTokens,
    system: [
      {
        type: 'text',
        text: request.systemCached,
        cache_control: { type: 'ephemeral' },
      },
      { type: 'text', text: request.systemDynamic },
    ],
    messages: [{ role: 'user', content: request.userContent }],
    output_config: {
      format: {
        type: 'json_schema',
        schema: request.jsonSchema,
      },
      ...(request.effort === undefined ? {} : { effort: request.effort }),
    },
    // NO `tools` KEY. See the class comment — this is THREAT-MODEL §T-1 mitigation 1
    // and it is asserted by a test, not merely intended.
  });

  // A refusal is an HTTP 200 with an empty or partial `content`. Reading content[0]
  // unconditionally would throw here; the item must be kept and marked instead.
  if (response.stop_reason === 'refusal') {
    throw new AiRefusalError(refusalCategory(response));
  }

  const usage: TokenUsage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
  };

  const textBlock = response.content.find((block) => block.type === 'text');
  if (textBlock === undefined) {
    throw new AiSchemaError(
      `no text block in the response (stop_reason: ${response.stop_reason ?? 'null'})`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(textBlock.text);
  } catch {
    throw new AiSchemaError('response was not valid JSON despite structured outputs');
  }

  return { json, usage, model: response.model, stopReason: response.stop_reason };
}

/** Token count for a prompt, for pre-call budgeting. Never `tiktoken` — wrong tokenizer. */
export async function countPromptTokens(
  client: Anthropic,
  model: string,
  system: string,
  user: string,
): Promise<number> {
  const result = await client.messages.countTokens({
    model,
    system: [{ type: 'text', text: system }],
    messages: [{ role: 'user', content: user }],
  });
  return result.input_tokens;
}

export { NO_USAGE };
