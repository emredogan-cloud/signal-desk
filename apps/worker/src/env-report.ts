import {
  configSchema,
  parseConfig,
  deriveEffectiveModes,
  maskSecret,
  parseDotenv,
  ConfigError,
  type Config,
} from '@signal-desk/shared';

/**
 * The reporting and validation logic behind `pnpm check:env` (ENV-HANDBOOK.md §9).
 *
 * Kept separate from the CLI entrypoint so it can be tested without a process exit.
 */

/** Credentials. Their values are masked; their presence is not itself a secret. */
export const SECRET_KEYS: ReadonlySet<string> = new Set([
  'ANTHROPIC_API_KEY',
  'X_API_KEY',
  'X_API_SECRET',
  'X_ACCESS_TOKEN',
  'X_ACCESS_TOKEN_SECRET',
  'GITHUB_TOKEN',
  'NTFY_TOPIC',
]);

/** Which phase first needs each variable. ENV-HANDBOOK.md §1. */
const FIRST_NEEDED: Record<string, string> = {
  ANTHROPIC_API_KEY: 'Phase 6',
  X_API_KEY: 'Phase 12',
  X_API_SECRET: 'Phase 12',
  X_ACCESS_TOKEN: 'Phase 12',
  X_ACCESS_TOKEN_SECRET: 'Phase 12',
  X_ENABLE_POSTING: 'Phase 13',
  GITHUB_TOKEN: 'optional',
  NTFY_TOPIC: 'Phase 11 (optional)',
};

export const ALL_CONFIG_KEYS: readonly string[] = Object.keys(configSchema.shape);

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function renderTable(rows: readonly (readonly string[])[], headers: readonly string[]): string {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? '').length)),
  );
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, i) => pad(cell, widths[i] ?? 0))
      .join('  ')
      .trimEnd();

  return [
    line(headers),
    widths.map((w) => '─'.repeat(w)).join('  '),
    ...rows.map((row) => line(row)),
  ].join('\n');
}

function effectiveValue(key: string, config: Config): string {
  const value = (config as unknown as Record<string, unknown>)[key];

  if (SECRET_KEYS.has(key)) {
    return typeof value === 'string' ? maskSecret(value) : '(not set)';
  }
  if (value === undefined) return '(not set)';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  // Every config value is a string, number, boolean, or undefined. Reaching here
  // means the schema grew a shape this report does not know how to render, and
  // printing "[object Object]" would hide that.
  return `(unrenderable: ${typeof value})`;
}

export type EnvReportOptions = {
  readonly config: Config;
  /** Variables explicitly present in the environment (blank counts as absent). */
  readonly present: ReadonlySet<string>;
  readonly dotenvFound: boolean;
};

/** The full `check:env` output as a string. */
export function renderEnvReport(options: EnvReportOptions): string {
  const { config, present, dotenvFound } = options;
  const modes = deriveEffectiveModes(config);
  const out: string[] = [];

  const rows = ALL_CONFIG_KEYS.map((key) => {
    const isSet = present.has(key);
    return [
      key,
      isSet ? 'set' : '—',
      effectiveValue(key, config),
      isSet ? '' : (FIRST_NEEDED[key] ?? 'has a default'),
    ];
  });

  out.push('');
  out.push('signal-desk — environment');
  out.push(`  .env file: ${dotenvFound ? 'loaded' : 'not present (defaults apply)'}`);
  out.push('');
  out.push(renderTable(rows, ['VARIABLE', 'SOURCE', 'EFFECTIVE VALUE', 'FIRST NEEDED']));
  out.push('');
  out.push('EFFECTIVE MODES');
  out.push(`  DATA_MODE  ${modes.dataMode}${modes.dataMode === 'MOCK' ? '   (fixtures)' : ''}`);
  out.push(`  AI_MODE    ${modes.aiMode}${modes.aiMode === 'MOCK' ? '   (canned analyses)' : ''}`);
  out.push(`  X_MODE     ${modes.xMode}${modes.xMode === 'MOCK' ? '   (fixture metrics)' : ''}`);
  out.push(
    `  POSTING    ${modes.postingEnabled ? 'ENABLED (still requires a click per post)' : 'disabled'}`,
  );
  out.push('');
  out.push('DEGRADED SUBSYSTEMS');

  if (modes.degradations.length === 0) {
    out.push('  none');
  } else {
    for (const degradation of modes.degradations) {
      out.push(`  [${degradation.subsystem}] ${degradation.requested} → ${degradation.effective}`);
      out.push(`      ${degradation.because}`);
    }
  }
  out.push('');

  if (config.ANTHROPIC_API_KEY === undefined) {
    // ENV-HANDBOOK.md §3, stated because it is genuinely surprising: an unset
    // variable does not prove the absence of credentials.
    out.push('NOTE  ANTHROPIC_API_KEY is unset, but the Anthropic SDK also resolves');
    out.push('      ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile on disk. "Unset"');
    out.push('      does not prove "no credentials configured" — check `ant auth status`');
    out.push('      before assuming a run will cost nothing.');
    out.push('');
  }

  return out.join('\n');
}

/**
 * Validate the committed `.env.example`. Returns problems; empty means pass.
 *
 * This is the `pnpm check:env --ci` gate from WORKING-DISCIPLINE.md's CI table.
 */
export function validateEnvExample(contents: string): string[] {
  const problems: string[] = [];
  const parsed = parseDotenv(contents);
  const templateKeys = Object.keys(parsed);

  const missingFromTemplate = ALL_CONFIG_KEYS.filter((k) => !templateKeys.includes(k));
  if (missingFromTemplate.length > 0) {
    problems.push(
      `.env.example is missing variables the schema knows about: ${missingFromTemplate.join(', ')}`,
    );
  }

  const unknownInTemplate = templateKeys.filter((k) => !ALL_CONFIG_KEYS.includes(k));
  if (unknownInTemplate.length > 0) {
    problems.push(
      `.env.example declares variables the schema does not know: ${unknownInTemplate.join(', ')}`,
    );
  }

  let config: Config | undefined;
  try {
    config = parseConfig(parsed);
  } catch (error) {
    if (error instanceof ConfigError) {
      problems.push(`.env.example does not satisfy the schema: ${error.issues.join('; ')}`);
    } else {
      throw error;
    }
  }

  if (config !== undefined) {
    // The committed template must describe a system that needs nothing to run. CI
    // has no secrets; a template implying LIVE would mean CI tests a configuration
    // nobody can reproduce.
    if (config.DATA_MODE !== 'MOCK' || config.AI_MODE !== 'MOCK' || config.X_MODE !== 'MOCK') {
      problems.push('.env.example must default every mode to MOCK');
    }
    if (config.X_ENABLE_POSTING) {
      problems.push('.env.example must ship X_ENABLE_POSTING=false (THREAT-MODEL.md §T-4)');
    }
    for (const key of SECRET_KEYS) {
      if ((config as unknown as Record<string, unknown>)[key] !== undefined) {
        problems.push(`.env.example carries a value for ${key} — it must be blank`);
      }
    }
  }

  return problems;
}
