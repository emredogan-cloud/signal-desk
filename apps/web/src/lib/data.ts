import 'server-only';
import {
  openDatabase,
  latestScores,
  gateKillRate,
  spendSince,
  spendBreakdown,
  allTrends,
  observationsFor,
  envelopeItemsFor,
  sourceHealthRows,
} from '@signal-desk/db';
import { deriveEffectiveModes } from '@signal-desk/shared';
import { serverConfig } from './env';
import {
  buildStrategy,
  buildTrendCard,
  TESTABLE_ENTITIES,
  type Strategy,
  type TrendPlatform,
} from '@signal-desk/core';

/**
 * The dashboard's data layer. **Server-only.**
 *
 * `server-only` is a build-time guard, not a comment: importing this from a client
 * component fails the build rather than shipping a database handle to the browser.
 *
 * Every function here opens the database, reads, and closes. That is deliberately
 * unsophisticated — this is a single-operator dashboard on `127.0.0.1` reading a
 * local SQLite file, and a connection pool would add a failure mode to solve a
 * problem that does not exist at one concurrent user.
 */

export type StreamRow = {
  eventId: number;
  title: string;
  category: string;
  entities: string[];
  occurredAt: Date;
  importance: number;
  brandRelevance: number;
  combined: number;
  confidence: string;
  evidenceTag: string;
  distinctSourceCount: number;
  gatePassed: boolean;
  gateReason: string;
  caps: string[];
  breakdown: unknown;
  strategy: Strategy;
};

/**
 * Open the database **read-only in spirit**: no migrations, no seeding.
 *
 * The dashboard is a reader; the worker owns the schema. Migrating on page load would
 * mean a browser refresh could alter the schema while the worker is mid-write, which
 * is a data-corruption path opened for no benefit.
 *
 * It also removes a build problem worth recording: `MIGRATIONS_FOLDER` is computed
 * from `import.meta.url`, and Turbopack tries to statically resolve that as a module
 * specifier, failing the build. Dropping the call was the right fix on the merits and
 * happened to fix the build too — the reverse order would have been a workaround.
 *
 * `serverConfig()` rather than `parseConfig(process.env)`: the dashboard runs with its
 * working directory in `apps/web`, so both the `.env` file and a relative
 * `DATABASE_URL` have to be anchored to the repository root explicitly. See
 * `lib/env.ts` for the empty-dashboard defect that cost.
 */
function open() {
  const config = serverConfig();
  const handle = openDatabase({ url: config.DATABASE_URL });
  return { handle, config };
}

/**
 * Run a read, or report that the schema is not there.
 *
 * The dashboard does not migrate (see `open`), so it can legitimately start before
 * the worker has ever run. The first attempt crashed with a raw
 * `SqliteError: no such table: event_scores` and a Next error page, which tells the
 * operator nothing about what to do. A reader that depends on a writer having run has
 * to say so.
 */
function readOr<T>(fallback: T, read: () => T): { value: T; schemaMissing: boolean } {
  try {
    return { value: read(), schemaMissing: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such table/i.test(message)) return { value: fallback, schemaMissing: true };
    throw error;
  }
}

export function schemaReady(): boolean {
  const { handle } = open();
  try {
    return !readOr<unknown[]>([], () => latestScores(handle.db, 1, false)).schemaMissing;
  } finally {
    handle.close();
  }
}

export function modes() {
  return deriveEffectiveModes(serverConfig());
}

