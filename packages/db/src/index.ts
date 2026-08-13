import { fileURLToPath } from 'node:url';

export * from './schema.js';
export * from './client.js';
export * from './seed/sources.js';
export * from './seed/entities.js';
export * from './seed/apply.js';
export * from './queries/sources.js';
export * from './queries/raw-items.js';
export * from './queries/events.js';

/**
 * Absolute path to the migrations folder, resolved from this module rather than from
 * the caller's working directory. The worker, the dashboard, the CLIs, and the test
 * suite all run from different places; a relative path would work in exactly one.
 */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));
