import {
  openDatabase,
  runMigrations,
  MIGRATIONS_FOLDER,
  getSource,
  insertSource,
} from '@signal-desk/db';
import { probeSource, isProbeSuccess } from '@signal-desk/adapters';
import {
  ConfigError,
  SOURCE_CATEGORIES,
  SOURCE_PLATFORMS,
  SOURCE_CATEGORY_RELIABILITY,
  DEFAULT_POLL_INTERVAL_SEC,
  isSourcePriority,
  type SourceCategory,
  type SourcePlatform,
} from '@signal-desk/shared';
import { bootstrap } from '../bootstrap.js';

/**
 * `pnpm sources:add` — ROADMAP.md Phase 2.
 *
 * Adds a source to the registry, **probing it first**. A URL that does not serve a
 * feed is refused rather than stored, because SOURCE-INTELLIGENCE.md's own rule is
 * that an unprobed entry is a claim rather than a measurement — and the file already
 * records three candidate feeds that answered 200 while serving HTML.
 *
 * `--force` stores it anyway, marked inactive, so a temporarily-down source can be
 * captured without pretending it works.
 */

const USAGE = `
Usage:
  pnpm sources:add --id <slug> --name <name> --url <url> \\
                   --platform <${SOURCE_PLATFORMS.join('|')}> \\
                   --category <${SOURCE_CATEGORIES.join('|')}> \\
                   --priority <1-4> [--entity <slug>] [--official] \\
                   [--expect "<what this source is for>"] [--force]

The URL is probed before it is stored. A source that does not serve a valid feed is
refused unless --force is given, in which case it is stored inactive.
`;

type ParsedArgs = {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly platform: SourcePlatform;
  readonly category: SourceCategory;
  readonly priority: 1 | 2 | 3 | 4;
  readonly entity: string | null;
  readonly isOfficial: boolean;
  readonly expectedValue: string;
  readonly force: boolean;
};

class UsageError extends Error {}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    if (index === -1) return undefined;
    const next = argv[index + 1];
    return next === undefined || next.startsWith('--') ? undefined : next;
  };
  const required = (flag: string): string => {
    const v = value(flag);
    if (v === undefined || v.trim() === '') throw new UsageError(`missing required flag ${flag}`);
    return v.trim();
  };

  const platform = required('--platform');
  if (!(SOURCE_PLATFORMS as readonly string[]).includes(platform)) {
    throw new UsageError(`--platform must be one of: ${SOURCE_PLATFORMS.join(', ')}`);
  }

  const category = required('--category');
  if (!(SOURCE_CATEGORIES as readonly string[]).includes(category)) {
    throw new UsageError(`--category must be one of: ${SOURCE_CATEGORIES.join(', ')}`);
  }

  const priority = Number.parseInt(required('--priority'), 10);
  if (!isSourcePriority(priority)) throw new UsageError('--priority must be 1, 2, 3, or 4');

  const id = required('--id');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new UsageError('--id must be a lowercase slug: letters, digits, and hyphens');
  }

  const url = required('--url');
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new UsageError('--url must be http or https');
    }
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`--url is not a valid absolute URL: ${url}`);
  }

  return {
    id,
    name: required('--name'),
    url,
    platform: platform as SourcePlatform,
    category: category as SourceCategory,
    priority,
    entity: value('--entity') ?? null,
    isOfficial: argv.includes('--official'),
    expectedValue: value('--expect') ?? '',
    force: argv.includes('--force'),
  };
}

async function main(): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`\n${error.message}\n${USAGE}`);
      return 1;
    }
    throw error;
  }

  let handle;
  try {
    const boot = bootstrap({ loggerName: 'sources:add' });
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

    if (getSource(handle.db, args.id) !== undefined) {
      console.error(`\nA source with id "${args.id}" already exists.\n`);
      return 1;
    }

    console.log(`\nprobing ${args.url} …`);
    const result = await probeSource({ id: args.id, url: args.url, platform: args.platform });
    const healthy = isProbeSuccess(result);

    console.log(
      `  HTTP ${String(result.httpStatus ?? 0)}  ${result.contentType ?? 'no content-type'}  ` +
        `${String(result.itemCount)} item(s)  ${String(result.elapsedMs)}ms  → ${result.outcome}`,
    );
    if (result.error !== undefined) console.log(`  ${result.error}`);
    if (result.finalUrl !== undefined && result.finalUrl !== args.url) {
      console.log(`  redirected to ${result.finalUrl}`);
    }

    if (!healthy && !args.force) {
      console.error(
        `\nRefusing to add a source that does not serve a valid feed.\n` +
          `Re-run with --force to store it inactive, or fix the URL.\n`,
      );
      return 1;
    }

    const now = new Date();
    insertSource(handle.db, {
      id: args.id,
      name: args.name,
      url: args.url,
      platform: args.platform,
      category: args.category,
      entity: args.entity,
      priority: args.priority,
      isOfficial: args.isOfficial,
      reliability: SOURCE_CATEGORY_RELIABILITY[args.category],
      pollIntervalSec: DEFAULT_POLL_INTERVAL_SEC[args.priority],
      expectedValue: args.expectedValue,
      active: healthy,
      lastCheckedAt: now,
      ...(healthy ? { lastSuccessAt: now, verifiedAt: now } : {}),
      ...(result.itemCount > 0 ? { lastEventAt: now } : {}),
      ...(result.etag !== undefined ? { etag: result.etag } : {}),
      ...(result.lastModified !== undefined ? { lastModified: result.lastModified } : {}),
      createdAt: now,
      updatedAt: now,
    });

    console.log(
      healthy
        ? `\nAdded "${args.id}" (active, verified ${now.toISOString().slice(0, 10)}).\n`
        : `\nAdded "${args.id}" INACTIVE — it did not probe cleanly. Enable it once the URL works.\n`,
    );
    console.log(
      `Note: this source is now in the database but not in the committed seed file.\n` +
        `Add it to packages/db/src/seed/sources.ts so a fresh clone gets it too.\n`,
    );

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
    console.error(`\nsources:add failed: ${String(error)}\n`);
    process.exit(1);
  });
