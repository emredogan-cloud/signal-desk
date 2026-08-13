import {
  openDatabase,
  runMigrations,
  seedAll,
  MIGRATIONS_FOLDER,
  loadEntityRegistryRows,
  loadScorableEvents,
  insertScores,
  clearScores,
  gateKillRate,
  latestScores,
  type ScorableRow,
} from '@signal-desk/db';
import { scoreEvent, applyGate, entityRelevanceMap, type ScorableEvent } from '@signal-desk/core';
import { ConfigError, type SourceCategory } from '@signal-desk/shared';
import { bootstrap } from '../bootstrap.js';
import { renderTable } from '../table.js';

/**
 * `pnpm score` — score every event and apply the rule gate.
 *
 * Deterministic and free. No credentials, no network, no model. The gate kill rate it
 * prints is ROADMAP.md Phase 5's acceptance measurement (target ≥85%).
 */

function toScorable(row: ScorableRow): ScorableEvent {
  return {
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
  };
}

function main(): number {
  const rescore = process.argv.includes('--rescore');
  const top = process.argv.includes('--top');

  let boot;
  try {
    boot = bootstrap({ loggerName: 'score' });
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
    const now = new Date();

    if (rescore) {
      console.log('\n--rescore: discarding stored scores (they are derived; recompute)');
      clearScores(handle.db);
    }

    // Drain by cursor. The pipeline learned this lesson the expensive way: a query
    // LIMIT read as a ceiling silently processed 5,000 of 5,208 items and reported
    // success.
    const PAGE = 2000;
    let scored = 0;
    for (let after = 0; ;) {
      const batch = loadScorableEvents(handle.db, PAGE, after);
      if (batch.length === 0) break;

      const rows = batch.map((row) => {
        const event = toScorable(row);
        const scores = scoreEvent(event, context, now);
        const gate = applyGate(event, scores, {
          sourceIds: row.evidence.map((item) => item.sourceId),
          now,
        });

        return {
          eventId: row.id,
          importance: scores.importance.value,
          brandRelevance: scores.brandRelevance.value,
          velocity: scores.velocity.value,
          combined: scores.combined,
          confidence: scores.confidence.level,
          evidenceTag: scores.confidence.tag,
          breakdown: {
            importance: scores.importance.components,
            brandRelevance: scores.brandRelevance.components,
            velocity: scores.velocity.components,
            confidence: scores.confidence.components,
          },
          caps: [...scores.confidence.caps],
          gatePassed: gate.passed,
          gateKilledBy: gate.killedBy ?? null,
          gateReason: gate.reason,
          scoredWith: scores.scoredWith,
        };
      });

      scored += insertScores(handle.db, rows, now);
      after = batch[batch.length - 1]?.id ?? after;
      if (batch.length < PAGE) break;
    }

    const stats = gateKillRate(handle.db);

    console.log(`\nscored ${String(scored)} event(s)\n`);
    console.log('RULE GATE');
    console.log(`  total      ${String(stats.total)}`);
    console.log(`  passed     ${String(stats.passed)}  (these would reach the LLM)`);
    console.log(`  killed     ${String(stats.killed)}`);
    console.log(
      `  kill rate  ${(stats.killRate * 100).toFixed(1)}%  ` +
        `${stats.killRate >= 0.85 ? '✅ meets the ≥85% target' : '⚠️  BELOW the ≥85% target'}`,
    );
    console.log('');
    console.log('  Excluding the staleness rule — the steady-state proxy, because the first');
    console.log('  ingest backfilled whole archives and an overall rate flatters the gate:');
    console.log(
      `    in-window   ${String(stats.inWindowTotal)} event(s), ${String(stats.inWindowKilled)} killed ` +
        `= ${(stats.inWindowKillRate * 100).toFixed(1)}%  ` +
        `${stats.inWindowKillRate >= 0.85 ? '✅' : '⚠️  below target'}`,
    );
    console.log('');

    if (stats.byRule.length > 0) {
      console.log(
        renderTable(
          ['RULE', 'KILLED', 'SHARE'],
          stats.byRule.map((row) => [
            row.rule,
            String(row.n),
            `${((row.n / Math.max(stats.total, 1)) * 100).toFixed(1)}%`,
          ]),
          ['left', 'right', 'right'],
        ),
      );
      console.log('');
    }

    if (top) {
      const rows = latestScores(handle.db, 20, true);
      console.log('TOP 20 BY COMBINED SCORE  (the operator acceptance gate reviews this list)');
      console.log(
        renderTable(
          ['IMP', 'REL', 'COMB', 'CONF', 'TAG', 'SRC', 'TITLE'],
          rows.map((row) => [
            String(row.importance),
            String(row.brandRelevance),
            String(row.combined),
            row.confidence,
            row.evidenceTag,
            String(row.distinctSourceCount),
            row.title.slice(0, 62),
          ]),
          ['right', 'right', 'right', 'left', 'left', 'right', 'left'],
        ),
      );
      console.log('');
    }

    return 0;
  } finally {
    handle.close();
  }
}

process.exit(main());
