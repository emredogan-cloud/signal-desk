import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { backup, verifyRestore, backupPath } from './backup.js';

/**
 * `ROADMAP.md` Phase 14: "backup and restore of the SQLite file **verified by
 * restoring to a clean path**". Acceptance: "Backup restored successfully to a clean
 * environment."
 *
 * A backup nobody has restored is a file, not a backup.
 */

let dir: string;
let source: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'signal-desk-backup-'));
  source = join(dir, 'source.db');

  const db = new Database(source);
  // WAL, matching production. A plain file copy of a WAL database can capture a state
  // that never consistently existed — and it usually works, which is what makes it
  // dangerous.
  db.pragma('journal_mode = WAL');
  db.exec('create table events (id integer primary key, title text not null)');
  db.exec('create table scores (id integer primary key, value integer not null)');
  const insert = db.prepare('insert into events (title) values (?)');
  for (let i = 0; i < 500; i++) insert.run(`event ${String(i)}`);
  db.prepare('insert into scores (value) values (?)').run(42);
  db.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('backup', () => {
  it('produces a readable file', () => {
    const result = backup(source, join(dir, 'backups', 'b.db'));
    expect(existsSync(result.path)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
  });

  it('is idempotent — a nightly job must not fail on its second run', () => {
    // VACUUM INTO refuses to overwrite, so an unguarded implementation works once.
    const destination = join(dir, 'backups', 'b.db');
    expect(() => backup(source, destination)).not.toThrow();
    expect(() => backup(source, destination)).not.toThrow();
  });

  it('creates the destination directory', () => {
    expect(() => backup(source, join(dir, 'deep', 'nested', 'path', 'b.db'))).not.toThrow();
  });

  it('captures a consistent snapshot while the source is open in WAL mode', () => {
    // The real failure mode: a copy taken while writes are in flight. VACUUM INTO
    // goes through SQLite rather than the filesystem, so it sees a coherent state.
    const live = new Database(source);
    live.pragma('journal_mode = WAL');
    live.prepare('insert into events (title) values (?)').run('written during backup');

    const result = backup(source, join(dir, 'b.db'));
    live.close();

    const verification = verifyRestore(result.path, join(dir, 'clean.db'), ['events', 'scores']);
    expect(verification.ok).toBe(true);
    expect(verification.rowCounts.events).toBeGreaterThanOrEqual(500);
  });
});

describe('restore verification', () => {
  it('restores to a CLEAN path and reports ok', () => {
    const result = backup(source, join(dir, 'b.db'));
    const verification = verifyRestore(result.path, join(dir, 'clean.db'), ['events', 'scores']);

    expect(verification.ok).toBe(true);
    expect(verification.integrityCheck).toBe('ok');
    expect(verification.rowCounts.events).toBe(500);
    expect(verification.rowCounts.scores).toBe(1);
    expect(verification.problems).toEqual([]);
  });

  it('never touches the source — the point is to prove the backup WITHOUT betting the original', () => {
    const result = backup(source, join(dir, 'b.db'));
    verifyRestore(result.path, join(dir, 'clean.db'), ['events']);

    const original = new Database(source, { readonly: true });
    const count = original.prepare<[], { n: number }>('select count(*) as n from events').get();
    original.close();
    expect(count?.n).toBe(500);
  });

  it('catches a structurally-valid EMPTY backup', () => {
    // The failure a naive check misses entirely: an empty database passes
    // integrity_check and opens fine.
    const empty = join(dir, 'empty.db');
    const db = new Database(empty);
    db.exec('create table events (id integer primary key, title text)');
    db.close();

    const verification = verifyRestore(empty, join(dir, 'clean2.db'), ['events']);
    expect(verification.ok).toBe(false);
    expect(verification.problems.join(' ')).toContain('structurally valid and empty');
  });

  it('catches a missing table', () => {
    const result = backup(source, join(dir, 'b.db'));
    const verification = verifyRestore(result.path, join(dir, 'clean.db'), ['events', 'nope']);
    expect(verification.ok).toBe(false);
    expect(verification.problems.join(' ')).toContain('"nope" is missing');
  });

  it('catches a corrupted file', () => {
    const corrupt = join(dir, 'corrupt.db');
    writeFileSync(corrupt, Buffer.from('this is not a database at all, not even close'));
    expect(() => verifyRestore(corrupt, join(dir, 'clean3.db'), ['events'])).toThrow();
  });
});

describe('backup paths', () => {
  it('timestamps from the supplied instant, never the clock', () => {
    // Same rule as the scorer: a function that reads the clock cannot be tested
    // deterministically, and a backup name that varies per call breaks replay.
    const at = new Date('2026-08-13T12:34:56.789Z');
    expect(backupPath('/backups', at)).toBe('/backups/signal-desk-2026-08-13T12-34-56-789Z.db');
    expect(backupPath('/backups', at)).toBe(backupPath('/backups', at));
  });
});
