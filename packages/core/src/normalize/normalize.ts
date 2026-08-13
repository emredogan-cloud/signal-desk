import type { EventCategory, SourceCategory } from '@signal-desk/shared';
import type { EntityRegistry } from '../entities/registry.js';
import { sanitizeAndScan, type InjectionSignal } from './sanitize.js';
import { extractArtifacts, entitiesFromArtifacts, type Artifacts } from './artifacts.js';
import { canonicalizeUrl } from './url.js';

/**
 * `RawItem` → `NormalizedItem`. The step between storage and clustering.
 *
 * Pure and deterministic: the same row normalised twice produces byte-identical
 * output. That is not a nicety — ROADMAP.md Phase 4's acceptance includes "full
 * pipeline replay over `raw_items` is deterministic — same input, same clusters",
 * and Phase 12's offline weight refitting replays three months of history. Anything
 * non-deterministic here (a timestamp, a random id, a Set iteration order that
 * varies) silently breaks both.
 */

/** What normalisation needs from the source row. Deliberately not the whole row. */
export type NormalizeSource = {
  readonly id: string;
  readonly category: SourceCategory;
  readonly isOfficial: boolean;
  readonly reliability: number;
  readonly entity: string | null;
};

export type NormalizeInput = {
  readonly rawItemId: number;
  readonly source: NormalizeSource;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly contentHash: string;
  readonly publishedAt: Date | null;
  readonly fetchedAt: Date;
};

export type NormalizedItem = {
  readonly rawItemId: number;
  readonly sourceId: string;
  readonly sourceCategory: SourceCategory;
  readonly isOfficial: boolean;
  readonly sourceReliability: number;

  readonly title: string;
  readonly summary: string;
  readonly canonicalUrl: string;
  readonly contentHash: string;

  readonly entities: readonly string[];
  readonly artifacts: Artifacts;
  readonly category: EventCategory;

  /**
   * When the thing happened, as opposed to when we saw it.
   *
   * ARCHITECTURE.md §9 makes `first_seen_at − event_occurred_at` the latency KPI, so
   * this must be the publisher's timestamp where one exists. Where none does it
   * falls back to `fetchedAt` and **says so** via `occurredAtIsEstimated`, because a
   * silent fallback would make the KPI measure nothing while looking healthy.
   */
  readonly eventOccurredAt: Date;
  readonly occurredAtIsEstimated: boolean;
  readonly fetchedAt: Date;

  /** §T-1 mitigation 6: stored and surfaced, never silently dropped. */
  readonly injectionSignals: readonly InjectionSignal[];
  readonly truncated: boolean;
  /** Text used for embedding. Kept so a re-embed is reproducible. */
  readonly embeddingText: string;
};

/** Longest summary carried forward. Long enough to embed well, short enough to store. */
const SUMMARY_MAX = 2_000;

const HARDWARE_TERMS =
  /\b(?:gpu|tpu|npu|silicon|chip|wafer|nvlink|hbm|blackwell|hopper|cuda cores?|die|fab|foundry|data ?cent(?:re|er)|rack|cooling|watt|teraflops?)\b/i;

const POLICY_TERMS =
  /\b(?:pricing|price cut|deprecat\w*|end[- ]of[- ]life|sunset|terms of service|privacy policy|regulat\w*|compliance|gdpr|eu ai act|antitrust|lawsuit|rate limits?|quota|breaking change|migration guide|outage|incident|degraded performance|elevated error rates?|opt[- ]out|opt[- ]in)\b/i;

const AI_TERMS =
  /\b(?:model|llm|inference|token|context window|fine[- ]?tun\w*|embedding|transformer|agent(?:ic|s)?|prompt|benchmark|eval(?:uation|s)?|rag|reasoning|multimodal|training run|parameters?|quanti[sz]\w*)\b/i;

const SOCIAL_TERMS =
  /\b(?:trend(?:ing|s)?|viral|meme|format|creator|engagement|feed algorithm|for you|reach|impressions?)\b/i;

/** Entities whose news is AI news by default. */
const AI_ENTITIES = new Set([
  'anthropic',
  'openai',
  'google-deepmind',
  'mistral',
  'alibaba',
  'deepseek',
  'huggingface',
  'xai',
  'meta',
]);

