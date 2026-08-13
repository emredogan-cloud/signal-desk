import { describe, it, expect } from 'vitest';
import type { BreakerState } from './resilience.js';
import {
  backoffDelayMs,
  isRetryableStatus,
  retryAfterMs,
  isCircuitOpen,
  onSuccess,
  onFailure,
  isDue,
  jitteredIntervalMs,
  DEFAULT_BACKOFF,
  SCHEDULE_JITTER_FRACTION,
} from './resilience.js';

/**
 * ROADMAP.md Phase 3 TESTS: "429 with backoff ... Scheduler interval and jitter
 * logic." ACCEPTANCE: "Circuit breaker demonstrably opens on a source returning
 * persistent 500s."
 *
 * All of it is pure over explicit state, so none of it waits for real time to pass.
 */

const NOW = new Date('2026-08-13T12:00:00Z');

describe('backoff', () => {
  it('grows exponentially', () => {
    const noJitter = () => 1;
    expect(backoffDelayMs(1, DEFAULT_BACKOFF, noJitter)).toBe(1000);
    expect(backoffDelayMs(2, DEFAULT_BACKOFF, noJitter)).toBe(2000);
    expect(backoffDelayMs(3, DEFAULT_BACKOFF, noJitter)).toBe(4000);
  });

  it('is capped', () => {
    expect(backoffDelayMs(20, DEFAULT_BACKOFF, () => 1)).toBe(DEFAULT_BACKOFF.maxDelayMs);
  });

  it('applies jitter within half the computed delay', () => {
    // Sixty sources whose breakers trip in the same minute would otherwise retry in
    // lockstep forever, turning one local blip into a synchronised burst against
    // every publisher at once.
    expect(backoffDelayMs(3, DEFAULT_BACKOFF, () => 0)).toBe(2000);
    expect(backoffDelayMs(3, DEFAULT_BACKOFF, () => 1)).toBe(4000);
  });
});

describe('isRetryableStatus', () => {
  it.each([429, 408, 500, 502, 503, 504])('retries %i', (status) => {
    expect(isRetryableStatus(status)).toBe(true);
  });

  it.each([400, 401, 403, 404, 410, 422])('does not retry %i', (status) => {
    // A 4xx other than 429 means the request is wrong. Repeating it unchanged is
    // useless and, against a publisher who is watching, rude.
    expect(isRetryableStatus(status)).toBe(false);
  });

  it('does not retry a success', () => {
    expect(isRetryableStatus(200)).toBe(false);
    expect(isRetryableStatus(304)).toBe(false);
  });
});

describe('retryAfterMs', () => {
  it('reads the delta-seconds form', () => {
    expect(retryAfterMs('120', NOW)).toBe(120_000);
  });

  it('reads the HTTP-date form', () => {
    expect(retryAfterMs('Thu, 13 Aug 2026 12:02:00 GMT', NOW)).toBe(120_000);
  });

  it('never returns a negative delay for a date in the past', () => {
    expect(retryAfterMs('Thu, 13 Aug 2026 11:00:00 GMT', NOW)).toBe(0);
  });

  it('returns undefined for an absent or unparseable header', () => {
    expect(retryAfterMs(undefined, NOW)).toBeUndefined();
    expect(retryAfterMs('soon please', NOW)).toBeUndefined();
  });
});

