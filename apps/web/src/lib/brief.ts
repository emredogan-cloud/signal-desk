import 'server-only';
import {
  openDatabase,
  latestScores,
  latestAnalysisFor,
  envelopeItemsFor,
  type Db,
} from '@signal-desk/db';
import {
  assessAttention,
  buildStrategy,
  composeDrafts,
  planMedia,
  TESTABLE_ENTITIES,
  type AttentionAssessment,
  type Draft,
  type MediaPlan,
  type Strategy,
} from '@signal-desk/core';
import {
  ATTENTION_DRIVERS,
  MEDIA_KINDS,
  type AttentionDriver,
  type MediaKind,
} from '@signal-desk/shared';
import { serverConfig } from './env';

/**
 * The decision brief: everything the operator needs about one event, assembled.
 *
 * ## Why this file exists separately from `data.ts`
 *
 * `data.ts` answers "what is on the list". This answers "what do I do about this one",
 * and the two have very different costs — the brief joins the analysis payload, runs
 * the strategy engine, composes drafts, and plans media. Doing that for forty list rows
 * to render one detail panel would be forty times the work for one fortieth of the
 * value.
 *
 * ## Every field below was already being produced and none of it was being read
 *
 * The pre-rebuild dashboard rendered a title, a score, and a recommendation. The
 * analysis column already contained what changed, before/after, per-audience
 * implications, evidence-tagged claims, and the do-not-say list; the strategy engine
 * already produced angles, five scored options, and the why-now/why-me panel. The
 * rebuild is mostly an act of surfacing, not of generation.
 *
 * ## Validating the stored payload
 *
 * `latestAnalysisFor` returns `payload: unknown` deliberately. It was written by a
 * model that had just read untrusted third-party content, and it has been sitting in
 * SQLite since. Everything below reads it defensively — a missing field renders as an
 * absent section, never as `undefined` on screen and never as a thrown render.
 */

export type Implication = { readonly audience: string; readonly implication: string };
export type Claim = { readonly text: string; readonly tag: string };

export type Brief = {
  readonly eventId: number;
  readonly title: string;
  readonly category: string;
  readonly entities: readonly string[];
  readonly occurredAt: Date;
  readonly hoursSince: number;
  readonly importance: number;
  readonly brandRelevance: number;
  readonly combined: number;
  readonly confidence: string;
  readonly evidenceTag: string;
  readonly distinctSourceCount: number;
  readonly gatePassed: boolean;
  readonly gateReason: string;

  /** Present only when a deep analysis exists. Most events never reach one. */
  readonly analysed: boolean;
  readonly whatHappened: string;
  readonly whatChanged: string;
  readonly before: string;
  readonly after: string;
  readonly implications: readonly Implication[];
  readonly claims: readonly Claim[];
  readonly stillUnknown: readonly string[];
  readonly doNotSay: readonly string[];
  readonly injectionObserved: boolean;

  readonly strategy: Strategy;
  readonly attention: AttentionAssessment;
  readonly drafts: readonly Draft[];
  readonly media: MediaPlan | undefined;

  readonly sources: readonly {
    readonly sourceId: string;
    readonly title: string;
    readonly url: string;
    readonly isOfficial: boolean;
  }[];
};

/** Narrow an unknown JSON value to a string, or ''. Never throws, never returns undefined. */
function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function strArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function readImplications(value: unknown): Implication[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => record(entry))
    .map((entry) => ({ audience: str(entry.audience), implication: str(entry.implication) }))
    .filter((entry) => entry.audience !== '' && entry.implication !== '');
}

function readClaims(value: unknown): Claim[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => record(entry))
    .map((entry) => ({ text: str(entry.text), tag: str(entry.tag) }))
    .filter((entry) => entry.text !== '');
}

/** Only accept driver strings the enum actually declares — the payload is untrusted. */
function readDrivers(value: unknown): AttentionDriver[] {
  const allowed = new Set<string>(ATTENTION_DRIVERS);
  return strArray(value).filter((entry): entry is AttentionDriver => allowed.has(entry));
}

function readMediaKind(value: unknown): MediaKind {
  const allowed = new Set<string>(MEDIA_KINDS);
  const kind = str(value);
  return allowed.has(kind) ? (kind as MediaKind) : 'none';
}

