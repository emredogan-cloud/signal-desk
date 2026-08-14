import { z } from 'zod';

/**
 * Environment parsing. ENV-HANDBOOK.md is the authority on what each value means.
 *
 * Two properties this module must have, both from ENV-HANDBOOK.md §9:
 *
 *  1. It fails fast and readably on an *invalid* value. A typo in AI_ANALYSIS_MODEL
 *     should surface as a startup error, not as a 404 three hours into a run.
 *  2. It never fails on a *missing* optional value. A missing credential degrades a
 *     subsystem to MOCK and says so. It does not stop the process.
 */

const MODE = z.enum(['MOCK', 'LIVE']);

/**
 * `KEY=` in a .env file means "not configured", not "configured as the empty string".
 * dotenv and most shells hand us `''`; treating that as a present value is how you get
 * an Anthropic client constructed with an empty API key and a confusing 401.
 */
const blankToUndefined = (v: unknown): unknown =>
  typeof v === 'string' && v.trim() === '' ? undefined : v;

/** An optional credential. Absent and blank are the same thing. */
const optionalSecret = z.preprocess(blankToUndefined, z.string().min(1).optional());

/** A value with a default that also applies when the variable is present but blank. */
function withDefault<T extends z.ZodType>(schema: T, fallback: unknown) {
  return z.preprocess((v) => (blankToUndefined(v) === undefined ? fallback : v), schema);
}

const booleanish = z.preprocess((v) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
    if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  }
  return v; // hand it to zod, which produces a readable "expected boolean" error
}, z.boolean());

/**
 * The shapes X's key generator actually produces.
 *
 * ### Why a length check earns its place — 2026-08-14
 *
 * The first live run returned `401 Unauthorized`, which is the same body for a bad
 * signature, a revoked token, an unenrolled app, and a mistyped key. Eliminating the
 * signature took a published test vector; eliminating the app took an app-only bearer
 * call that returned `403 Unsupported Authentication` (i.e. *authenticated*, wrong
 * auth type for the endpoint). What was left was the credentials — and the access
 * token turned out to carry a **30-character suffix where X issues 40**. It had been
 * copied short, twice, into two different variable names.
 *
 * That cost six metered requests to discover something that is free to check. A
 * 50-character access token is not a plausible token; it is a truncated one, and the
 * only correct response is to refuse to send and say which field is wrong.
 *
 * Lengths are asserted, not the alphabet: X has changed the character set of these
 * values before and a strict pattern would reject a valid future credential. Length is
 * the part that catches the real failure — a partial paste — without guessing.
 */
export const X_CREDENTIAL_SHAPE = {
  apiKey: 25,
  apiSecret: 50,
  /** `{user_id}-{40 chars}` — the suffix is the part that gets cut off. */
  accessTokenSuffix: 40,
  accessTokenSecret: 45,
} as const;

/** Human-readable problems with the credential *shapes*. Empty means "worth sending". */
export function credentialShapeProblems(credentials: {
  readonly apiKey: string | undefined;
  readonly apiSecret: string | undefined;
  readonly accessToken: string | undefined;
  readonly accessTokenSecret: string | undefined;
}): string[] {
  const problems: string[] = [];

  const check = (name: string, value: string, expected: number): void => {
    if (value === '') problems.push(`${name} is empty`);
    else if (value.length !== expected) {
      problems.push(
        `${name} is ${value.length} characters; X issues ${expected}` +
          (value.length < expected ? ' — this looks like a partial paste' : ''),
      );
    }
  };

  check('X_API_KEY', credentials.apiKey ?? '', X_CREDENTIAL_SHAPE.apiKey);
  check('X_API_SECRET', credentials.apiSecret ?? '', X_CREDENTIAL_SHAPE.apiSecret);
  check(
    'X_ACCESS_TOKEN_SECRET',
    credentials.accessTokenSecret ?? '',
    X_CREDENTIAL_SHAPE.accessTokenSecret,
  );

  const accessToken = credentials.accessToken ?? '';
  const [userId, ...rest] = accessToken.split('-');
  const suffix = rest.join('-');
  if (accessToken === '') {
    problems.push('X_ACCESS_TOKEN is empty');
  } else if (rest.length === 0) {
    problems.push('X_ACCESS_TOKEN has no "-" — the form is {user_id}-{40 characters}');
  } else if (!/^\d+$/.test(userId ?? '')) {
    problems.push('X_ACCESS_TOKEN does not start with a numeric user id');
  } else if (suffix.length !== X_CREDENTIAL_SHAPE.accessTokenSuffix) {
    problems.push(
      `X_ACCESS_TOKEN's suffix is ${suffix.length} characters; X issues ` +
        `${X_CREDENTIAL_SHAPE.accessTokenSuffix}` +
        (suffix.length < X_CREDENTIAL_SHAPE.accessTokenSuffix
          ? ' — the token was copied short. Regenerate it in the X developer console ' +
            '(Keys and tokens → Access Token and Secret) and copy the whole value.'
          : ''),
    );
  }

  return problems;
}

