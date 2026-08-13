import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export * from './schema.js';
export * from './client.js';
export * from './seed/sources.js';
export * from './seed/entities.js';
export * from './seed/apply.js';
export * from './queries/sources.js';
export * from './queries/raw-items.js';
export * from './queries/events.js';
export * from './queries/scores.js';
export * from './queries/analyses.js';
export * from './queries/trends.js';

/**
 * Absolute path to the migrations folder, resolved from this module rather than from
 * the caller's working directory. The worker, the CLIs, and the test suite all run
 * from different places; a relative path would work in exactly one.
 *
 * Built with `path.join` rather than `new URL('../migrations', import.meta.url)`.
 * Both produce the same string, but bundlers treat the string literal inside `new
 * URL(...)` as a **static asset reference** and try to resolve it at build time —
 * which failed the dashboard's Turbopack build with "Module not found: Can't resolve
 * '../migrations'". A directory of `.sql` files is not a module, and `path.join` says
 * so unambiguously.
 */
export const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