describe('circuit breaker', () => {
  const closed: BreakerState = { consecutiveFailures: 0, circuitOpenUntil: null };

  it('stays closed below the failure threshold', () => {
    let state = closed;
    for (let i = 1; i < DEFAULT_BACKOFF.failureThreshold; i++) {
      state = onFailure(state, NOW);
      expect(state.circuitOpenUntil).toBeNull();
      expect(isCircuitOpen(state, NOW)).toBe(false);
    }
  });

  it('opens on persistent failures', () => {
    // ROADMAP.md Phase 3 acceptance, stated as a unit test because a source that
    // returns persistent 500s on demand is not something the real network provides.
    let state = closed;
    for (let i = 0; i < DEFAULT_BACKOFF.failureThreshold; i++) {
      state = onFailure(state, NOW);
    }

    expect(state.consecutiveFailures).toBe(DEFAULT_BACKOFF.failureThreshold);
    expect(state.circuitOpenUntil).not.toBeNull();
    expect(isCircuitOpen(state, NOW)).toBe(true);
  });

  it('backs off further with each failure past the threshold', () => {
    let state = closed;
    for (let i = 0; i < DEFAULT_BACKOFF.failureThreshold; i++) state = onFailure(state, NOW);
    const firstOpen = state.circuitOpenUntil?.getTime() ?? 0;

    state = onFailure(state, NOW);
    const secondOpen = state.circuitOpenUntil?.getTime() ?? 0;

    expect(secondOpen - NOW.getTime()).toBe((firstOpen - NOW.getTime()) * 2);
  });

  it('caps how long the breaker stays open', () => {
    let state = closed;
    for (let i = 0; i < 40; i++) state = onFailure(state, NOW);

    // A permanently-open breaker is indistinguishable from a deleted source, and
    // would hide a recovery forever.
    expect((state.circuitOpenUntil?.getTime() ?? 0) - NOW.getTime()).toBe(
      DEFAULT_BACKOFF.maxOpenForMs,
    );
  });

  it('closes completely on success', () => {
    let state = closed;
    for (let i = 0; i < 10; i++) state = onFailure(state, NOW);
    expect(isCircuitOpen(state, NOW)).toBe(true);

    state = onSuccess();
    expect(state).toEqual({ consecutiveFailures: 0, circuitOpenUntil: null });
    expect(isCircuitOpen(state, NOW)).toBe(false);
  });

  it('reports itself closed once the open window has passed', () => {
    let state = closed;
    for (let i = 0; i < DEFAULT_BACKOFF.failureThreshold; i++) state = onFailure(state, NOW);

    const later = new Date(NOW.getTime() + DEFAULT_BACKOFF.openForMs + 1000);
    expect(isCircuitOpen(state, later)).toBe(false);
  });
});

describe('scheduling', () => {
  it('treats a never-checked source as due', () => {
    expect(isDue({ pollIntervalSec: 300, lastCheckedAt: null }, NOW)).toBe(true);
  });

  it('is not due before the interval has elapsed', () => {
    const checked = new Date(NOW.getTime() - 100_000);
    expect(isDue({ pollIntervalSec: 300, lastCheckedAt: checked }, NOW)).toBe(false);
  });

  it('is due once the interval has elapsed', () => {
    const checked = new Date(NOW.getTime() - 301_000);
    expect(isDue({ pollIntervalSec: 300, lastCheckedAt: checked }, NOW)).toBe(true);
  });

  it('respects jitter at the boundary', () => {
    const checked = new Date(NOW.getTime() - 300_000);
    expect(isDue({ pollIntervalSec: 300, lastCheckedAt: checked }, NOW, 5000)).toBe(false);
    expect(isDue({ pollIntervalSec: 300, lastCheckedAt: checked }, NOW, -5000)).toBe(true);
  });

  it('spreads intervals around the configured value', () => {
    const low = jitteredIntervalMs(300, () => 0);
    const high = jitteredIntervalMs(300, () => 1);
    const mid = jitteredIntervalMs(300, () => 0.5);

    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
    expect(high - low).toBeCloseTo(300_000 * SCHEDULE_JITTER_FRACTION, -1);
  });

  it('never produces an interval below one second', () => {
    expect(jitteredIntervalMs(0, () => 0)).toBeGreaterThanOrEqual(1000);
  });

  it('keeps Priority-1 sources on a five-minute cadence within jitter', () => {
    for (let i = 0; i < 100; i++) {
      const interval = jitteredIntervalMs(300, Math.random);
      expect(interval).toBeGreaterThan(280_000);
      expect(interval).toBeLessThan(320_000);
    }
  });
});
