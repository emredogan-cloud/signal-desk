import { copyFileSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { databaseFilePath } from '@signal-desk/shared';

/**
 * Backup and restore. `ROADMAP.md` Phase 14: "backup and restore of the SQLite file
 * **verified by restoring to a clean path**".
 *
 * That qualifier is the whole requirement. A backup nobody has restored is a file, not
 * a backup — the failure mode is discovering at restore time that the file was copied
 * mid-write and is unreadable.
 *
 * ## Why `VACUUM INTO` and not `cp`
 *
 * The database runs in WAL mode. A plain file copy captures the main database without
 * the write-ahead log, so it can be an unreadable snapshot of a moment that never
 * existed as a consistent state — and it *usually works*, which is worse, because the
 * one time it does not is the time it matters.
 *
 * `VACUUM INTO` takes a consistent snapshot through SQLite itself, with no lock held
 * on the source, and produces a compacted single file with no WAL to carry along.
 */

export type BackupResult = {
  readonly path: string;
  readonly bytes: number;
  readonly sourceBytes: number;
  readonly durationMs: number;
};

export function backup(sourceUrl: string, destination: string): BackupResult {
  const started = Date.now();
  // The same resolution `openDatabase` uses. Passing the raw `DATABASE_URL` straight
  // to `new Database()` failed with SQLITE_CANTOPEN, because the config value carries
  // a `file:` form that only `databaseFilePath` understands. Two places resolving the
  // same setting differently is how a backup silently targets the wrong file.
  const sourcePath = resolve(databaseFilePath(sourceUrl));
  mkdirSync(dirname(destination), { recursive: true });

  // VACUUM INTO refuses to overwrite. Removing first makes the operation idempotent,
  // which matters for a nightly job that must not fail on its second run.
  if (existsSync(destination)) unlinkSync(destination);

  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    source.prepare('VACUUM INTO ?').run(destination);
  } finally {
    source.close();
  }

  return {
    path: destination,
    bytes: statSync(destination).size,
    sourceBytes: statSync(sourcePath).size,
    durationMs: Date.now() - started,
  };
}

export type RestoreVerification = {
  readonly ok: boolean;
  readonly integrityCheck: string;
  readonly tables: number;
  readonly rowCounts: Record<string, number>;
  readonly problems: readonly string[];
};

/**
 * Restore to a clean path and verify.
 *
 * Deliberately restores somewhere **new** rather than over the source. A verification
 * that overwrote the live database would, on failure, destroy the thing it was meant
 * to protect — and the point is to prove the backup is good *without* betting the
 * original on it.
 *
 * Checks structure and content, not just that the file opens. `PRAGMA integrity_check`
 * catches corruption; the row counts catch a backup that is valid SQLite and empty,
 * which is the failure a naive check misses entirely.
 */
export function verifyRestore(
  backupPath: string,
  cleanPath: string,
  expectedTables: readonly string[],
): RestoreVerification {
  const problems: string[] = [];

  mkdirSync(dirname(cleanPath), { recursive: true });
  if (existsSync(cleanPath)) unlinkSync(cleanPath);
  copyFileSync(backupPath, cleanPath);

  const restored = new Database(cleanPath, { readonly: true, fileMustExist: true });
  const rowCounts: Record<string, number> = {};

  try {
    const integrity = restored.pragma('integrity_check', { simple: true });
    const integrityCheck = typeof integrity === 'string' ? integrity : String(integrity);
    if (integrityCheck !== 'ok') problems.push(`integrity_check returned "${integrityCheck}"`);

    const tables = restored
      .prepare<[], { name: string }>(
        "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'",
      )
      .all();
    const names = new Set(tables.map((row) => row.name));

    for (const expected of expectedTables) {
      if (!names.has(expected)) {
        problems.push(`table "${expected}" is missing from the restore`);
        continue;
      }
      const row = restored
        .prepare<[], { n: number }>(`select count(*) as n from "${expected}"`)
        .get();
      rowCounts[expected] = row?.n ?? 0;
    }

    // A backup that is valid SQLite and empty passes integrity_check. That is the
    // failure a naive verification misses, so it is checked explicitly.
    if (Object.values(rowCounts).every((count) => count === 0) && expectedTables.length > 0) {
      problems.push(
        'every expected table restored with zero rows — the backup is structurally valid and empty',
      );
    }

    return {
      ok: problems.length === 0,
      integrityCheck,
      tables: names.size,
      rowCounts,
      problems,
    };
  } finally {
    restored.close();
  }
}

/** A timestamped backup filename. Timestamps come from the caller, never the clock. */
export function backupPath(directory: string, at: Date): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-');
  return join(directory, `signal-desk-${stamp}.db`);
}
