import { safeFetch, USER_AGENT } from './http.js';
import type { AdapterContext } from './types.js';

/**
 * GitHub REST — **enrichment only, never watching**.
 *
 * SOURCE-INTELLIGENCE.md §1b measured the constraint that shapes this file:
 *
 *   `.atom` endpoints: no token, no visible quota  → this is how repos are watched
 *   REST unauthenticated: **60 requests/hour**     → exhausted by ~60 repos on one
 *                                                     hourly pass, so it can never
 *                                                     be the watch mechanism
 *   REST authenticated: 5,000/hour
 *
 * The budget is therefore tracked explicitly rather than discovered by getting a
 * 403. Star and push velocity (Phase 5's substitute for the X velocity signal that
 * pricing removed) is what this exists to fetch.
 */

export const UNAUTHENTICATED_HOURLY_LIMIT = 60;
export const AUTHENTICATED_HOURLY_LIMIT = 5000;

/**
 * Fraction of the hourly limit this client will spend.
 *
 * Unauthenticated, 60/hour is shared with anything else on the same IP, and being
 * rate-limited mid-run loses the whole enrichment pass rather than the last request.
 * Leaving headroom is cheaper than the retry.
 */
const BUDGET_FRACTION = 0.75;

export type RepoStats = {
  readonly fullName: string;
  readonly stars: number;
  readonly openIssues: number;
  readonly pushedAt: Date | undefined;
  readonly fetchedAt: Date;
};

export type RateLimitState = {
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: Date | undefined;
};

export class GithubBudgetExhaustedError extends Error {
  constructor(spent: number, budget: number) {
    super(
      `GitHub REST budget exhausted: ${String(spent)}/${String(budget)} requests used this hour. ` +
        `Enrichment is deferred, not retried — ingestion via .atom is unaffected and needs no token.`,
    );
    this.name = 'GithubBudgetExhaustedError';
  }
}

/**
 * A rate-limit-aware GitHub REST client.
 *
 * Stateful by design: the budget is per-hour and per-process, so it has to be
 * remembered between calls. It degrades by refusing to spend rather than by
 * throwing at the call site — an exhausted budget defers enrichment, and ingestion
 * carries on because it never depended on this.
 */
export class GithubApiClient {
  #spent = 0;
  #windowStartedAt: number;
  #lastRateLimit: RateLimitState | undefined;
  readonly #token: string | undefined;

  constructor(options: { token?: string | undefined; now?: Date } = {}) {
    this.#token = options.token;
    this.#windowStartedAt = (options.now ?? new Date()).getTime();
  }

  get authenticated(): boolean {
    return this.#token !== undefined;
  }

  get hourlyLimit(): number {
    return this.authenticated ? AUTHENTICATED_HOURLY_LIMIT : UNAUTHENTICATED_HOURLY_LIMIT;
  }

  get budget(): number {
    return Math.floor(this.hourlyLimit * BUDGET_FRACTION);
  }

  get spent(): number {
    return this.#spent;
  }

  get remaining(): number {
    return Math.max(0, this.budget - this.#spent);
  }

  /** What GitHub itself last told us, which may be lower than our own count. */
  get reportedRateLimit(): RateLimitState | undefined {
    return this.#lastRateLimit;
  }

  #rollWindow(now: Date): void {
    if (now.getTime() - this.#windowStartedAt >= 3_600_000) {
      this.#windowStartedAt = now.getTime();
      this.#spent = 0;
    }
  }

  canSpend(now: Date = new Date()): boolean {
    this.#rollWindow(now);
    return this.remaining > 0;
  }

  /** Repo metadata for velocity scoring. Returns undefined when out of budget. */
  async repoStats(fullName: string, context: AdapterContext): Promise<RepoStats | undefined> {
    if (!this.canSpend(context.now)) return undefined;

    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': USER_AGENT,
    };
    if (this.#token !== undefined) headers.authorization = `Bearer ${this.#token}`;

    this.#spent += 1;

    const response = await safeFetch(`https://api.github.com/repos/${fullName}`, {
      guard: context.guard,
      ...(context.fetchImpl !== undefined ? { fetchImpl: context.fetchImpl } : {}),
      timeoutMs: context.timeoutMs ?? 15_000,
      maxBytes: 1024 * 1024,
      extraHeaders: headers,
    });

    this.#recordRateLimit(response.rateLimitHeaders);

    if (response.status !== 200) return undefined;

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body) as unknown;
    } catch {
      return undefined;
    }

    const repo = parsed as Record<string, unknown>;
    const pushedAtRaw = typeof repo.pushed_at === 'string' ? repo.pushed_at : undefined;
    const pushedAt = pushedAtRaw === undefined ? undefined : new Date(pushedAtRaw);

    return {
      fullName,
      stars: typeof repo.stargazers_count === 'number' ? repo.stargazers_count : 0,
      openIssues: typeof repo.open_issues_count === 'number' ? repo.open_issues_count : 0,
      pushedAt: pushedAt !== undefined && !Number.isNaN(pushedAt.getTime()) ? pushedAt : undefined,
      fetchedAt: context.now,
    };
  }

  #recordRateLimit(headers: Record<string, string | undefined> | undefined): void {
    if (headers === undefined) return;
    const limit = Number.parseInt(headers['x-ratelimit-limit'] ?? '', 10);
    const remaining = Number.parseInt(headers['x-ratelimit-remaining'] ?? '', 10);
    const reset = Number.parseInt(headers['x-ratelimit-reset'] ?? '', 10);

    if (!Number.isFinite(limit) || !Number.isFinite(remaining)) return;

    this.#lastRateLimit = {
      limit,
      remaining,
      resetAt: Number.isFinite(reset) ? new Date(reset * 1000) : undefined,
    };

    // Trust GitHub over our own count when it says we have less. Another process on
    // the same IP shares this budget.
    if (remaining < this.remaining) {
      this.#spent = this.budget - remaining;
    }
  }
}

/** `https://github.com/vercel/next.js/releases.atom` → `vercel/next.js`. */
export function repoFromAtomUrl(url: string): string | undefined {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:releases|commits)/.exec(url);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return `${match[1]}/${match[2]}`;
}