export function buildBrief(db: Db, eventId: number, now: Date): Brief | undefined {
  // `latestScores` is the only query that already assembles score + event + gate. Ask
  // it for a generous window and pick, rather than adding a by-id variant that would
  // duplicate its join and could drift from it.
  const row = latestScores(db, 400, false).find((candidate) => candidate.eventId === eventId);
  if (row === undefined) return undefined;

  const items = envelopeItemsFor(db, eventId);
  const analysis = latestAnalysisFor(db, eventId);
  const payload = record(analysis?.payload);
  const material = record(payload.draftMaterial);
  const mediaIdea = record(payload.mediaIdea);

  const hoursSince = Math.max(0, (now.getTime() - row.eventOccurredAt.getTime()) / 3_600_000);

  const breakdown = row.breakdown as { brandRelevance?: { name: string; value: number }[] } | null;
  const testability = breakdown?.brandRelevance?.find((c) => c.name === 'testability')?.value ?? 0;
  const testable =
    testability > 0.5 || row.entities.some((entity) => (TESTABLE_ENTITIES[entity] ?? 0) >= 0.8);

  const whatChanged = str(payload.whatChanged);
  const before = str(payload.before);
  const after = str(payload.after);
  const stillUnknown = analysis?.stillUnknown ?? [];
  const doNotSay = analysis?.doNotSay ?? [];

  const strategy = buildStrategy({
    eventId: row.eventId,
    title: row.title,
    summary: str(payload.whatHappened),
    category: row.category,
    entities: row.entities,
    testable,
    hasVersionArtifact: items.some((item) => /v?\d+\.\d+|\bb\d{4,}\b/.test(item.title)),
    hasOfficialSource: items.some((item) => item.isOfficial),
    distinctSourceCount: row.distinctSourceCount,
    expertSourceCount: new Set(
      items.filter((item) => item.sourceCategory === 'EXPERT_ANALYST').map((item) => item.sourceId),
    ).size,
    stillUnknown,
    whatChanged,
    importance: row.importance,
    brandRelevance: row.brandRelevance,
    combined: row.combined,
    confidence: row.confidence,
    hoursSinceEvent: hoursSince,
    doNotSay,
    injectionFlagged: analysis?.injectionObserved ?? false,
  });

  const attention = assessAttention({
    drivers: readDrivers(payload.attentionDrivers),
    modelReason: str(payload.attentionReason),
    hoursSinceEvent: hoursSince,
    distinctSourceCount: row.distinctSourceCount,
  });

  const testableClaim = str(material.testableClaim);

  const drafts = composeDrafts({
    title: row.title,
    hook: str(material.hook),
    substance: str(material.substance),
    soWhat: str(material.soWhat),
    testableClaim,
    before,
    after,
    doNotSay,
    recommendedOption: strategy.recommendation.option,
    hasOfficialSource: items.some((item) => item.isOfficial),
    testable,
    hoursSinceEvent: hoursSince,
  });

  const media = planMedia({
    kind: readMediaKind(mediaIdea.kind),
    whatToShow: str(mediaIdea.whatToShow),
    sourceHint: str(mediaIdea.sourceHint),
    title: row.title,
    before,
    after,
    testable,
    testableClaim,
  });

  return {
    eventId: row.eventId,
    title: row.title,
    category: row.category,
    entities: row.entities,
    occurredAt: row.eventOccurredAt,
    hoursSince,
    importance: row.importance,
    brandRelevance: row.brandRelevance,
    combined: row.combined,
    confidence: row.confidence,
    evidenceTag: row.evidenceTag,
    distinctSourceCount: row.distinctSourceCount,
    gatePassed: row.gatePassed,
    gateReason: row.gateReason,

    analysed: analysis !== undefined,
    whatHappened: str(payload.whatHappened),
    whatChanged,
    before,
    after,
    implications: readImplications(payload.implications),
    claims: readClaims(payload.claims),
    stillUnknown,
    doNotSay,
    injectionObserved: analysis?.injectionObserved ?? false,

    strategy,
    attention,
    drafts,
    media,

    sources: items.slice(0, 8).map((item) => ({
      sourceId: item.sourceId,
      title: item.title,
      url: item.url,
      isOfficial: item.isOfficial,
    })),
  };
}

/** Open, build one brief, close. The dashboard is one reader at one concurrent user. */
export function brief(eventId: number): Brief | undefined {
  const config = serverConfig();
  const handle = openDatabase({ url: config.DATABASE_URL });
  try {
    return buildBrief(handle.db, eventId, new Date());
  } catch (error) {
    // A missing schema is legitimate — the worker owns migrations and may not have run.
    if (error instanceof Error && /no such table/i.test(error.message)) return undefined;
    throw error;
  } finally {
    handle.close();
  }
}
