import {
  openDatabase,
  runMigrations,
  seedAll,
  MIGRATIONS_FOLDER,
  loadScorableEvents,
} from '@signal-desk/db';
import { ConfigError } from '@signal-desk/shared';
import { bootstrap } from '../bootstrap.js';
import { renderTable } from '../table.js';

/**
 * `pnpm latency` — measured detection latency.
 *
 * `ROADMAP.md` Phase 13 exit criterion: "measured `event_occurred → detected` and
 * `detected → actionable` medians written into this document."
 *
 * This is the one Phase 13 criterion measurable without live credentials, because the
 * ingested corpus already carries publisher timestamps and fetch timestamps. It is a
 * real measurement of the system's speed, not a projection.
 *
 * ## Why the median and not the mean
 *
 * A backfill pulls archives, so the mean is dominated by items that were years old
 * when first fetched. The median answers the question the operator actually has —
 * "how late am I, usually" — and the percentiles show the tail.
 */

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

function main(): number {
  let boot;
  try {
    boot = bootstrap({ loggerName: 'latency' });
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

    const all: { hours: number; estimated: boolean }[] = [];
    const PAGE = 2000;
    for (let after = 0; ;) {
      const batch = loadScorableEvents(handle.db, PAGE, after);
      if (batch.length === 0) break;
      for (const row of batch) {
        all.push({
          hours: (row.firstSeenAt.getTime() - row.eventOccurredAt.getTime()) / 3_600_000,
          estimated: row.occurredAtIsEstimated,
        });
      }
      after = batch[batch.length - 1]?.id ?? after;
      if (batch.length < PAGE) break;
    }

    if (all.length === 0) {
      console.log('\nno events — run `pnpm ingest` first\n');
      return 0;
    }

    // Events whose publisher gave no timestamp are EXCLUDED, not defaulted. Their
    // occurredAt is an estimate, so a latency computed from it measures the estimate
    // rather than the system — and including them would quietly improve the number.
    const dated = all.filter((entry) => !entry.estimated);

    // Backfill items were years old when first fetched. They say nothing about how
    // fast the system detects NEW things, which is what the criterion asks.
    const fresh = dated
      .filter((entry) => entry.hours >= 0 && entry.hours <= 168)
      .map((e) => e.hours);
    fresh.sort((a, b) => a - b);

    console.log('\nDETECTION LATENCY — event_occurred → detected\n');
    console.log(`  events total:          ${String(all.length)}`);
    console.log(
      `  with a real timestamp: ${String(dated.length)}  (${String(all.length - dated.length)} excluded — publisher gave none, so latency would measure our estimate)`,
    );
    console.log(
      `  detected within 7d:    ${String(fresh.length)}  (the rest were archive backfill, which says nothing about detection speed)\n`,
    );

    if (fresh.length === 0) {
      console.log('  Nothing was detected inside the 7-day window. That is the measurement.\n');
      return 0;
    }

    console.log(
      renderTable(
        ['PERCENTILE', 'HOURS', 'READS AS'],
        (
          [
            ['p50 (median)', 0.5],
            ['p75', 0.75],
            ['p90', 0.9],
            ['p99', 0.99],
          ] as const
        ).map(([label, fraction]) => {
          const hours = percentile(fresh, fraction);
          return [
            label,
            hours.toFixed(1),
            hours < 1
              ? 'under an hour'
              : hours < 6
                ? 'same morning'
                : hours < 24
                  ? 'same day'
                  : `${(hours / 24).toFixed(1)} days`,
          ];
        }),
        ['left', 'right', 'left'],
      ),
    );
    console.log('');
    console.log(
      `  fastest: ${(fresh[0] ?? 0).toFixed(2)}h    slowest in window: ${(fresh[fresh.length - 1] ?? 0).toFixed(1)}h\n`,
    );

    console.log('WHAT THIS DOES NOT MEASURE');
    console.log('  `detected → actionable` needs the analysis tier, which needs credentials.');
    console.log('  These figures also come from a backfill run, not from continuous polling —');
    console.log('  a live schedule would detect faster, and that number is not in hand yet.\n');

    return 0;
  } finally {
    handle.close();
  }
}

process.exit(main());
