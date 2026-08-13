/**
 * Retry, backoff, and the per-source circuit breaker. THREAT-MODEL.md §T-10.
 *
 * Pure functions over explicit state, so the policy can be tested without waiting
 * for real time to pass and without a database. The caller owns the state; this file
 * owns the decisions.
 */

export type BreakerState = {
  readonly consecutiveFailures: number;
  readonly circuitOpenUntil: Date | null;
};

export type BackoffPolicy = {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly maxAttempts: number;
  /** Failures before the breaker opens. */
  readonly failureThreshold: number;
  /** How long the breaker stays open on first trip; doubles each further failure. */
  readonly openForMs: number;
  readonly maxOpenForMs: number;
};

/**
 * Defaults. **Starting guesses**, chosen to be polite rather than measured.
 *
 * The reasoning that is not a guess: a Priority-1 source polls every 5 minutes, so a
 * breaker that stays open for 30 minutes skips roughly six polls — long enough to
 * stop hammering a struggling host (§T-8), short enough that a transient outage does
 * not cost half a day of detection.
 */
export const DEFAULT_BACKOFF: BackoffPolicy = {
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxAttempts: 3,
  failureThreshold: 3,
  openForMs: 30 * 60 * 1000,
  maxOpenForMs: 6 * 60 * 60 * 1000,
};

/**
 * Delay before retry `attempt` (1-based), with full jitter.
 *
 * Jitter is not decoration. Sixty sources whose breakers trip in the same minute —
 * which is what a local network blip produces — would otherwise retry in lockstep
 * forever, turning one outage into a synchronised thundering herd against every
 * publisher at once.
 */
export function backoffDelayMs(
  attempt: number,
  policy: BackoffPolicy = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
  return Math.floor(exponential * (0.5 + random() * 0.5));
}

/**
 * Should this response be retried at all?
 *
 * 429 and 5xx are transient by definition. 4xx other than 429 is the server saying
 * the request is wrong, and repeating it unchanged is both useless and rude.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || (status >= 500 && status < 600);
}

/** Honour `Retry-After`, in either of its two documented forms. */
export function retryAfterMs(
  header: string | undefined,
  now: Date = new Date(),
): number | undefined {
  if (header === undefined) return undefined;

  const seconds = Number.parseInt(header, 10);
  if (Number.isFinite(seconds) && String(seconds) === header.trim()) {
    return Math.max(0, seconds * 1000);
  }

  const date = new Date(header);
  if (!Number.isNaN(date.getTime())) {
    return Math.max(0, date.getTime() - now.getTime());
  }

  return undefined;
}

export function isCircuitOpen(state: BreakerState, now: Date = new Date()): boolean {
  return state.circuitOpenUntil !== null && state.circuitOpenUntil.getTime() > now.getTime();
}

/** State after a successful fetch: the breaker resets completely. */
export function onSuccess(): BreakerState {
  return { consecutiveFailures: 0, circuitOpenUntil: null };
}

/**
 * State after a failed fetch.
 *
 * The open duration doubles with each failure past the threshold, capped. A source
 * that has been dead for a day is checked hourly rather than every five minutes —
 * but it is still checked, because a permanently-open breaker is indistinguishable
 * from a deleted source and would hide a recovery.
 */
export function onFailure(
  state: BreakerState,
  now: Date = new Date(),
  policy: BackoffPolicy = DEFAULT_BACKOFF,
): BreakerState {
  const consecutiveFailures = state.consecutiveFailures + 1;

  if (consecutiveFailures < policy.failureThreshold) {
    return { consecutiveFailures, circuitOpenUntil: null };
  }

  const overThreshold = consecutiveFailures - policy.failureThreshold;
  const openFor = Math.min(policy.openForMs * 2 ** overThreshold, policy.maxOpenForMs);

  return {
    consecutiveFailures,
    circuitOpenUntil: new Date(now.getTime() + openFor),
  };
}

/**
 * Scheduling jitter, as a fraction of the interval.
 *
 * Without it, every Priority-2 source fires at the same instant every fifteen
 * minutes: a self-inflicted burst that looks like a scraper from the far end and
 * makes latency measurement lumpy at this end.
 */
export const SCHEDULE_JITTER_FRACTION = 0.1;

export function jitteredIntervalMs(
  intervalSec: number,
  random: () => number = Math.random,
): number {
  const base = intervalSec * 1000;
  const spread = base * SCHEDULE_JITTER_FRACTION;
  return Math.max(1000, Math.floor(base - spread / 2 + random() * spread));
}

/** Is this source due? Compares against `lastCheckedAt` plus its jittered interval. */
export function isDue(
  source: { pollIntervalSec: number; lastCheckedAt: Date | null },
  now: Date,
  jitterMs = 0,
): boolean {
  if (source.lastCheckedAt === null) return true;
  const dueAt = source.lastCheckedAt.getTime() + source.pollIntervalSec * 1000 + jitterMs;
  return now.getTime() >= dueAt;
}
