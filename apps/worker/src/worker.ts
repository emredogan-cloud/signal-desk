import {
  openDatabase,
  runMigrations,
  seedAll,
  countRows,
  staleSources,
  MIGRATIONS_FOLDER,
  type DatabaseHandle,
} from '@signal-desk/db';
import { bootstrap, logStartupState, type Bootstrap, type BootstrapOptions } from './bootstrap.js';

/**
 * The long-lived process: scheduler → pipeline.
 *
 * At Phase 1 it starts, migrates, reports its state, and stops. There are no
 * intelligence features yet and the README says so. What this phase proves is that
 * the process can come up and shut down cleanly with no credentials configured —
 * the property every later phase is built on.
 */

export type RunOptions = BootstrapOptions & {
  /** Run the startup sequence once and return, instead of holding the process open. */
  readonly once?: boolean;
  /** Override the database location. Tests pass ':memory:'. */
  readonly databaseUrl?: string;
};

export type RunResult = {
  readonly bootstrapped: Bootstrap;
  readonly database: DatabaseHandle;
  /** Resolves when the worker has shut down. Absent in `once` mode. */
  readonly shutdown: () => Promise<void>;
};

// Nothing at Phase 1 is asynchronous — better-sqlite3 is synchronous by design. The
// signature is a Promise anyway because it becomes genuinely async in Phase 3 when
// the scheduler and adapters land, and changing it then would churn every caller and
// every test for no gain.
// eslint-disable-next-line @typescript-eslint/require-await
export async function runWorker(options: RunOptions = {}): Promise<RunResult> {
  const bootstrapped = bootstrap(options);
  const { logger, config } = bootstrapped;

  logStartupState(bootstrapped);

  const databaseUrl = options.databaseUrl ?? config.DATABASE_URL;
  const database = openDatabase({ url: databaseUrl });

  runMigrations(database, MIGRATIONS_FOLDER);

  // The registry is defined in code, so the database is brought into step with it on
  // every start. Idempotent, and it never overwrites learned state — etags,
  // freshness timestamps, or an `active` flag an operator turned off deliberately.
  const seeded = seedAll(database.db);
  const counts = countRows(database.db);
  logger.info(
    {
      database_url: databaseUrl,
      sources: counts.sources,
      entities: counts.entities,
      aliases: counts.aliases,
      sources_inserted: seeded.sourcesInserted,
    },
    'database ready',
  );

  // THREAT-MODEL.md §T-9 — the startup self-test. A source that has gone quiet is
  // reported at start rather than discovered weeks later, because the failure mode
  // being defended against is the operator believing he is covered when he is not.
  const stale = staleSources(database.db);
  for (const { source, silentForSec, thresholdSec } of stale) {
    logger.warn(
      {
        source_id: source.id,
        priority: source.priority,
        silent_for_hours: Math.round(silentForSec / 3600),
        threshold_hours: Math.round(thresholdSec / 3600),
        last_success_at: source.lastSuccessAt?.toISOString() ?? null,
      },
      `STALE SOURCE: ${source.id} has produced nothing for longer than its tier allows`,
    );
  }
  if (stale.length > 0) {
    logger.warn(
      { stale_count: stale.length, total_sources: counts.sources },
      `${String(stale.length)} of ${String(counts.sources)} sources are stale — run \`pnpm sources:probe\``,
    );
  }

  let closed = false;
  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    logger.info('shutting down');
    database.close();
    await Promise.resolve();
  };

  if (options.once === true) {
    logger.info('startup self-test complete (once mode); no pipeline is implemented yet');
    return { bootstrapped, database, shutdown };
  }

  logger.warn(
    'no scheduler is implemented at Phase 1 — the worker has nothing to do and will exit. ' +
      'Ingestion arrives in Phase 3.',
  );

  return { bootstrapped, database, shutdown };
}

/** Wire SIGINT/SIGTERM to a clean shutdown. Only the real entrypoint calls this. */
export function installSignalHandlers(shutdown: () => Promise<void>): void {
  const handle = (signal: NodeJS.Signals) => {
    void shutdown()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
    return signal;
  };
  process.once('SIGINT', handle);
  process.once('SIGTERM', handle);
}
