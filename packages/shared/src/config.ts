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
 * Structural problems that make an X credential set impossible as written.
 *
 * ### Corrected 2026-08-14 — I was wrong, and the wrongness had teeth
 *
 * This function used to assert exact lengths: API key 25, secret 50, access-token
 * suffix 40, token secret 45. Those numbers came from a **worked example in X's 2011
 * signature documentation**, not from any specification. X's current credential
 * documentation states **no lengths at all** — verified by reading it.
 *
 * The operator's account repeatedly produced a 30-character access-token suffix. I
 * called that a truncated paste. It was not: `X_ACCESS_TOKEN` is 19 numeric digits, a
 * hyphen, and 30 characters, consistently, across regenerations.
 *
 * The damage was not the wrong belief, it was the **hard gate built on it** — the
 * `x:verify` CLI refused to send, so the one thing that could have corrected me was
 * the thing the check prevented. A guess that blocks its own falsification is worse
 * than no check.
 *
 * ### What actually fails, established by isolating the legs
 *
 * `POST /oauth/request_token` signs with the **consumer key and secret only** — the
 * access token is not involved. It returns `401 code 32`. Meanwhile an app-only Bearer
 * token returns `403 Unsupported Authentication`, which means the app is recognised.
 *
 * So the access token was never the problem. **OAuth 1.0a user-context is not
 * provisioned for this app**, which in the X developer portal means "User
 * authentication settings" has not been set up. Length was a red herring throughout.
 *
 * What survives here is only what is structurally impossible rather than merely
 * unfamiliar: an empty value, or an access token that is not `{numeric id}-{something}`.
 * Everything else is X's business, and the API is the only honest judge.
 */
export function credentialShapeProblems(credentials: {
  readonly apiKey: string | undefined;
  readonly apiSecret: string | undefined;
  readonly accessToken: string | undefined;
  readonly accessTokenSecret: string | undefined;
}): string[] {
  const problems: string[] = [];

  const present = (name: string, value: string | undefined): boolean => {
    if (value === undefined || value.trim() === '') {
      problems.push(`${name} is empty`);
      return false;
    }
    return true;
  };

  present('X_API_KEY', credentials.apiKey);
  present('X_API_SECRET', credentials.apiSecret);
  present('X_ACCESS_TOKEN_SECRET', credentials.accessTokenSecret);

  if (present('X_ACCESS_TOKEN', credentials.accessToken)) {
    const token = credentials.accessToken ?? '';
    const [userId, ...rest] = token.split('-');
    if (rest.length === 0) {
      problems.push('X_ACCESS_TOKEN has no "-" — the form is {numeric user id}-{secret}');
    } else if (!/^\d+$/.test(userId ?? '')) {
      problems.push('X_ACCESS_TOKEN does not start with a numeric user id');
    }
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
     * Present is not the same as valid — but "unfamiliar" is not the same as invalid.
     *
     * This branch used to degrade X to MOCK whenever the credential lengths differed
     * from an undocumented rule I had inferred from a 2011 example. That rule was
     * wrong (see `credentialShapeProblems`), and enforcing it made the dashboard
     * report a credential problem that did not exist while hiding the one that did.
     *
     * Only structurally impossible values degrade the mode now. Whether the
     * credentials actually authenticate is a question only the API can answer, and
     * `pnpm x:verify` is where that answer is obtained — visibly, once, on purpose.
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