export const configSchema = z.object({
  // ─── Mode ───────────────────────────────────────────────────────────
  DATA_MODE: withDefault(MODE, 'MOCK'),
  AI_MODE: withDefault(MODE, 'MOCK'),
  X_MODE: withDefault(MODE, 'MOCK'),

  // ─── Core ───────────────────────────────────────────────────────────
  DATABASE_URL: withDefault(z.string().min(1), 'file:./data/signal-desk.db'),
  LOG_LEVEL: withDefault(z.enum(['trace', 'debug', 'info', 'warn', 'error']), 'info'),
  TZ: withDefault(z.string().min(1), 'Europe/Istanbul'),

  // ─── Anthropic ──────────────────────────────────────────────────────
  ANTHROPIC_API_KEY: optionalSecret,
  AI_TRIAGE_MODEL: withDefault(z.string().min(1), 'claude-haiku-4-5'),
  AI_ANALYSIS_MODEL: withDefault(z.string().min(1), 'claude-opus-5'),
  AI_DAILY_BUDGET_USD: withDefault(z.coerce.number().nonnegative().finite(), 2.0),
  /**
   * Combined score at or above which an event may reach the expensive model.
   *
   * **Changed from 70 to 50 on 2026-08-13, from measurement rather than preference.**
   *
   * 70 was set in Phase 1, before any score existed. Measured over 5,007 real events
   * the highest combined score is **66**, so the expensive tier was unreachable by
   * construction — the system would never have deep-analysed anything, and it looked
   * exactly like a system correctly finding nothing worth analysing.
   *
   * The evidence for 50, over the 65 gate survivors (max 66, median 43):
   *
   *   | threshold | candidates by score | measured outcome                    |
   *   |-----------|--------------------:|-------------------------------------|
   *   | 70        |                   0 | tier unreachable                    |
   *   | 60        |                   2 | too tight to exercise triage        |
   *   | **50**    |               **7** | 2 Opus calls / 30 events, $0.32     |
   *   | 45        |                  26 | ~$1.60/day, at the budget ceiling   |
   *
   * 50 leaves the cheap triage stage as the actual judge — which is the design — while
   * keeping a floor against triage being over-eager, and lands well inside
   * `AI_DAILY_BUDGET_USD`. It is still a threshold over unfitted weights: when Phase 12
   * refits them the scale moves and this number must be re-measured, not preserved.
   */
  AI_ANALYSIS_THRESHOLD: withDefault(z.coerce.number().min(0).max(100), 50),
  AI_USE_BATCH_FOR_NON_URGENT: withDefault(booleanish, true),

  // ─── X ──────────────────────────────────────────────────────────────
  X_API_KEY: optionalSecret,
  X_API_SECRET: optionalSecret,
  X_ACCESS_TOKEN: optionalSecret,
  X_ACCESS_TOKEN_SECRET: optionalSecret,
  X_DAILY_BUDGET_USD: withDefault(z.coerce.number().nonnegative().finite(), 0.5),
  X_ENABLE_POSTING: withDefault(booleanish, false),
  X_MAX_POSTS_PER_DAY: withDefault(z.coerce.number().int().nonnegative(), 4),

  // ─── GitHub ─────────────────────────────────────────────────────────
  GITHUB_TOKEN: optionalSecret,

  // ─── Dashboard ──────────────────────────────────────────────────────
  /**
   * The single-operator credential for the dashboard, checked in
   * `apps/web/src/proxy.ts`.
   *
   * Optional in the schema, **mandatory in practice from the moment the dashboard is
   * reachable from anywhere but `127.0.0.1`** — which it has been since 2026-08-14.
   * The proxy fails closed when the password is absent, so an unset value degrades to
   * "nobody can read the dashboard", never to "anybody can". Schema-optional and
   * runtime-mandatory is the right split: local development on a loopback binding
   * genuinely does not need it, and requiring it would push developers toward a
   * throwaway value that then ships.
   */
  DASHBOARD_USER: withDefault(z.string().min(1), 'operator'),
  DASHBOARD_PASSWORD: optionalSecret,

  // ─── Alerts ─────────────────────────────────────────────────────────
  NTFY_TOPIC: optionalSecret,
  ALERT_MIN_PRIORITY: withDefault(z.enum(['urgent', 'high', 'trend', 'educational']), 'urgent'),
});

export type Config = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(
      `Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}\n\n` +
        `See docs/ENV-HANDBOOK.md, or run \`pnpm check:env\` for the full table.`,
    );
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/**
 * Pure. Takes an environment, returns a config or throws ConfigError.
 * Everything in this package is testable without touching process.env.
 */
export function parseConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>): Config {
  const result = configSchema.safeParse(env);
  if (result.success) return result.data;

  const issues = result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
  throw new ConfigError(issues);
}

// ───────────────────────────── effective modes ─────────────────────────────

export type DegradationReason = {
  readonly subsystem: 'ai' | 'x' | 'github' | 'alerts';
  readonly requested: string;
  readonly effective: string;
  readonly because: string;
};

export type EffectiveModes = {
  readonly dataMode: 'MOCK' | 'LIVE';
  readonly aiMode: 'MOCK' | 'LIVE';
  readonly xMode: 'MOCK' | 'LIVE';
  readonly postingEnabled: boolean;
  readonly degradations: readonly DegradationReason[];
};

