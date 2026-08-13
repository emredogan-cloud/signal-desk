import {
  openDatabase,
  runMigrations,
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
  logger.info({ database_url: databaseUrl }, 'database ready');

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
