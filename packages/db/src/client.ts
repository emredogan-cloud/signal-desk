import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { databaseFilePath } from '@signal-desk/shared';
import * as schema from './schema.js';

/**
 * SQLite connection. ARCHITECTURE.md §2 and §7.
 *
 * One writer (the worker), one reader (the dashboard). WAL makes that concurrency
 * work without locking the dashboard out mid-ingest.
 */

export type Db = BetterSQLite3Database<typeof schema>;

export type OpenDatabaseOptions = {
  /** `file:./data/signal-desk.db`, or `:memory:` for tests. */
  readonly url: string;
  /** Skip WAL and directory creation for in-memory test databases. */
  readonly readonly?: boolean;
};

export type DatabaseHandle = {
  readonly db: Db;
  readonly raw: Database.Database;
  close(): void;
};

const IN_MEMORY = ':memory:';

export function openDatabase(options: OpenDatabaseOptions): DatabaseHandle {
  const path = options.url === IN_MEMORY ? IN_MEMORY : resolve(databaseFilePath(options.url));

  if (path !== IN_MEMORY) {
    mkdirSync(dirname(path), { recursive: true });
  }

  const raw = new Database(path, { readonly: options.readonly ?? false });

  // A reader sets neither. `journal_mode` is a WRITE to the database header, and
  // issuing it from the dashboard while the worker holds the WAL is what made the
  // deployed console take 32 seconds to render a page: four `openDatabase` calls per
  // request, each contending for the header, each waiting out part of the 5-second
  // `busy_timeout`. The pragmas below are the writer's business — `ARCHITECTURE.md` §7
  // says one writer and one reader, and this is that sentence expressed in code.
  if (path !== IN_MEMORY && options.readonly !== true) {
    // WAL survives across connections and only needs setting once, but setting it
    // every open is idempotent and removes an ordering dependency at startup.
    raw.pragma('journal_mode = WAL');
    // NORMAL is the documented companion to WAL: durable across process crashes,
    // and only at risk from an OS-level crash. Correct trade for a feed cache that
    // can be re-derived from raw_items.
    raw.pragma('synchronous = NORMAL');
  }
  raw.pragma('foreign_keys = ON');
  // Fail loudly on a lock rather than hanging the worker forever.
  raw.pragma('busy_timeout = 5000');

  const db = drizzle(raw, { schema });

  return {
    db,
    raw,
    close() {
      raw.close();
    },
  };
}

/** Apply every pending migration. Idempotent; safe to call on every startup. */
export function runMigrations(handle: DatabaseHandle, migrationsFolder: string): void {
  migrate(handle.db, { migrationsFolder });
}

/** An in-memory database with the schema applied. For tests only. */
export function openTestDatabase(migrationsFolder: string): DatabaseHandle {
  const handle = openDatabase({ url: IN_MEMORY });
  runMigrations(handle, migrationsFolder);
  return handle;
}

export { schema };
