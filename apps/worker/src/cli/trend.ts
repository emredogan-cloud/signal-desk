import {
  openDatabase,
  runMigrations,
  seedAll,
  MIGRATIONS_FOLDER,
  upsertTrend,
  addObservation,
  observationsFor,
  allTrends,
  updatePlacement,
} from '@signal-desk/db';
import { buildTrendCard, type TrendPlatform, type TrendObservation } from '@signal-desk/core';
import { ConfigError } from '@signal-desk/shared';
import { bootstrap } from '../bootstrap.js';
import { renderTable } from '../table.js';

/**
 * `pnpm trend` — manual trend entry and trajectory tracking.
 *
 * `ROADMAP.md` Phase 9: "**Manual trend entry is a first-class feature, not a
 * fallback.**" So this CLI is the primary interface, not a debugging aid: the
 * operator sees a format on X, records it here, and the system tracks what happens
 * next.
 *
 *   pnpm trend -- --add "name" --platform x --mentions 12 --sources 3
 *   pnpm trend -- --list
 */

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function main(): number {
  let boot;
  try {
    boot = bootstrap({ loggerName: 'trend' });
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
    const now = new Date();

    const name = arg('add');
    if (name !== undefined) {
      const platform = (arg('platform') ?? 'other') as TrendPlatform;
      const trendId = upsertTrend(
        handle.db,
        {
          name,
          platform,
          mechanism: arg('mechanism'),
          howToParticipate: arg('how'),
          originalVersion: arg('origin'),
        },
        now,
      );

      const mentions = Number(arg('mentions') ?? '1');
      const sources = Number(arg('sources') ?? '1');
      addObservation(handle.db, {
        trendId,
        observedAt: now,
        mentionCount: Number.isFinite(mentions) ? mentions : 1,
        distinctSources: Number.isFinite(sources) ? sources : 1,
        manual: true,
        note: arg('note') ?? '',
      });

      console.log(`\nrecorded an observation of "${name}" (${platform})\n`);
    }

    const rows = allTrends(handle.db);
    if (rows.length === 0) {
      console.log('\nno trends tracked yet.\n');
      console.log('Manual entry is the primary interface, not a fallback:');
      console.log(
        '  pnpm trend -- --add "name of the format" --platform x --mentions 5 --sources 2\n',
      );
      return 0;
    }

    console.log('TRACKED TRENDS\n');
    const cards = rows.map((row) => {
      const observations: TrendObservation[] = observationsFor(handle.db, row.id).map((o) => ({
        observedAt: o.observedAt,
        mentionCount: o.mentionCount,
        distinctSources: o.distinctSources,
        manual: o.manual,
        note: o.note,
      }));

      const card = buildTrendCard(
        {
          name: row.name,
          platform: row.platform as TrendPlatform,
          mechanism: row.mechanism ?? undefined,
          howToParticipate: row.howToParticipate ?? undefined,
          originalVersion: row.originalVersion ?? undefined,
        },
        observations,
        now,
      );

      // Persist the computed placement so the dashboard reads it without recomputing.
      updatePlacement(
        handle.db,
        row.id,
        {
          stage: card.lifecycle.stage,
          saturation: card.lifecycle.saturation,
          explanation: card.lifecycle.explanation,
        },
        now,
      );

      return card;
    });

    console.log(
      renderTable(
        ['TREND', 'PLATFORM', 'OBS', 'STAGE', 'DECISION', 'SAT'],
        cards.map((card) => [
          card.name.slice(0, 40),
          card.platform,
          String(card.observationCount),
          card.lifecycle.stage,
          card.lifecycle.decision,
          card.lifecycle.saturation.toFixed(2),
        ]),
        ['left', 'left', 'right', 'left', 'left', 'right'],
      ),
    );
    console.log('');

    for (const card of cards) {
      console.log(`── ${card.name}`);
      console.log(`   why:      ${card.lifecycle.explanation}`);
      console.log(`   adapt:    ${card.creatorAdaptation}`);
      console.log(`   risk:     ${card.risk}`);
      if (card.missing.length > 0) {
        // Naming the gaps rather than leaving them silently blank: an incomplete card
        // must not be mistakable for a complete one.
        console.log(`   MISSING:  ${card.missing.join('; ')}`);
      }
      console.log('');
    }

    console.log('WHAT AUTOMATED DETECTION CANNOT DO');
    console.log('  Formats on X, TikTok, and Instagram are invisible to free feeds.');
    console.log('  The automated signal covers technical-format repetition across HN,');
    console.log('  Reddit, Lobsters, and GitHub only. Everything else is human-observed');
    console.log('  and machine-tracked, which is the honest scope — see ROADMAP.md §9.\n');

    return 0;
  } finally {
    handle.close();
  }
}

process.exit(main());
