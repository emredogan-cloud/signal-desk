import {
  openDatabase,
  runMigrations,
  seedAll,
  countRows,
  staleSources,
  MIGRATIONS_FOLDER,
  type DatabaseHandle,
} from '@signal-desk/db';
import { createAdapterRegistry } from '@signal-desk/adapters';
import { bootstrap, logStartupState, type Bootstrap, type BootstrapOptions } from './bootstrap.js';
import { createScheduler, type Scheduler } from './scheduler.js';
import { findRepoRoot } from './repo-root.js';

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
  /** Override the scheduler tick. Tests use a short one. */
  readonly tickSeconds?: number;
};

export type RunResult = {
  readonly bootstrapped: Bootstrap;
  readonly database: DatabaseHandle;
  readonly scheduler: Scheduler;
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

  // ARCHITECTURE.md §8: the MOCK/LIVE distinction is explicit and never inferred.
  // The registry is chosen once, here, so no adapter contains a branch on mode and
  // none can make a network call in MOCK by accident.
  const registry = createAdapterRegistry({
    mode: bootstrapped.modes.dataMode,
    fixturesDir: `${findRepoRoot()}/fixtures`,
  });

  const scheduler = createScheduler({
    db: database.db,
    registry,
    logger,
    githubToken: config.GITHUB_TOKEN,
    ...(options.tickSeconds !== undefined ? { tickSeconds: options.tickSeconds } : {}),
  });

  let closed = false;
  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    logger.info('shutting down');
    await scheduler.stop();
    database.close();
  };

  if (options.once === true) {
    logger.info(
      { data_mode: bootstrapped.modes.dataMode },
      'startup self-test complete (once mode); scheduler not started',
    );
    return { bootstrapped, database, scheduler, shutdown };
  }

  scheduler.start();
  logger.info(
    { sources: counts.sources, tick_seconds: options.tickSeconds ?? 60 },
    'worker running — ingesting on schedule. Ctrl-C to stop.',
  );

  return { bootstrapped, database, scheduler, shutdown };
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
