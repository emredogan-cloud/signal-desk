import {
  openDatabase,
  runMigrations,
  seedAll,
  MIGRATIONS_FOLDER,
  countRawItems,
  duplicateExternalIds,
  trippedSources,
} from '@signal-desk/db';
import { createAdapterRegistry } from '@signal-desk/adapters';
import { ConfigError } from '@signal-desk/shared';
import { bootstrap } from '../bootstrap.js';
import { findRepoRoot } from '../repo-root.js';
import { ingestOnce } from '../ingest.js';
import { renderTable } from '../table.js';

/**
 * `pnpm ingest:once` — one ingestion pass, then exit.
 *
 * Honours `DATA_MODE`. In MOCK it reads `fixtures/` and makes no network request at
 * all, which is what makes ROADMAP.md Phase 3's acceptance criterion checkable:
 * "reproduces a full run from fixtures with no network access at all (verified by
 * running with networking disabled)".
 *
 * `--force` ignores poll intervals and fetches everything due or not.
 */
async function main(): Promise<number> {
  const force = process.argv.includes('--force');
  const quiet = process.argv.includes('--quiet');

  let boot;
  try {
    boot = bootstrap({ loggerName: 'ingest' });
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

    const registry = createAdapterRegistry({
      mode: boot.modes.dataMode,
      fixturesDir: `${findRepoRoot()}/fixtures`,
    });

    const before = countRawItems(handle.db);

    console.log('');
    console.log(
      `ingesting in ${boot.modes.dataMode} mode` +
        (boot.modes.dataMode === 'MOCK' ? ' — reading fixtures/, no network' : '') +
        (force ? ', --force (ignoring poll intervals)' : ''),
    );
    console.log('');

    const summary = await ingestOnce({
      db: handle.db,
      registry,
      logger: boot.logger,
      githubToken: boot.config.GITHUB_TOKEN,
      force,
    });

    if (!quiet) {
      const rows = summary.results
        .filter((r) => r.skipped === undefined)
        .map((r) => [
          r.result === undefined || r.result.outcome === 'ok' || r.result.outcome === 'not_modified'
            ? '✓'
            : '✗',
          r.source.id,
          `P${String(r.source.priority)}`,
          r.result?.outcome ?? '—',
          String(r.result?.items.length ?? 0),
          String(r.itemsNew),
          `${String(r.result?.elapsedMs ?? 0)}ms`,
        ]);

      if (rows.length > 0) {
        console.log(
          renderTable(['', 'SOURCE', 'PRI', 'OUTCOME', 'FOUND', 'NEW', 'TIME'], rows, [
            'left',
            'left',
            'left',
            'left',
            'right',
            'right',
            'right',
          ]),
        );
        console.log('');
      }
    }

    const after = countRawItems(handle.db);
    console.log(
      `${String(summary.fetched)} fetched · ${String(summary.notModified)} not-modified · ` +
        `${String(summary.itemsFound)} items found · ${String(summary.itemsNew)} new · ` +
        `${String(summary.failures)} failed`,
    );
    console.log(
      `skipped: ${String(summary.skippedNotDue)} not due, ${String(summary.skippedCircuitOpen)} circuit open`,
    );
    console.log(`raw_items: ${String(before)} → ${String(after)}`);

    // ROADMAP.md Phase 3 acceptance: "no duplicates in raw_items". The unique index
    // makes this structurally impossible; the check proves it rather than trusting it.
    const duplicates = duplicateExternalIds(handle.db);
    console.log(
      duplicates.length === 0
        ? 'duplicates: none'
        : `duplicates: ${String(duplicates.length)} — THIS SHOULD BE IMPOSSIBLE`,
    );

    const tripped = trippedSources(handle.db);
    if (tripped.length > 0) {
      console.log('');
      console.log('CIRCUIT OPEN');
      for (const source of tripped) {
        console.log(
          `  ${source.id} — ${String(source.consecutiveFailures)} consecutive failures, ` +
            `open until ${source.circuitOpenUntil?.toISOString() ?? '?'}`,
        );
        if (source.lastErrorMessage !== null) console.log(`      ${source.lastErrorMessage}`);
      }
    }
    console.log('');

    return duplicates.length === 0 ? 0 : 1;
  } finally {
    handle.close();
  }
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(`\ningest failed: ${String(error)}\n`);
    process.exit(1);
  });
