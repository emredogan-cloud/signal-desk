import {
  openDatabase,
  runMigrations,
  seedAll,
  MIGRATIONS_FOLDER,
  loadScorableEvents,
  loadEntityRegistryRows,
} from '@signal-desk/db';
import {
  replay,
  compareReplays,
  entityRelevanceMap,
  BASELINE,
  type ReplayEvent,
  type WeightOverride,
} from '@signal-desk/core';
import { ConfigError, type SourceCategory } from '@signal-desk/shared';
import { bootstrap } from '../bootstrap.js';
import { renderTable } from '../table.js';

/**
 * `pnpm replay` — offline weight exploration at $0 API cost.
 *
 * `ROADMAP.md` Phase 12 acceptance: "Offline replay runs over ≥3 months of history at
 * **$0 API cost**." Nothing here touches the network; it is pure computation over the
 * immutable `raw_items` corpus.
 *
 * What it CANNOT do is choose between candidates. That needs measured outcomes, and
 * outcomes need posts. This narrows the field; it does not decide.
 */

const CANDIDATES: WeightOverride[] = [
  BASELINE,
  {
    name: 'relevance-led',
    importanceMultiplier: 0.8,
    relevanceMultiplier: 1.25,
    minCombined: undefined,
    maxAgeDays: undefined,
  },
  {
    name: 'importance-led',
    importanceMultiplier: 1.25,
    relevanceMultiplier: 0.8,
    minCombined: undefined,
    maxAgeDays: undefined,
  },
  {
    name: 'stricter-floor',
    importanceMultiplier: 1,
    relevanceMultiplier: 1,
    minCombined: 45,
    maxAgeDays: undefined,
  },
  {
    name: 'fresh-only-48h',
    importanceMultiplier: 1,
    relevanceMultiplier: 1,
    minCombined: undefined,
    maxAgeDays: 2,
  },
];

function main(): number {
  let boot;
  try {
    boot = bootstrap({ loggerName: 'replay' });
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`\n${error.message}\n`);
      return 1;
    }
    throw error;
  }

  const handle = openDatabase({ url: boot.config.DATABASE_URL });

  try {
    runMigrations(handle, MIGRATIONS_FOLDER);
    seedAll(handle.db);

    const registry = loadEntityRegistryRows(handle.db);
    const context = { entityRelevance: entityRelevanceMap(registry.entities) };

    // The corpus is drained by cursor. A LIMIT read as a ceiling has already bitten
    // this project twice (Phase 5 pipeline, Phase 11 latestScores).
    const corpus: ReplayEvent[] = [];
    const PAGE = 2000;
    for (let after = 0; ;) {
      const batch = loadScorableEvents(handle.db, PAGE, after);
      if (batch.length === 0) break;
      for (const row of batch) {
        corpus.push({
          event: {
            id: row.id,
            title: row.title,
            summary: row.summary,
            category: row.category,
            entities: row.entities,
            artifacts: row.artifacts,
            eventOccurredAt: row.eventOccurredAt,
            occurredAtIsEstimated: row.occurredAtIsEstimated,
            firstSeenAt: row.firstSeenAt,
            injectionFlagged: row.injectionFlagged,
            evidence: row.evidence.map((item) => ({
              sourceId: item.sourceId,
              sourceCategory: item.sourceCategory as SourceCategory,
              isOfficial: item.isOfficial,
              reliability: item.reliability,
              publishedAt: item.publishedAt,
            })),
          },
          // The instant the LIVE run scored it. Replaying against today's date would
          // re-age every event and make the comparison meaningless.
          scoredAt: row.firstSeenAt,
          sourceIds: row.evidence.map((item) => item.sourceId),
        });
      }
      after = batch[batch.length - 1]?.id ?? after;
      if (batch.length < PAGE) break;
    }

    if (corpus.length === 0) {
      console.log('\nno events to replay — run `pnpm ingest` first\n');
      return 0;
    }

    // Report the span honestly. The raw min-to-max was 9,375 days — 25 years — which
    // is driven by a handful of items with implausible publisher dates, not by the
    // corpus actually covering a quarter-century. Quoting that number would overstate
    // the history by two orders of magnitude, so both figures are shown.
    const times = corpus.map((e) => e.event.eventOccurredAt.getTime()).sort((a, b) => a - b);
    const at = (fraction: number): number => times[Math.floor((times.length - 1) * fraction)] ?? 0;
    const fullSpanDays = ((times[times.length - 1] ?? 0) - (times[0] ?? 0)) / 86_400_000;
    const coreSpanDays = (at(0.95) - at(0.05)) / 86_400_000;

    console.log(`\nOFFLINE REPLAY — $0 API COST (nothing here touches the network)\n`);
    console.log(
      `  corpus:  ${String(corpus.length)} events; middle 90% spans ${coreSpanDays.toFixed(0)} days ` +
        `(full range ${fullSpanDays.toFixed(0)} days, inflated by a few implausible publisher dates)`,
    );
    console.log(`  candidates: ${String(CANDIDATES.length)}\n`);

    const results = CANDIDATES.map((candidate) => replay(corpus, context, candidate));
    const baseline = results[0];
    if (baseline === undefined) return 1;

    console.log(
      renderTable(
        ['CANDIDATE', 'SURFACED', 'KILL RATE', 'vs BASE +', 'vs BASE −', 'AGREEMENT'],
        results.map((result) => {
          const comparison = compareReplays(baseline, result);
          return [
            result.candidate,
            String(result.passed),
            `${(result.killRate * 100).toFixed(1)}%`,
            String(comparison.newlySurfaced.length),
            String(comparison.noLongerSurfaced.length),
            `${(comparison.agreement * 100).toFixed(0)}%`,
          ];
        }),
        ['left', 'right', 'right', 'right', 'right', 'right'],
      ),
    );
    console.log('');

    console.log('WHAT THIS DOES AND DOES NOT SHOW');
    console.log('  It shows which events each candidate WOULD have surfaced.');
    console.log('  It does not show whether those were the right events — that needs');
    console.log('  measured outcomes, and outcomes need posts. Replay narrows the');
    console.log('  candidates; only results choose between them.\n');

    return 0;
  } finally {
    handle.close();
  }
}

process.exit(main());
