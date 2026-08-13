import {
  openDatabase,
  runMigrations,
  seedAll,
  MIGRATIONS_FOLDER,
  loadEntityRegistryRows,
  countEvents,
  countRawItems,
  recentEvents,
  eventEvidence,
  clearDerivedEvents,
} from '@signal-desk/db';
import { createEmbedder } from '@signal-desk/adapters';
import { EntityRegistry } from '@signal-desk/core';
import { ConfigError } from '@signal-desk/shared';
import { bootstrap } from '../bootstrap.js';
import { findRepoRoot } from '../repo-root.js';
import { runPipeline } from '../pipeline.js';
import { renderTable } from '../table.js';

/**
 * `pnpm cluster` — turn unclustered `raw_items` into canonical events.
 *
 * Flags:
 *   --rebuild     drop every derived event and re-cluster from scratch
 *   --no-embed    stages 1 and 2 only; skip the model entirely
 *   --local-only  use the embedding model only if already cached; never download
 */
async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const rebuild = argv.includes('--rebuild');
  const noEmbed = argv.includes('--no-embed');
  const localOnly = argv.includes('--local-only');

  let boot;
  try {
    boot = bootstrap({ loggerName: 'cluster' });
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

    const rows = loadEntityRegistryRows(handle.db);
    const registry = new EntityRegistry(rows.entities, rows.aliases);

    if (rebuild) {
      // Safe by construction: `events` is derived and `raw_items` is untouched.
      // The one thing this discards is operator unmerges, which is why it is behind
      // an explicit flag rather than being the default.
      console.log('\n--rebuild: clearing derived events (raw_items is not touched)');
      clearDerivedEvents(handle.db);
    }

    const embedder = noEmbed
      ? undefined
      : createEmbedder({
          cacheDir: `${findRepoRoot()}/.models`,
          ...(localOnly ? { localOnly: true } : {}),
        });

    if (embedder === undefined && !noEmbed) {
      console.log(
        'NOTE  the embedding model is not cached and --local-only was given.\n' +
          '      Running stages 1 and 2 only. Paraphrases without a shared artifact\n' +
          '      will NOT be merged. Run `pnpm cluster` with network access once to cache it.',
      );
    }

    const before = countEvents(handle.db);
    console.log(
      `\nclustering ${String(countRawItems(handle.db))} raw items ` +
        `(${String(before)} events exist)…\n`,
    );

    const summary = await runPipeline({
      db: handle.db,
      registry,
      logger: boot.logger,
      embedder,
    });

    console.log(
      `processed ${String(summary.processed)} · ` +
        `${String(summary.newEvents)} new events · ` +
        `merged s1=${String(summary.merged.stage1)} s2=${String(summary.merged.stage2)} s3=${String(summary.merged.stage3)}`,
    );
    console.log(
      `embeddings: ${summary.embeddingAvailable ? `${String(summary.embedded)} written` : 'DISABLED — stages 1 and 2 only'}`,
    );
    if (summary.injectionFlagged > 0) {
      console.log(
        `injection signals: ${String(summary.injectionFlagged)} item(s) flagged — stored and surfaced, not dropped`,
      );
    }
    if (summary.skippedOperatorUnmerged > 0) {
      console.log(
        `skipped ${String(summary.skippedOperatorUnmerged)} item(s) the operator had unmerged`,
      );
    }
    console.log(`raw_items → events: ${String(before)} → ${String(countEvents(handle.db))}`);
    console.log(`took ${String(summary.durationMs)}ms\n`);

    const top = recentEvents(handle.db, 15)
      .map((event) => [
        String(event.id),
        event.category,
        String(event.evidenceCount),
        String(event.distinctSourceCount),
        event.hasOfficialSource ? 'yes' : 'no',
        event.title.slice(0, 58),
      ])
      .filter((row) => row.length > 0);

    if (top.length > 0) {
      console.log(
        renderTable(['ID', 'CATEGORY', 'EVID', 'SRC', 'OFFICIAL', 'TITLE'], top, [
          'right',
          'left',
          'right',
          'right',
          'left',
          'left',
        ]),
      );
      console.log('');
    }

    // The clusters with the most evidence are the ones most worth eyeballing: a
    // wrong merge is most damaging where it absorbed the most.
    const biggest = recentEvents(handle.db, 500)
      .filter((e) => e.evidenceCount > 1)
      .sort((a, b) => b.evidenceCount - a.evidenceCount)
      .slice(0, 5);

    if (biggest.length > 0) {
      console.log('LARGEST CLUSTERS  (check these by eye — a wrong merge hides an event)');
      for (const event of biggest) {
        console.log(
          `  [${String(event.id)}] ${String(event.evidenceCount)}× ${event.title.slice(0, 70)}`,
        );
        for (const item of eventEvidence(handle.db, event.id).slice(0, 8)) {
          console.log(
            `        ${item.role.padEnd(13)} s${String(item.mergeStage ?? 0)}` +
              `${item.similarity === null ? '' : ` (${item.similarity.toFixed(3)})`}  ${item.sourceId}`,
          );
        }
      }
      console.log('');
    }

    return 0;
  } finally {
    handle.close();
  }
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(`\nclustering failed: ${String(error)}\n`);
    process.exit(1);
  });
