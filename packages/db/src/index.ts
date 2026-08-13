import { fileURLToPath } from 'node:url';

export * from './schema.js';
export * from './client.js';

/**
 * Absolute path to the migrations folder, resolved from this module rather than from
 * the caller's working directory. The worker, the dashboard, the CLI, and the test
 * suite all run from different places; a relative path would work in exactly one.
 */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));