/**
 * Category inference, by rule.
 *
 * Checked most-specific first. `policy_platform` outranks `ai` deliberately: an
 * Anthropic *pricing change* is a platform-policy event that happens to involve an
 * AI vendor, and the operator's response to it differs from his response to a model
 * launch. Merging the two categories is exactly the conflation ROADMAP.md §6 warns
 * about, one level down.
 */
export function inferCategory(text: string, entities: readonly string[]): EventCategory {
  // MEASURED CORRECTION. This list previously matched `licen[cs]\w*`, `policy`, and
  // a bare `ban(s|ned)`, which classified "released under an Apache 2.0 licence" as
  // a platform-policy event. That split a model release from its own community
  // thread in the labelled set. Terms that appear incidentally inside launch copy
  // were removed; terms that only appear when policy is the subject were kept.
  if (POLICY_TERMS.test(text)) return 'policy_platform';
  if (HARDWARE_TERMS.test(text)) return 'hardware';
  if (SOCIAL_TERMS.test(text) && !AI_TERMS.test(text)) return 'social_trend';
  if (AI_TERMS.test(text) || entities.some((e) => AI_ENTITIES.has(e))) return 'ai';
  return 'software';
}

export function normalizeItem(input: NormalizeInput, registry: EntityRegistry): NormalizedItem {
  // Title and body are sanitised separately: a payload hidden in a title needs the
  // same treatment as one in a body, and concatenating first would let a truncated
  // body swallow the title.
  const titleScan = sanitizeAndScan(input.title, { maxLength: 500 });
  const bodyScan = sanitizeAndScan(input.body, { maxLength: SUMMARY_MAX });

  const title = titleScan.sanitized.text;
  const summary = bodyScan.sanitized.text;
  const combined = `${title}\n${summary}`;

  // An unparseable publisher timestamp is treated as absent rather than propagated.
  // `Invalid Date` compares false against everything, so it would silently exclude an
  // item from every time-windowed comparison — it would simply never cluster, and
  // nothing would say why. Discovered when a test generated hour "110".
  const publishedAt =
    input.publishedAt !== null && !Number.isNaN(input.publishedAt.getTime())
      ? input.publishedAt
      : null;

  const artifacts = extractArtifacts(combined, title);
  const entities = registry.extractIds(combined);

  // A model id names its vendor even when no alias appears in the text, and the
  // alias resolver cannot see it — "Qwen3.8-27B" is one token that folds to
  // `qwen3827b`. Adding these is what lets a vendor post and its community thread
  // share an entity, which stage-2 dedup requires.
  for (const implied of entitiesFromArtifacts(artifacts)) {
    if (!entities.includes(implied)) entities.push(implied);
  }

  // The source's own entity always counts. A post on Anthropic's blog is about
  // Anthropic even when the text never names it, which is common in first-person
  // announcements ("we are releasing…").
  if (input.source.entity !== null && !entities.includes(input.source.entity)) {
    entities.unshift(input.source.entity);
  }
  return {
    rawItemId: input.rawItemId,
    sourceId: input.source.id,
    sourceCategory: input.source.category,
    isOfficial: input.source.isOfficial,
    sourceReliability: input.source.reliability,

    title,
    summary,
    canonicalUrl: canonicalizeUrl(input.url),
    contentHash: input.contentHash,

    entities,
    artifacts,
    category: inferCategory(combined, entities),

    eventOccurredAt: publishedAt ?? input.fetchedAt,
    occurredAtIsEstimated: publishedAt === null,
    fetchedAt: input.fetchedAt,

    injectionSignals: [...titleScan.signals, ...bodyScan.signals],
    truncated: titleScan.sanitized.truncated || bodyScan.sanitized.truncated,
    embeddingText: embeddingTextFor(title, summary),
  };
}

/**
 * The stage-1 content hash, exported for callers that build items by hand.
 *
 * Re-exported from `core` rather than `adapters` because tests and any future
 * backfill need it without pulling in the HTTP layer.
 */
/**
 * The text an item is embedded from.
 *
 * Title plus a bounded head of the summary. The tail is dropped on purpose: feed
 * bodies routinely end with boilerplate — "Subscribe to our newsletter", author
 * bios, cookie notices — that is identical across every item from one publisher and
 * therefore pulls their embeddings together regardless of subject. Including it
 * makes every TechCrunch article look like every other TechCrunch article.
 */
export function embeddingTextFor(title: string, summary: string): string {
  const head = summary.slice(0, 600);
  return `${title}\n\n${head}`.trim();
}
