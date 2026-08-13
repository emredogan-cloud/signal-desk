import {
  openDatabase,
  runMigrations,
  MIGRATIONS_FOLDER,
  listSources,
  recordFetchAttempt,
  seedAll,
  type SourceRow,
} from '@signal-desk/db';
import { probeSource, isProbeSuccess } from '@signal-desk/adapters';
import { ConfigError } from '@signal-desk/shared';
import { bootstrap } from '../bootstrap.js';
import { mapWithConcurrency } from '../table.js';
import {
  renderProbeTable,
  renderFailureDetail,
  renderWarningDetail,
  summarise,
  type ProbeRow,
} from '../probe-report.js';

/**
 * `pnpm sources:probe` — ROADMAP.md Phase 2.
 *
 * Fetches every registered source and reports status, content type, item count, and
 * elapsed time. Exits non-zero if any Priority-1 source fails.
 *
 * This is a **live network command**. It is exempt from `DATA_MODE=MOCK` on purpose:
 * its entire job is to check whether real URLs still work, and a mocked probe would
 * report a registry as healthy without touching it — which is precisely the T-9
 * failure it exists to prevent.
 */

type Args = {
  readonly all: boolean;
  readonly only: string | undefined;
  readonly concurrency: number;
  readonly write: boolean;
  readonly json: boolean;
};

function parseArgs(argv: readonly string[]): Args {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const concurrencyRaw = value('--concurrency');
  const parsed = concurrencyRaw === undefined ? Number.NaN : Number.parseInt(concurrencyRaw, 10);

  return {
    all: argv.includes('--all'),
    only: value('--only'),
    // Six at a time. Enough to finish ~50 sources in seconds, low enough to stay
    // well inside "polite" for any single host (THREAT-MODEL.md §T-8).
    concurrency: Number.isFinite(parsed) && parsed > 0 ? parsed : 6,
    write: !argv.includes('--no-write'),
    json: argv.includes('--json'),
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  let logger;
  let handle;
  try {
    const boot = bootstrap({ loggerName: 'sources:probe' });
    logger = boot.logger;
    handle = openDatabase({ url: boot.config.DATABASE_URL });
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`\n${error.message}\n`);
      return 1;
    }
    throw error;
  }

  try {
    runMigrations(handle, MIGRATIONS_FOLDER);
    // Keep the registry in step with the code before probing it. Seeding is
    // idempotent and never touches learned state (etags, freshness, `active`).
    seedAll(handle.db);

    let targets: SourceRow[] = listSources(handle.db, { activeOnly: !args.all });
    if (args.only !== undefined) {
      const only = args.only;
      targets = targets.filter((s) => s.id === only || s.platform === only);
      if (targets.length === 0) {
        console.error(`no source matches --only ${only}`);
        return 1;
      }
    }

    if (!args.json) {
      console.log('');
      console.log(
        `probing ${String(targets.length)} source(s), ${String(args.concurrency)} at a time` +
          (args.write ? '' : '  [--no-write: results will not be persisted]'),
      );
      console.log('');
    }

    const rows: ProbeRow[] = await mapWithConcurrency(targets, args.concurrency, async (source) => {
      const result = await probeSource({
        id: source.id,
        url: source.url,
        platform: source.platform,
      });

      if (args.write) {
        recordFetchAttempt(handle.db, source.id, {
          succeeded: isProbeSuccess(result),
          itemCount: result.itemCount,
          etag: result.etag,
          lastModified: result.lastModified,
          verified: isProbeSuccess(result),
        });
      }

      logger.debug(
        {
          source_id: source.id,
          outcome: result.outcome,
          http_status: result.httpStatus,
          items: result.itemCount,
          elapsed_ms: result.elapsedMs,
        },
        'probed source',
      );

      return { source, result };
    });

    const summary = summarise(rows);

    if (args.json) {
      console.log(JSON.stringify({ summary: { ...summary, failures: undefined }, rows }, null, 2));
      return summary.exitCode;
    }

    console.log(renderProbeTable(rows));
    console.log('');
    console.log(
      `${String(summary.ok)}/${String(summary.total)} healthy` +
        (summary.failed > 0 ? `, ${String(summary.failed)} failing` : ''),
    );

    if (summary.failures.length > 0) {
      console.log('');
      console.log('FAILURES');
      console.log(renderFailureDetail(summary.failures));
    }

    if (summary.warnings.length > 0) {
      console.log('');
      console.log('WARNINGS  (these sources work; something about them is still wrong)');
      console.log(renderWarningDetail(summary.warnings));
    }

    if (summary.priorityOneFailures.length > 0) {
      console.log('');
      console.log(
        `FAIL  ${String(summary.priorityOneFailures.length)} Priority-1 source(s) failed. ` +
          `These are the feeds where a miss means missing the event entirely.`,
      );
    } else if (summary.failed > 0) {
      console.log('');
      console.log('OK    no Priority-1 source failed, so this run does not block.');
    }
    console.log('');

    return summary.exitCode;
  } finally {
    handle.close();
  }
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(`\nsources:probe failed: ${String(error)}\n`);
    process.exit(1);
  });
