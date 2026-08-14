import { existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { backup, backupPath, verifyRestore } from '@signal-desk/db';
import { databaseFilePath } from '@signal-desk/shared';
import { bootstrap } from '../bootstrap.js';

/**
 * `pnpm backup` — snapshot the database, prove the snapshot restores, prune old ones.
 *
 * ## Why an application-level backup when the platform already snapshots the volume
 *
 * Fly takes daily volume snapshots and keeps five. Those protect against the volume
 * being lost. They do **not** protect against the failure that is far more likely
 * here: the database being corrupted or wrongly written by this system, and the
 * corruption being faithfully snapshotted for five days until it is the only copy
 * left. A backup nobody has restored is a hypothesis.
 *
 * So this does the thing that makes it evidence rather than hope: every run restores
 * the file it just wrote to a scratch path and runs `PRAGMA integrity_check` plus row
 * counts against it. A backup that is valid SQLite and empty passes a naive check and
 * fails this one.
 *
 * ## Retention
 *
 * `--keep=N` (default 7). Deleted oldest-first by filename, which sorts correctly
 * because `backupPath` stamps ISO-8601. Small enough to live beside the database on
 * a 3GB volume: `VACUUM INTO` compacts, so a snapshot is smaller than the source.
 */

const DEFAULT_KEEP = 7;

/** Tables whose emptiness would mean the backup is structurally fine and worthless. */
const MUST_HAVE_ROWS = ['sources', 'raw_items'];

function numericFlag(name: string, fallback: number): number {
  const arg = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (arg === undefined) return fallback;
  const parsed = Number(arg.slice(`--${name}=`.length));
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function main(): number {
  const { config } = bootstrap({ loggerName: 'backup' });

  const databasePath = resolve(databaseFilePath(config.DATABASE_URL));
  if (!existsSync(databasePath)) {
    console.error(`\nNo database at ${databasePath} — nothing to back up.\n`);
    return 1;
  }

  const dirArg = process.argv.find((value) => value.startsWith('--dir='));
  const directory =
    dirArg === undefined ? join(dirname(databasePath), 'backups') : dirArg.slice('--dir='.length);
  const keep = numericFlag('keep', DEFAULT_KEEP);

  mkdirSync(directory, { recursive: true });

  const now = new Date();
  const destination = backupPath(directory, now);
  const result = backup(config.DATABASE_URL, destination);

  console.log(`\nBACKUP`);
  console.log(`  source     ${databasePath} (${(result.sourceBytes / 1_048_576).toFixed(1)} MB)`);
  console.log(`  written    ${result.path} (${(result.bytes / 1_048_576).toFixed(1)} MB)`);
  console.log(`  took       ${result.durationMs} ms`);

  // Restore to a path that is not the live database, then throw it away. See the
  // header: this is the step that turns a file into a verified backup.
  const scratch = join(directory, '.verify-restore.db');
  const verification = verifyRestore(result.path, scratch, MUST_HAVE_ROWS);
  if (existsSync(scratch)) unlinkSync(scratch);

  console.log(`\nRESTORE VERIFICATION`);
  console.log(`  integrity  ${verification.integrityCheck}`);
  console.log(`  tables     ${verification.tables}`);
  for (const table of MUST_HAVE_ROWS) {
    console.log(`  ${table.padEnd(10)} ${verification.rowCounts[table] ?? 0} rows`);
  }

  if (!verification.ok) {
    console.error(`\nBACKUP IS NOT TRUSTWORTHY:`);
    for (const problem of verification.problems) console.error(`  - ${problem}`);
    // Keep the bad file. Deleting the evidence of a failed backup is how the next
    // person gets to rediscover the same fault from scratch.
    console.error(`\nThe file was kept at ${result.path} for inspection.\n`);
    return 1;
  }

  const snapshots = readdirSync(directory)
    .filter((name) => name.startsWith('signal-desk-') && name.endsWith('.db'))
    .sort();
  const excess = snapshots.slice(0, Math.max(0, snapshots.length - keep));
  for (const name of excess) rmSync(join(directory, name), { force: true });

  const kept = snapshots.length - excess.length;
  const totalBytes = readdirSync(directory)
    .filter((name) => name.endsWith('.db'))
    .reduce((sum, name) => sum + statSync(join(directory, name)).size, 0);

  console.log(`\nRETENTION`);
  console.log(`  kept       ${kept} snapshot(s), pruned ${excess.length}`);
  console.log(`  on disk    ${(totalBytes / 1_048_576).toFixed(1)} MB in ${directory}`);
  console.log(`\nVERIFIED — this backup was restored and checked, not merely written.\n`);
  return 0;
}

process.exit(main());
