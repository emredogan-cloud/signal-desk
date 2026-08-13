import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseConfig,
  deriveEffectiveModes,
  registerSecret,
  createLogger,
  type Config,
  type EffectiveModes,
  type Logger,
} from '@signal-desk/shared';

/**
 * Startup sequence shared by the worker and every CLI.
 *
 * Order matters and is deliberate:
 *   1. load `.env` if present            — never required; MOCK works with nothing
 *   2. parse and validate                — fail fast on an *invalid* value
 *   3. register every credential value   — before the first log line is written
 *   4. build the logger                  — now unable to print any of them
 *   5. derive effective modes            — and report every degradation out loud
 *
 * Step 3 before step 4 is the whole point. A logger created first could write a
 * credential during startup, which is exactly when the noisiest logging happens.
 */

export type Bootstrap = {
  readonly config: Config;
  readonly modes: EffectiveModes;
  readonly logger: Logger;
};

export type BootstrapOptions = {
  /** Defaults to `process.env`. Injected in tests. */
  readonly env?: NodeJS.ProcessEnv;
  /** Skip reading `.env` from disk. Tests and CI pass true. */
  readonly skipDotenv?: boolean;
  readonly loggerName?: string;
  readonly destination?: { write(chunk: string): void };
};

/**
 * Load `.env` into `process.env` if the file exists.
 *
 * `process.loadEnvFile` is Node's own, which keeps a dotenv dependency out of the
 * tree (THREAT-MODEL.md §T-5). A missing file is the normal case in CI and must not
 * be an error.
 */
export function loadDotenvIfPresent(cwd: string = process.cwd()): boolean {
  const path = resolve(cwd, '.env');
  if (!existsSync(path)) return false;
  process.loadEnvFile(path);
  return true;
}

export function bootstrap(options: BootstrapOptions = {}): Bootstrap {
  if (options.skipDotenv !== true && options.env === undefined) {
    loadDotenvIfPresent();
  }

  const config = parseConfig(options.env ?? process.env);

  // Every credential the process holds becomes unloggable from here on.
  registerSecret(config.ANTHROPIC_API_KEY);
  registerSecret(config.X_API_KEY);
  registerSecret(config.X_API_SECRET);
  registerSecret(config.X_ACCESS_TOKEN);
  registerSecret(config.X_ACCESS_TOKEN_SECRET);
  registerSecret(config.GITHUB_TOKEN);
  registerSecret(config.NTFY_TOPIC); // ENV-HANDBOOK §6: the topic name *is* the credential

  const logger = createLogger({
    level: config.LOG_LEVEL,
    ...(options.loggerName !== undefined ? { name: options.loggerName } : {}),
    ...(options.destination !== undefined ? { destination: options.destination } : {}),
  });

  const modes = deriveEffectiveModes(config);

  return { config, modes, logger };
}

/**
 * Announce what the process will actually do.
 *
 * §36 of the working brief: make degradation visible. A worker that quietly ran in
 * MOCK because a key was missing is the failure this function exists to prevent.
 */
export function logStartupState(bootstrapped: Bootstrap): void {
  const { logger, modes, config } = bootstrapped;

  logger.info(
    {
      data_mode: modes.dataMode,
      ai_mode: modes.aiMode,
      x_mode: modes.xMode,
      posting_enabled: modes.postingEnabled,
      tz: config.TZ,
      ai_daily_budget_usd: config.AI_DAILY_BUDGET_USD,
      x_daily_budget_usd: config.X_DAILY_BUDGET_USD,
      node: process.version,
    },
    'signal-desk starting',
  );

  for (const degradation of modes.degradations) {
    logger.warn(
      {
        subsystem: degradation.subsystem,
        requested: degradation.requested,
        effective: degradation.effective,
      },
      `DEGRADED: ${degradation.because}`,
    );
  }
}
