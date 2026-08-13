import { ConfigError } from '@signal-desk/shared';
import { runWorker, installSignalHandlers } from './worker.js';

/**
 * Worker entrypoint.
 *
 * A configuration error exits 1 with a readable message and no stack trace — the
 * operator does not need a stack to learn that DATA_MODE is misspelled. Anything
 * else exits 1 with the full error, because an unexpected failure is a bug.
 */
async function main(): Promise<void> {
  const result = await runWorker({ once: true });
  installSignalHandlers(result.shutdown);
  await result.shutdown();
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`\n${error.message}\n\n`);
    process.exit(1);
  }
  process.stderr.write(`\nworker failed to start:\n${String(error)}\n\n`);
  if (error instanceof Error && error.stack !== undefined) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exit(1);
});