/** The live intelligence stream — gate survivors, ranked. */
export function stream(limit = 40): StreamRow[] {
  const { handle } = open();
  try {
    const now = new Date();
    return readOr<StreamRow[]>([], () =>
      latestScores(handle.db, limit, true).map((row) => {
        const items = envelopeItemsFor(handle.db, row.eventId);
        const breakdown = row.breakdown as {
          brandRelevance?: { name: string; value: number }[];
        } | null;
        const testability =
          breakdown?.brandRelevance?.find((c) => c.name === 'testability')?.value ?? 0;

        const strategy = buildStrategy({
          eventId: row.eventId,
          title: row.title,
          summary: '',
          category: row.category,
          entities: row.entities,
          testable:
            testability > 0.5 || row.entities.some((e) => (TESTABLE_ENTITIES[e] ?? 0) >= 0.8),
          hasVersionArtifact: items.some((i) => /v?\d+\.\d+|\bb\d{4,}\b/.test(i.title)),
          hasOfficialSource: items.some((i) => i.isOfficial),
          distinctSourceCount: row.distinctSourceCount,
          expertSourceCount: new Set(
            items.filter((i) => i.sourceCategory === 'EXPERT_ANALYST').map((i) => i.sourceId),
          ).size,
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

        return {
          eventId: row.eventId,
          title: row.title,
          category: row.category,
          entities: row.entities,
          occurredAt: row.eventOccurredAt,
          importance: row.importance,
          brandRelevance: row.brandRelevance,
          combined: row.combined,
          confidence: row.confidence,
          evidenceTag: row.evidenceTag,
          distinctSourceCount: row.distinctSourceCount,
          gatePassed: row.gatePassed,
          gateReason: row.gateReason,
          caps: row.caps,
          breakdown: row.breakdown,
          strategy,
        };
      }),
    ).value;
  } finally {
    handle.close();
  }
}

export type Health = {
  sources: {
    id: string;
    lastSuccessAt: Date | null;
    consecutiveFailures: number;
    hoursSinceSuccess: number | null;
  }[];
  deadSources: number;
  gate: { total: number; killed: number; killRate: number; inWindowKillRate: number };
  costTodayUsd: number;
  cacheReadTokens: number;
  callsToday: number;
};

const EMPTY_HEALTH: Health = {
  sources: [],
  deadSources: 0,
  gate: { total: 0, killed: 0, killRate: 0, inWindowKillRate: 0 },
  costTodayUsd: 0,
  cacheReadTokens: 0,
  callsToday: 0,
};

export function health(): Health {
  const { handle } = open();
  try {
    return readOr<Health>(EMPTY_HEALTH, () => {
      const now = new Date();
      const dayStart = new Date(now);
      dayStart.setUTCHours(0, 0, 0, 0);

      const sources = sourceHealthRows(handle.db).map((row) => ({
        id: row.id,
        lastSuccessAt: row.lastSuccessAt,
        consecutiveFailures: row.consecutiveFailures,
        hoursSinceSuccess:
          row.lastSuccessAt === null
            ? null
            : (now.getTime() - row.lastSuccessAt.getTime()) / 3_600_000,
      }));

      const breakdown = spendBreakdown(handle.db, dayStart);
      const gate = gateKillRate(handle.db);

      return {
        sources,
        // A source silent for more than 48h is dead until proven otherwise. The health
        // panel's job is to make this obvious WITHOUT being looked for.
        deadSources: sources.filter((s) => s.hoursSinceSuccess === null || s.hoursSinceSuccess > 48)
          .length,
        gate: {
          total: gate.total,
          killed: gate.killed,
          killRate: gate.killRate,
          inWindowKillRate: gate.inWindowKillRate,
        },
        costTodayUsd: spendSince(handle.db, dayStart),
        cacheReadTokens: breakdown.reduce((sum, row) => sum + row.cacheReads, 0),
        callsToday: breakdown.reduce((sum, row) => sum + row.calls, 0),
      };
    }).value;
  } finally {
    handle.close();
  }
}

export function trendCards() {
  const { handle } = open();
  try {
    const now = new Date();
    return readOr<ReturnType<typeof buildTrendCard>[]>([], () =>
      allTrends(handle.db).map((row) =>
        buildTrendCard(
          {
            name: row.name,
            platform: row.platform as TrendPlatform,
            mechanism: row.mechanism ?? undefined,
            howToParticipate: row.howToParticipate ?? undefined,
            originalVersion: row.originalVersion ?? undefined,
          },
          observationsFor(handle.db, row.id).map((o) => ({
            observedAt: o.observedAt,
            mentionCount: o.mentionCount,
            distinctSources: o.distinctSources,
            manual: o.manual,
            note: o.note,
          })),
          now,
        ),
      ),
    ).value;
  } finally {
    handle.close();
  }
}
