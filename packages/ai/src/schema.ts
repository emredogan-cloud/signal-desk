import { z } from 'zod';
import {
  ATTENTION_DRIVERS,
  CONFIDENCE_LEVELS,
  EVIDENCE_TAGS,
  EVENT_CATEGORIES,
  MEDIA_KINDS,
} from '@signal-desk/shared';

/**
 * Output schemas for every model call.
 *
 * **`THREAT-MODEL.md` §T-1 mitigation 2:** "All calls use `output_config.format` with
 * a strict JSON schema (`additionalProperties: false`). The model cannot emit a field
 * that is not in the schema, so injected content cannot introduce a new instruction
 * channel into the output."
 *
 * `additionalProperties: false` on every object is therefore a **security control**,
 * not a tidiness preference. It is asserted by a test.
 *
 * ## Why Zod and JSON Schema both
 *
 * Zod validates what actually came back — including the rules JSON Schema cannot
 * express, like "every claim cites an evidence id that exists in this request".
 * JSON Schema constrains what the model may emit in the first place. Structured
 * outputs make schema violations nearly impossible; Zod is what catches the *nearly*,
 * plus the semantic rules that are the real defence.
 */

export const RECOMMENDED_ACTIONS = ['POST_NOW', 'POST_SOON', 'WAIT', 'VERIFY', 'IGNORE'] as const;
export type RecommendedAction = (typeof RECOMMENDED_ACTIONS)[number];

/**
 * A single factual claim, with its provenance.
 *
 * `ROADMAP.md` Phase 6: "Per-claim confidence tags and evidence ids; **claims without
 * evidence ids fail validation**." §5 test 6 is the test: "An analysis containing a
 * number with no evidence id fails validation."
 */
export const claimSchema = z
  .object({
    text: z.string().min(1).max(800),
    evidenceIds: z.array(z.string().min(1)).min(1),
    tag: z.enum(EVIDENCE_TAGS),
  })
  .strict();

export type Claim = z.infer<typeof claimSchema>;

/**
 * Length bounds are HYGIENE, not security — and the first live run showed the
 * difference matters.
 *
 * `reason` was capped at 300 characters. Two of six real Haiku calls wrote 320-odd
 * characters of perfectly good reasoning, Zod rejected the whole object, and a triage
 * verdict **that had already been paid for** was discarded. The model had no way to
 * know: structured outputs do not carry `maxLength`, so the bound was invisible to it
 * and fatal to us.
 *
 * The fix is both halves. The prompt now states the limits, and the bounds are
 * generous enough that a slight overrun does not throw away paid work. Rejection is
 * reserved for things that actually matter — schema shape, evidence ids, provenance —
 * not for prose that ran long.
 *
 * `oneLine` stays tight at 200: it is a headline, and a headline that runs long is
 * wrong rather than merely verbose.
 */
export const MAX_REASON_CHARS = 800;

export const triageSchema = z
  .object({
    isRealEvent: z.boolean(),
    category: z.enum(EVENT_CATEGORIES),
    oneLine: z.string().min(1).max(200),
    worthDeepAnalysis: z.boolean(),
    reason: z.string().min(1).max(MAX_REASON_CHARS),
    injectionObserved: z.boolean(),
    injectionNote: z.string().max(1000),
  })
  .strict();

export type TriageResult = z.infer<typeof triageSchema>;

/**
 * Raw material for a post. **Not a post.**
 *
 * The division of labour, decided 2026-08-14: the model writes *lines*, and
 * `packages/core` assembles the *post*. The reason is not stylistic. A finished post
 * emitted by a model that has just read untrusted third-party content is a string the
 * operator is being invited to paste onto his own timeline — the character limit, the
 * do-not-say list, and the absence of injected handles or links would all be things the
 * model **promised**, not things the code **guarantees**. `composeDrafts` treats every
 * field here as untrusted input and enforces all three.
 *
 * Each field is one sentence because that is what composition needs. Asking for
 * paragraphs and then cutting them is how drafts end mid-clause.
 *
 * ## Why the bounds are far larger than a post
 *
 * `substance` is capped at 800 characters for a line that will be trimmed to fit inside
 * 280. That looks wrong and is deliberate — it is the lesson `MAX_REASON_CHARS` above
 * already paid for, applied a second time because the first application did not
 * generalise.
 *
 * On 2026-08-14 these were capped at post-sized lengths (200/240/240/240). Two live
 * Opus analyses came back with a `substance` line of roughly 250 characters, Zod
 * rejected the **entire analysis** over it, and **$0.3563 of completed work was
 * discarded** — including the what-changed, the claims, and the do-not-say list, none
 * of which had anything wrong with them. Structured outputs do not carry `maxLength`,
 * so the model could not see the bound it was breaking.
 *
 * The prompt asks for one sentence; the schema tolerates a model that wrote one long
 * one; `composeDrafts` enforces the limit that actually matters. Rejection stays
 * reserved for things that are genuinely wrong — shape, evidence ids, provenance.
 */
export const draftMaterialSchema = z
  .object({
    /** The most surprising true thing, stated flatly. No adjectives doing the work. */
    hook: z.string().min(1).max(600),
    /** The concrete detail that makes it real: a version, a number, a name, a price. */
    substance: z.string().min(1).max(800),
    /** Why someone who ships software should care. One clause, no hedging. */
    soWhat: z.string().min(1).max(600),
    /**
     * Something the operator could verify himself in under an hour, if anything.
     * Empty when the event is not testable — an invented experiment is worse than none.
     */
    testableClaim: z.string().max(600),
  })
  .strict();

