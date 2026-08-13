import { openDatabase, runMigrations, MIGRATIONS_FOLDER } from '@signal-desk/db';
import { ConfigError } from '@signal-desk/shared';
import { bootstrap } from '../bootstrap.js';

/**
 * `pnpm db:migrate` — apply every pending migration.
 *
 * Idempotent. The worker also migrates on startup, so this exists for the case where
 * the operator wants to apply a schema change without starting the pipeline.
 */
function main(): number {
  try {
    const { config, logger } = bootstrap({ loggerName: 'migrate' });
    const handle = openDatabase({ url: config.DATABASE_URL });

    try {
      runMigrations(handle, MIGRATIONS_FOLDER);
      logger.info({ database_url: config.DATABASE_URL }, 'migrations applied');
      console.log(`OK    migrations applied to ${config.DATABASE_URL}`);
      return 0;
    } finally {
      handle.close();
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`\n${error.message}\n`);
      return 1;
    }
    console.error(`\nmigration failed: ${String(error)}\n`);
    return 1;
  }
}

process.exit(main());
