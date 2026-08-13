import {
  openDatabase,
  runMigrations,
  seedAll,
  MIGRATIONS_FOLDER,
  latestScores,
  sourceHealthRows,
  listSources,
  envelopeItemsFor,
} from '@signal-desk/db';
import {
  freshnessAlerts,
  eventAlert,
  planAlerts,
  inQuietHours,
  strategyFromScore,
  type Alert,
} from '@signal-desk/core';
import { deliver } from '@signal-desk/adapters';
import { ConfigError } from '@signal-desk/shared';
import { bootstrap } from '../bootstrap.js';

/**
 * `pnpm alerts` — decide what is worth interrupting the operator for, and deliver it.
 *
 * Reports what it SUPPRESSED as well as what it sent. `ROADMAP.md` Phase 11's failure
 * mode is noise, and a run that only reported sends would hide the tiering being
 * wrong until he muted the channel.
 */

async function main(): Promise<number> {
  const dryRun = process.argv.includes('--dry-run');

  let boot;
  try {
    boot = bootstrap({ loggerName: 'alerts' });
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`\n${error.message}\n`);
      return 1;
    }
    throw error;
  }

  const { config } = boot;
  const handle = openDatabase({ url: config.DATABASE_URL });

  try {
    runMigrations(handle, MIGRATIONS_FOLDER);
    seedAll(handle.db);

    const now = new Date();
    const priorityById = new Map(
      listSources(handle.db, { activeOnly: true }).map((source) => [source.id, source.priority]),
    );

    // ─── Freshness first. This is the alert that fires because NOTHING happened, and
    // a monitoring system that cannot detect its own blindness is worse than none.
    const freshness = freshnessAlerts(
      sourceHealthRows(handle.db).map((row) => ({
        sourceId: row.id,
        priority: priorityById.get(row.id) ?? 3,
        hoursSinceSuccess:
          row.lastSuccessAt === null
            ? null
            : (now.getTime() - row.lastSuccessAt.getTime()) / 3_600_000,
        consecutiveFailures: row.consecutiveFailures,
      })),
    );

    const events = latestScores(handle.db, 100, true)
      .map((row) => {
        // The recommendation comes from the strategy layer, via the shared helper.
        // An earlier version hard-coded 'POST_SOON' here, which meant the event alert
        // path could never fire — a second derivation of the same judgement that had
        // silently drifted from the real one.
        const strategy = strategyFromScore(row, envelopeItemsFor(handle.db, row.eventId), now);
        return eventAlert({
          eventId: row.eventId,
          title: row.title,
          combined: row.combined,
          confidence: row.confidence,
          recommendedAction: strategy.recommendation.action,
          manualFlag: strategy.recommendation.manualFlag,
          category: row.category,
        });
      })
      .filter((alert): alert is Alert => alert !== undefined);

    const candidates = [...freshness, ...events];

    const run = planAlerts(candidates, {
      minPriority: config.ALERT_MIN_PRIORITY,
      // Dedup state is per-run for now; Phase 14 persists it. Stated rather than
      // implied, because a reader would otherwise assume alerts dedupe across runs.
      alreadySent: new Set(),
      sentToday: 0,
      now,
      quietHours: inQuietHours(now),
    });

    console.log(
      `\nALERTS  (min priority: ${config.ALERT_MIN_PRIORITY}${inQuietHours(now) ? ', QUIET HOURS' : ''})`,
    );
    console.log(`  candidates: ${String(candidates.length)}`);
    console.log(`  sending:    ${String(run.sent.length)}`);
    console.log(`  suppressed: ${String(run.suppressed.length)}\n`);

    if (Object.keys(run.byReason).length > 0) {
      console.log('SUPPRESSED BY');
      for (const [reason, count] of Object.entries(run.byReason).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(count).padStart(4)}  ${reason}`);
      }
      console.log('');
    }

    if (run.sent.length === 0) {
      console.log('Nothing worth interrupting him for. That is the normal outcome.\n');
      return 0;
    }

    for (const alert of run.sent) {
      if (dryRun) {
        console.log(`[DRY RUN] [${alert.tier.toUpperCase()}] ${alert.title}`);
        continue;
      }
      const result = await deliver(
        alert,
        // ntfy.sh is the public instance and the only server this config knows about.
        // A self-hosted server is a Phase 14 concern; hard-coding it here is honest
        // about what is actually supported today.
        { topic: config.NTFY_TOPIC, server: 'https://ntfy.sh' },
        (line) => {
          console.log(line);
        },
      );
      if (result.delivered === 'console') console.log(`         (${result.reason})`);
    }
    console.log('');

    return 0;
  } finally {
    handle.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