export type DraftMaterial = z.infer<typeof draftMaterialSchema>;

/**
 * What visual would make the post carry original evidence rather than commentary.
 *
 * `none` is a first-class answer and the correct one most of the time. A system that
 * always recommends a video teaches the operator to ignore the recommendation.
 */
export const mediaIdeaSchema = z
  .object({
    kind: z.enum(MEDIA_KINDS),
    /** Concretely what is on screen. "A chart" is not an answer; "p50 latency before and after" is. */
    whatToShow: z.string().max(600),
    /** Where the raw material comes from — a specific page, endpoint, or command. */
    sourceHint: z.string().max(300),
  })
  .strict();

export type MediaIdea = z.infer<typeof mediaIdeaSchema>;

export const analysisSchema = z
  .object({
    whatHappened: z.string().min(1).max(2500),
    whatChanged: z.string().min(1).max(2500),
    before: z.string().max(1200),
    after: z.string().max(1200),
    implications: z
      .array(
        z
          .object({
            audience: z.string().min(1).max(80),
            implication: z.string().min(1).max(1200),
          })
          .strict(),
      )
      .max(6),
    claims: z.array(claimSchema).max(20),
    /** What is NOT known. An analysis with no unknowns is usually overconfident. */
    stillUnknown: z.array(z.string().min(1).max(600)).max(10),
    confidence: z.enum(CONFIDENCE_LEVELS),
    recommendedAction: z.enum(RECOMMENDED_ACTIONS),
    /**
     * The do-not-say list.
     *
     * `ROADMAP.md` §8: claims the operator must not make about this event — things
     * that sound reasonable, are not supported by the evidence, and would cost him
     * credibility. Generated *with* the analysis because that is when the tempting
     * overstatements are visible.
     */
    doNotSay: z.array(z.string().min(1).max(600)).max(10),
    /** Lines for `composeDrafts` to assemble. See `draftMaterialSchema`. */
    draftMaterial: draftMaterialSchema,
    /** Which legitimate attention dynamics apply, and why. Drivers may be empty. */
    attentionDrivers: z.array(z.enum(ATTENTION_DRIVERS)).max(6),
    attentionReason: z.string().max(600),
    mediaIdea: mediaIdeaSchema,
    injectionObserved: z.boolean(),
    injectionNote: z.string().max(1000),
  })
  .strict();

export type Analysis = z.infer<typeof analysisSchema>;

/**
 * JSON Schema for the API's `output_config.format`.
 *
 * Hand-written rather than generated. Structured outputs reject several JSON Schema
 * keywords a generator emits by default (`minLength`, `maxLength`, `minimum`, …), and
 * a generated schema that silently loses `additionalProperties: false` would remove
 * the §T-1 control without any test noticing. The bound checks live in Zod, which
 * runs on the response.
 */
export const TRIAGE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    isRealEvent: { type: 'boolean' },
    category: { type: 'string', enum: [...EVENT_CATEGORIES] },
    oneLine: { type: 'string' },
    worthDeepAnalysis: { type: 'boolean' },
    reason: { type: 'string' },
    injectionObserved: { type: 'boolean' },
    injectionNote: { type: 'string' },
  },
  required: [
    'isRealEvent',
    'category',
    'oneLine',
    'worthDeepAnalysis',
    'reason',
    'injectionObserved',
    'injectionNote',
  ],
  additionalProperties: false,
} as const;

export const ANALYSIS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    whatHappened: { type: 'string' },
    whatChanged: { type: 'string' },
    before: { type: 'string' },
    after: { type: 'string' },
    implications: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          audience: { type: 'string' },
          implication: { type: 'string' },
        },
        required: ['audience', 'implication'],
        additionalProperties: false,
      },
    },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          evidenceIds: { type: 'array', items: { type: 'string' } },
          tag: { type: 'string', enum: [...EVIDENCE_TAGS] },
        },
        required: ['text', 'evidenceIds', 'tag'],
        additionalProperties: false,
      },
    },
    stillUnknown: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'string', enum: [...CONFIDENCE_LEVELS] },
    recommendedAction: { type: 'string', enum: [...RECOMMENDED_ACTIONS] },
    doNotSay: { type: 'array', items: { type: 'string' } },
    draftMaterial: {
      type: 'object',
      properties: {
        hook: { type: 'string' },
        substance: { type: 'string' },
        soWhat: { type: 'string' },
        testableClaim: { type: 'string' },
      },
      required: ['hook', 'substance', 'soWhat', 'testableClaim'],
      additionalProperties: false,
    },
    attentionDrivers: { type: 'array', items: { type: 'string', enum: [...ATTENTION_DRIVERS] } },
    attentionReason: { type: 'string' },
    mediaIdea: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...MEDIA_KINDS] },
        whatToShow: { type: 'string' },
        sourceHint: { type: 'string' },
      },
      required: ['kind', 'whatToShow', 'sourceHint'],
      additionalProperties: false,
    },
    injectionObserved: { type: 'boolean' },
    injectionNote: { type: 'string' },
  },
  required: [
    'whatHappened',
    'whatChanged',
    'before',
    'after',
    'implications',
    'claims',
    'stillUnknown',
    'confidence',
    'recommendedAction',
    'doNotSay',
    'draftMaterial',
    'attentionDrivers',
    'attentionReason',
    'mediaIdea',
    'injectionObserved',
    'injectionNote',
  ],
  additionalProperties: false,
} as const;
