import {
  openDatabase,
  runMigrations,
  MIGRATIONS_FOLDER,
  seedAll,
  countRows,
} from '@signal-desk/db';
import { ConfigError } from '@signal-desk/shared';
import { bootstrap } from '../bootstrap.js';

/**
 * `pnpm db:seed` — apply the source and entity registries to the database.
 *
 * Idempotent, and deliberately non-destructive: it refreshes the declarative fields
 * and leaves everything the running system has learned alone — etags, freshness
 * timestamps, and the `active` flag an operator used to disable a bad source.
 */
function main(): number {
  try {
    const { config, logger } = bootstrap({ loggerName: 'seed' });
    const handle = openDatabase({ url: config.DATABASE_URL });

    try {
      runMigrations(handle, MIGRATIONS_FOLDER);
      const report = seedAll(handle.db);
      const counts = countRows(handle.db);

      logger.info({ ...report, ...counts }, 'registry seeded');

      console.log('');
      console.log(
        `sources   ${String(report.sourcesInserted)} inserted, ` +
          `${String(report.sourcesUpdated)} updated  →  ${String(counts.sources)} total`,
      );
      console.log(
        `entities  ${String(report.entitiesUpserted)} upserted  →  ${String(counts.entities)} total, ` +
          `${String(counts.aliases)} aliases`,
      );
      console.log('');
      console.log('Next: `pnpm sources:probe` to verify every URL still serves a feed.');
      console.log('');
      return 0;
    } finally {
      handle.close();
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`\n${error.message}\n`);
      return 1;
    }
    console.error(`\nseeding failed: ${String(error)}\n`);
    return 1;
  }
}

process.exit(main());
