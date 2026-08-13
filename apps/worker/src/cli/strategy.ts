import {
  openDatabase,
  runMigrations,
  seedAll,
  MIGRATIONS_FOLDER,
  latestScores,
  envelopeItemsFor,
  loadEntityRegistryRows,
} from '@signal-desk/db';
import { strategyFromScore, summariseStrategies, type Strategy } from '@signal-desk/core';
import { ConfigError } from '@signal-desk/shared';
import { bootstrap } from '../bootstrap.js';
import { renderTable } from '../table.js';

/**
 * `pnpm strategy` — the five options and one recommendation per scored event.
 *
 * Measures the Phase 7 acceptance criterion directly: "≥30% of scored events over a
 * representative week receive DON'T POST or WAIT". Reported as a measurement over
 * real data, never asserted.
 */

function main(): number {
  const showTop = process.argv.includes('--top');
  const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
  const limit = limitArg === undefined ? 500 : Number(limitArg.slice('--limit='.length));

  let boot;
  try {
    boot = bootstrap({ loggerName: 'strategy' });
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
    const relevanceById = new Map(registry.entities.map((e) => [e.id, e.operatorRelevance]));
    void relevanceById;

    const now = new Date();
    // ─── Only gate survivors.
    //
    // The first measurement ran over all 5,000 scored events and reported 20.6%
    // restraint — but 4,942 of them had already been KILLED by the Phase 5 rule gate.
    // Asking "should he post about this?" of an event the pipeline already rejected
    // is a question with no meaning, and including the answers made the distribution
    // describe a population the operator never sees.
    const rows = latestScores(handle.db, limit, true);
    if (rows.length === 0) {
      console.log('\nno scored events — run `pnpm score` first\n');
      return 0;
    }

    const strategies: Strategy[] = rows.map((row) =>
      strategyFromScore(row, envelopeItemsFor(handle.db, row.eventId), now),
    );

    const stats = summariseStrategies(strategies);

    console.log(`\nstrategies for ${String(stats.total)} scored event(s)\n`);
    console.log('RECOMMENDATION DISTRIBUTION');
    console.log(
      renderTable(
        ['ACTION', 'N', 'SHARE'],
        Object.entries(stats.byAction)
          .sort((a, b) => b[1] - a[1])
          .map(([action, n]) => [action, String(n), `${((n / stats.total) * 100).toFixed(1)}%`]),
        ['left', 'right', 'right'],
      ),
    );
    console.log('');

    console.log(
      `RESTRAINT (DONT_POST + WAIT + VERIFY): ${(stats.restraintRate * 100).toFixed(1)}%  ` +
        `${stats.restraintRate >= 0.3 ? '✅ meets the ≥30% target' : '⚠️  BELOW the ≥30% target — a system that recommends action on everything has no judgment'}`,
    );
    console.log(
      `MANUAL FLAGS (accusations escalated for human review): ${String(stats.manualFlags)}\n`,
    );

    if (Object.keys(stats.byDontPostReason).length > 0) {
      console.log('WHY NOT TO POST');
      console.log(
        renderTable(
          ['REASON', 'N'],
          Object.entries(stats.byDontPostReason)
            .sort((a, b) => b[1] - a[1])
            .map(([reason, n]) => [reason, String(n)]),
          ['left', 'right'],
        ),
      );
      console.log('');
    }

    if (showTop) {
      const actionable = strategies
        .filter(
          (s) => s.recommendation.action === 'POST_NOW' || s.recommendation.action === 'POST_SOON',
        )
        .slice(0, 10);
      console.log(
        `TOP ${String(actionable.length)} ACTIONABLE  (the operator acceptance gate reviews these)`,
      );
      for (const strategy of actionable) {
        const row = rows.find((r) => r.eventId === strategy.eventId);
        console.log(`\n  [${strategy.recommendation.action}] ${row?.title.slice(0, 70) ?? ''}`);
        console.log(`    option:   ${strategy.recommendation.option ?? '-'}`);
        console.log(`    WHY NOW:  ${strategy.panel.whyNow}`);
        console.log(`    WHY ME:   ${strategy.panel.whyMe}`);
        console.log(`    ADD:      ${strategy.panel.whatCanIAdd.slice(0, 150)}`);
        console.log(`    OUTCOME:  ${strategy.panel.expectedOutcome}`);
      }
      console.log('');
    }

    return 0;
  } finally {
    handle.close();
  }
}

process.exit(main());