const X_CREDENTIAL_KEYS = [
  'X_API_KEY',
  'X_API_SECRET',
  'X_ACCESS_TOKEN',
  'X_ACCESS_TOKEN_SECRET',
] as const;

/**
 * What the system will *actually* do, versus what the environment asked for.
 *
 * ARCHITECTURE.md §8: missing credentials never block startup. A subsystem with no
 * key marks itself unavailable and the rest of the system runs. Crucially, the gap
 * between requested and effective is returned rather than silently applied — §36 of
 * the working brief: make the degradation visible.
 */
export function deriveEffectiveModes(config: Config): EffectiveModes {
  const degradations: DegradationReason[] = [];

  let aiMode = config.AI_MODE;
  if (aiMode === 'LIVE' && config.ANTHROPIC_API_KEY === undefined) {
    aiMode = 'MOCK';
    degradations.push({
      subsystem: 'ai',
      requested: 'LIVE',
      effective: 'MOCK',
      because:
        'ANTHROPIC_API_KEY is not set. Analyses will be deterministic canned output, clearly marked.',
    });
  }

  const missingXKeys = X_CREDENTIAL_KEYS.filter((k) => config[k] === undefined);
  let xMode = config.X_MODE;
  if (xMode === 'LIVE' && missingXKeys.length > 0) {
    xMode = 'MOCK';
    degradations.push({
      subsystem: 'x',
      requested: 'LIVE',
      effective: 'MOCK',
      because: `Missing X credentials: ${missingXKeys.join(', ')}. Outcome metrics come from fixtures.`,
    });
  } else if (xMode === 'LIVE') {
    /**
     * Present is not the same as valid.
     *
     * Added 2026-08-14, from a live failure. All four X variables were set, so this
     * function said LIVE, so the dashboard showed X as a working integration — and
     * every request 401'd, because `X_ACCESS_TOKEN` had been copied ten characters
     * short. "Four variables exist" was being treated as "the integration works".
     *
     * `ARCHITECTURE.md` §8 requires the badge to make degradation visible, and a badge
     * that reads LIVE over an integration that cannot authenticate is the same false
     * reassurance as a MOCK analysis rendered as real. Shape is checkable for free, so
     * it is checked here rather than discovered by a metered request.
     */
    const shapeProblems = credentialShapeProblems({
      apiKey: config.X_API_KEY,
      apiSecret: config.X_API_SECRET,
      accessToken: config.X_ACCESS_TOKEN,
      accessTokenSecret: config.X_ACCESS_TOKEN_SECRET,
    });
    if (shapeProblems.length > 0) {
      xMode = 'MOCK';
      degradations.push({
        subsystem: 'x',
        requested: 'LIVE',
        effective: 'MOCK',
        because: `X credentials are present but malformed, so they cannot authenticate: ${shapeProblems.join('; ')}`,
      });
    }
  }

  // X_ENABLE_POSTING is necessary but never sufficient. THREAT-MODEL.md §T-4:
  // publishing requires a per-post human action; this flag only decides whether the
  // capability exists at all.
  const postingEnabled = config.X_ENABLE_POSTING && xMode === 'LIVE';
  if (config.X_ENABLE_POSTING && xMode !== 'LIVE') {
    degradations.push({
      subsystem: 'x',
      requested: 'posting enabled',
      effective: 'posting unavailable',
      because: 'X_ENABLE_POSTING=true but X is not in effective LIVE mode.',
    });
  }

  if (config.GITHUB_TOKEN === undefined) {
    degradations.push({
      subsystem: 'github',
      requested: 'authenticated REST',
      effective: 'unauthenticated REST (60 req/hour)',
      because:
        'GITHUB_TOKEN is not set. .atom watching is unaffected and needs no token; only REST enrichment is capped.',
    });
  }

  if (config.NTFY_TOPIC === undefined) {
    degradations.push({
      subsystem: 'alerts',
      requested: 'push notification',
      effective: 'console + dashboard only',
      because: 'NTFY_TOPIC is not set.',
    });
  }

  return {
    dataMode: config.DATA_MODE,
    aiMode,
    xMode,
    postingEnabled,
    degradations,
  };
}

/** True when anything at all is mocked — drives the dashboard badge. */
export function isAnyModeMocked(modes: EffectiveModes): boolean {
  return modes.dataMode === 'MOCK' || modes.aiMode === 'MOCK' || modes.xMode === 'MOCK';
}

/**
 * `file:./data/signal-desk.db` → `./data/signal-desk.db`.
 * A non-`file:` URL is returned unchanged so a future Postgres URL passes through.
 */
export function databaseFilePath(databaseUrl: string): string {
  return databaseUrl.startsWith('file:') ? databaseUrl.slice('file:'.length) : databaseUrl;
}

/** `sk-ant-api03-abcd…wxyz` → `sk-a…wxyz`. Never log the middle. */
export function maskSecret(value: string | undefined): string {
  if (value === undefined) return '(not set)';
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
