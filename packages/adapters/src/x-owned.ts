import { createHmac, randomBytes } from 'node:crypto';
import { safeFetch, type SafeFetchOptions } from './http.js';

/**
 * X owned reads. **Reads only. This module contains no write verb and no post body.**
 *
 * ## Why this file did not exist until 2026-08-14
 *
 * `packages/adapters/src/index.ts` has advertised `XOwnedReadsAdapter` as a Phase-12
 * component since Phase 3, and PROJECT-MEMORY recorded Phase 12 complete. It was not
 * built, because there was no credential to build it against: the analytics loop ran
 * on fixtures and said so. The operator supplying real keys is what made the gap
 * matter — `X_MODE=LIVE` was configuring a subsystem that made no requests, which is
 * the worst kind of green light. Written now so that "X is configured" can be a
 * verified claim rather than a parsed variable.
 *
 * ## Why OAuth 1.0a rather than the bearer token
 *
 * A bearer token authenticates the *app*; these endpoints answer "who am I" and "how
 * did my posts do", which are questions only a *user* context can ask. OAuth 1.0a with
 * all four credentials is what X's user-context endpoints accept, so all four being
 * present in `.env` is a requirement and not a redundancy.
 *
 * ## Cost — the reason this module counts before it calls
 *
 * X is pay-per-use with no free tier (SOURCE-INTELLIGENCE.md §0). There is no plan cap
 * to bump into, so the only thing between a loop bug and a bill is this module.
 * Every request is priced *before* it is sent, checked against the remaining daily
 * budget, and recorded after. A caller cannot opt out: `spend` is a required argument,
 * not an option bag with a default.
 */

/** Percent-encoding as OAuth 1.0a specifies it — stricter than `encodeURIComponent`. */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export type XCredentials = {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly accessToken: string;
  readonly accessTokenSecret: string;
};

/**
 * Published pay-per-use prices, USD per request. ENV-HANDBOOK.md §4.
 *
 * Hard-coded for the same reason `MODEL_PRICING` is: a spend guard that needs a
 * network call to decide whether it can afford a network call cannot bootstrap.
 * Re-check these against `docs.x.com` when the bill disagrees with the ledger.
 */
export const X_REQUEST_PRICE_USD = {
  owned_read: 0.001,
  post_read: 0.005,
  user_read: 0.01,
  trends: 0.01,
} as const;

export type XRequestKind = keyof typeof X_REQUEST_PRICE_USD;

export class XBudgetExceeded extends Error {
  constructor(
    readonly spentTodayUsd: number,
    readonly budgetUsd: number,
    readonly priceUsd: number,
  ) {
    super(
      `X daily budget would be exceeded: $${spentTodayUsd.toFixed(4)} spent, ` +
        `$${priceUsd.toFixed(4)} requested, $${budgetUsd.toFixed(2)} ceiling`,
    );
    this.name = 'XBudgetExceeded';
  }
}

export class XApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`X API returned ${status}`);
    this.name = 'XApiError';
  }
}

/**
 * The spend hook. Injected rather than imported so this package keeps its "adapters
 * do I/O, they do not own the database" shape — and so the unit tests can prove the
 * ceiling holds without a database at all.
 */
export type XSpendAccount = {
  /** USD already spent against the X budget today. */
  spentTodayUsd(): number;
  /** The ceiling, from `X_DAILY_BUDGET_USD`. */
  budgetUsd(): number;
  /** Called after a request is sent — including when it fails. X bills attempts. */
  record(kind: XRequestKind, priceUsd: number, endpoint: string, status: number): void;
};

/** Deterministic parts of an OAuth 1.0a signature, injectable for tests. */
export type OAuthNonceSource = {
  nonce(): string;
  timestampSeconds(): number;
};

const DEFAULT_NONCE: OAuthNonceSource = {
  nonce: () => randomBytes(16).toString('hex'),
  timestampSeconds: () => Math.floor(Date.now() / 1000),
};

/**
 * The signature base string — `METHOD&url&normalised-params`, each part encoded once.
 *
 * Exported because this is where OAuth 1.0a implementations actually go wrong, and the
 * failure is a bare `401` with no indication of which of the three parts was built
 * incorrectly. Sorting is by encoded key, then by encoded value for repeated keys,
 * which is the ordering RFC 5849 §3.4.1.3.2 specifies.
 */
