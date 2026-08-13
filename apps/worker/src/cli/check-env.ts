import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseConfig, ConfigError } from '@signal-desk/shared';
import { findRepoRoot } from '../repo-root.js';
import { loadDotenvIfPresent } from '../bootstrap.js';
import { ALL_CONFIG_KEYS, renderEnvReport, validateEnvExample } from '../env-report.js';

/**
 * `pnpm check:env` — "the first command to run when something is not working."
 * ENV-HANDBOOK.md §9.
 *
 * `pnpm check:env --ci` validates the committed `.env.example` instead, without
 * touching the live environment.
 */

function runCiCheck(root: string): number {
  const path = resolve(root, '.env.example');
  if (!existsSync(path)) {
    console.error(`FAIL  .env.example not found at ${path}`);
    return 1;
  }

  const problems = validateEnvExample(readFileSync(path, 'utf8'));
  if (problems.length > 0) {
    console.error('FAIL  .env.example does not satisfy the configuration schema:');
    for (const problem of problems) console.error(`      - ${problem}`);
    return 1;
  }

  console.log(
    `OK    .env.example validates against the schema (${ALL_CONFIG_KEYS.length} variables)`,
  );
  console.log('OK    template describes an all-MOCK, zero-credential system');
  return 0;
}

function main(): number {
  const root = findRepoRoot();

  if (process.argv.includes('--ci')) return runCiCheck(root);

  const dotenvFound = loadDotenvIfPresent(root);
  const present = new Set(
    ALL_CONFIG_KEYS.filter((key) => {
      const raw = process.env[key];
      return raw !== undefined && raw.trim() !== '';
    }),
  );

  try {
    console.log(renderEnvReport({ config: parseConfig(process.env), present, dotenvFound }));
    return 0;
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`\n${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

process.exit(main());