export function signatureBaseString(
  method: string,
  url: string,
  params: Record<string, string>,
): string {
  const normalised = Object.keys(params)
    .map((key) => [percentEncode(key), percentEncode(params[key] ?? '')] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  return [method, percentEncode(url), percentEncode(normalised)].join('&');
}

/**
 * Build the `Authorization: OAuth ...` header for a signed request.
 *
 * Exported for the test that pins it against RFC 5849's worked example — a signature
 * implementation that is only ever checked by "the live call worked" is a
 * implementation whose failure mode is a 401 with no diagnosis.
 */
export function oauthHeader(
  method: 'GET',
  url: string,
  queryParams: Record<string, string>,
  credentials: XCredentials,
  source: OAuthNonceSource = DEFAULT_NONCE,
): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: credentials.apiKey,
    oauth_nonce: source.nonce(),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(source.timestampSeconds()),
    oauth_token: credentials.accessToken,
    oauth_version: '1.0',
  };

  // The signature covers the query string as well as the OAuth parameters. Signing
  // only the OAuth block produces a header that looks right and 401s on any endpoint
  // that takes a parameter.
  const baseString = signatureBaseString(method, url, { ...oauthParams, ...queryParams });
  const signingKey = `${percentEncode(credentials.apiSecret)}&${percentEncode(
    credentials.accessTokenSecret,
  )}`;
  const signature = createHmac('sha1', signingKey).update(baseString).digest('base64');

  const header: Record<string, string> = { ...oauthParams, oauth_signature: signature };
  return `OAuth ${Object.keys(header)
    .sort()
    .map((key) => `${percentEncode(key)}="${percentEncode(header[key] ?? '')}"`)
    .join(', ')}`;
}

export const X_API_BASE = 'https://api.x.com';

export type XRateLimit = {
  readonly limit: number | undefined;
  readonly remaining: number | undefined;
  readonly resetAt: Date | undefined;
};

export type XResponse<T> = {
  readonly data: T;
  readonly rateLimit: XRateLimit;
  readonly priceUsd: number;
  readonly status: number;
};

function readRateLimit(headers: Record<string, string | undefined> | undefined): XRateLimit {
  const num = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const reset = num(headers?.['x-rate-limit-reset']);
  return {
    limit: num(headers?.['x-rate-limit-limit']),
    remaining: num(headers?.['x-rate-limit-remaining']),
    resetAt: reset === undefined ? undefined : new Date(reset * 1000),
  };
}

export type XGetOptions = {
  readonly credentials: XCredentials;
  readonly spend: XSpendAccount;
  readonly kind: XRequestKind;
  readonly query?: Record<string, string>;
  readonly nonceSource?: OAuthNonceSource;
  readonly fetchOptions?: SafeFetchOptions;
};

/**
 * One signed GET, priced before it leaves and recorded after it lands.
 *
 * The order matters: the ceiling is checked first and throws, so a caller in a loop
 * stops at the budget rather than at the invoice. Spend is recorded even on a 4xx
 * because a rejected request is still a billed request — recording only successes is
 * how a ledger drifts under exactly the conditions that make it matter.
 */
export async function xGet<T>(path: string, options: XGetOptions): Promise<XResponse<T>> {
  const price = X_REQUEST_PRICE_USD[options.kind];
  const spentToday = options.spend.spentTodayUsd();
  const budget = options.spend.budgetUsd();

  if (spentToday + price > budget) {
    throw new XBudgetExceeded(spentToday, budget, price);
  }

  const url = `${X_API_BASE}${path}`;
  const query = options.query ?? {};
  const authorization = oauthHeader('GET', url, query, options.credentials, options.nonceSource);

  const search = new URLSearchParams(query).toString();
  const result = await safeFetch(search === '' ? url : `${url}?${search}`, {
    ...options.fetchOptions,
    extraHeaders: {
      authorization,
      accept: 'application/json',
      ...options.fetchOptions?.extraHeaders,
    },
  });

  options.spend.record(options.kind, price, path, result.status);

  if (result.status < 200 || result.status >= 300) {
    throw new XApiError(result.status, result.body.slice(0, 500));
  }

  const parsed = JSON.parse(result.body) as { data: T };
  return {
    data: parsed.data,
    rateLimit: readRateLimit(result.rateLimitHeaders),
    priceUsd: price,
    status: result.status,
  };
}

/**
 * Moved to `@signal-desk/shared` on 2026-08-14.
 *
 * It validates configuration, not transport, and `deriveEffectiveModes` needs it to
 * decide whether X is *really* live — which is the difference between a dashboard
 * badge that is true and one that is merely optimistic. Re-exported here so the client
 * and its tests keep one import path.
 */
export { X_CREDENTIAL_SHAPE, credentialShapeProblems } from '@signal-desk/shared';

export type XAccount = {
  readonly id: string;
  readonly username: string;
  readonly name: string;
};

/**
 * Resolve the account these credentials actually belong to. The cheapest call that
 * proves authentication works, and the only one worth making before anything else:
 * every other X operation is meaningless if this returns a different account than the
 * operator expects.
 *
 * Priced as a **`user_read` ($0.010), not an `owned_read` ($0.001)**, deliberately.
 * `/2/users/me` plausibly bills as either, and a budget guard that guesses the cheaper
 * of two prices under-counts by 10× on every call. Round against yourself.
 */
export async function verifyCredentials(
  credentials: XCredentials,
  spend: XSpendAccount,
  fetchOptions?: SafeFetchOptions,
): Promise<XResponse<XAccount>> {
  return xGet<XAccount>('/2/users/me', {
    credentials,
    spend,
    kind: 'user_read',
    ...(fetchOptions !== undefined ? { fetchOptions } : {}),
  });
}
