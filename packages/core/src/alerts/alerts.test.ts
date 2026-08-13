import { describe, it, expect } from 'vitest';
import {
  shouldSend,
  planAlerts,
  dedupeKey,
  inQuietHours,
  freshnessAlerts,
  eventAlert,
  DAILY_ALERT_CAP,
  FRESHNESS_THRESHOLD_HOURS,
  ALERT_TIERS,
  type Alert,
  type AlertContext,
} from './alerts.js';

/**
 * `ROADMAP.md` Phase 11 TESTS: "Tier routing, dedup, quiet hours, freshness alert
 * firing."
 *
 * The criterion that governs everything: "≤2 alerts per day on average — noise is the
 * failure mode, and an alert system the operator mutes has negative value."
 */

const NOON = new Date('2026-08-13T12:00:00');
const MIDNIGHT = new Date('2026-08-13T02:00:00');

function context(overrides: Partial<AlertContext> = {}): AlertContext {
  return {
    minPriority: 'urgent',
    alreadySent: new Set(),
    sentToday: 0,
    now: NOON,
    quietHours: false,
    ...overrides,
  };
}

const alert = (tier: Alert['tier'], fact = 'a fact'): Alert => ({
  tier,
  title: 'Title',
  body: 'Body',
  dedupeKey: dedupeKey(tier, fact),
  eventId: 1,
});

describe('tier routing', () => {
  it('ships SILENT by default — only urgent passes', () => {
    // The opposite of the usual default, and the only one consistent with "an alert
    // system he mutes has negative value". He opts into more, not out of noise.
    const ctx = context({ minPriority: 'urgent' });
    expect(shouldSend(alert('urgent'), ctx).send).toBe(true);
    for (const tier of ['high', 'trend', 'educational'] as const) {
      expect(shouldSend(alert(tier), ctx).send, tier).toBe(false);
    }
  });

  it('lets a lower threshold admit more tiers', () => {
    const ctx = context({ minPriority: 'trend' });
    expect(shouldSend(alert('urgent'), ctx).send).toBe(true);
    expect(shouldSend(alert('high'), ctx).send).toBe(true);
    expect(shouldSend(alert('trend'), ctx).send).toBe(true);
    expect(shouldSend(alert('educational'), ctx).send).toBe(false);
  });

  it('always explains a suppression', () => {
    for (const tier of ALERT_TIERS) {
      const decision = shouldSend(alert(tier), context());
      expect(decision.reason.length).toBeGreaterThan(15);
    }
  });
});

describe('deduplication', () => {
  it('alerts once per fact, however many times it is re-scored', () => {
    const one = alert('urgent', 'the same outage');
    const ctx = context({ alreadySent: new Set([one.dedupeKey]) });
    expect(shouldSend(one, ctx).send).toBe(false);
    expect(shouldSend(one, ctx).suppressedBy).toBe('duplicate');
  });

  it('keys on the FACT, not the message text', () => {
    // Two alerts about the same outage phrased differently are one alert. The operator
    // does not care that the wording changed.
    expect(dedupeKey('urgent', 'API outage')).toBe(dedupeKey('urgent', 'api outage  '));
    expect(dedupeKey('urgent', 'API outage')).not.toBe(dedupeKey('urgent', 'DB outage'));
  });

  it('collapses duplicates WITHIN a single batch', () => {
    // Deduping only against history would let one run fire the same alert twice.
    const run = planAlerts([alert('urgent', 'x'), alert('urgent', 'x')], context());
    expect(run.sent).toHaveLength(1);
    expect(run.byReason.duplicate).toBe(1);
  });
});

describe('quiet hours', () => {
  it('detects the window across midnight', () => {
    expect(inQuietHours(new Date('2026-08-13T23:30:00'))).toBe(true);
    expect(inQuietHours(new Date('2026-08-13T02:00:00'))).toBe(true);
    expect(inQuietHours(new Date('2026-08-13T06:59:00'))).toBe(true);
    expect(inQuietHours(new Date('2026-08-13T12:00:00'))).toBe(false);
    expect(inQuietHours(new Date('2026-08-13T22:00:00'))).toBe(false);
  });

  it('holds back everything except urgent', () => {
    const ctx = context({ quietHours: true, minPriority: 'educational', now: MIDNIGHT });
    expect(shouldSend(alert('high'), ctx).suppressedBy).toBe('quiet_hours');
    expect(shouldSend(alert('trend'), ctx).suppressedBy).toBe('quiet_hours');
  });

  it('lets urgent through at 3am', () => {
    // An outage in a service he depends on is exactly what he would want waking him
    // for. A quiet-hours rule that swallowed it would make the channel untrustworthy
    // in the other direction.
    const ctx = context({ quietHours: true, now: MIDNIGHT });
    expect(shouldSend(alert('urgent'), ctx).send).toBe(true);
  });
});

describe('the daily cap', () => {
  it('stops a runaway', () => {
    const ctx = context({ sentToday: DAILY_ALERT_CAP });
    expect(shouldSend(alert('urgent'), ctx).suppressedBy).toBe('daily_cap');
  });

  it('SURFACES the cap rather than silently dropping', () => {
    // Hitting the cap is information about the tiering being wrong. A run that hid it
    // would let the system look calm while failing.
    const run = planAlerts(
      Array.from({ length: 8 }, (_v, i) => alert('urgent', `fact-${String(i)}`)),
      context(),
    );
    expect(run.sent).toHaveLength(DAILY_ALERT_CAP);
    expect(run.suppressed.length).toBe(8 - DAILY_ALERT_CAP);
    expect(run.byReason.daily_cap).toBe(8 - DAILY_ALERT_CAP);
    expect(run.suppressed[0]?.decision.reason).toContain('tiering is wrong');
  });

  it('is set above the two-per-day average on purpose', () => {
    // The criterion is an AVERAGE over two weeks. A hard cap at the average would clip
    // every genuinely busy day to look like an average one, which would make the
    // measurement meaningless rather than the system quieter.
    expect(DAILY_ALERT_CAP).toBeGreaterThan(2);
  });
});

describe('source-freshness alerting (THREAT-MODEL §T-9)', () => {
  it('fires for a Priority-1 source silent past 6 hours', () => {
    // The acceptance criterion, directly.
    expect(FRESHNESS_THRESHOLD_HOURS[1]).toBe(6);
    const alerts = freshnessAlerts([
      { sourceId: 'anthropic-news', priority: 1, hoursSinceSuccess: 7, consecutiveFailures: 3 },
    ]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.tier).toBe('urgent');
    expect(alerts[0]?.title).toContain('anthropic-news');
  });

  it('does NOT fire for a Priority-1 source silent 5 hours', () => {
    expect(
      freshnessAlerts([
        { sourceId: 'anthropic-news', priority: 1, hoursSinceSuccess: 5, consecutiveFailures: 0 },
      ]),
    ).toEqual([]);
  });

  it('uses 24 hours for Priority-2', () => {
    expect(FRESHNESS_THRESHOLD_HOURS[2]).toBe(24);
    expect(
      freshnessAlerts([
        { sourceId: 's', priority: 2, hoursSinceSuccess: 20, consecutiveFailures: 0 },
      ]),
    ).toEqual([]);
    expect(
      freshnessAlerts([
        { sourceId: 's', priority: 2, hoursSinceSuccess: 30, consecutiveFailures: 0 },
      ]),
    ).toHaveLength(1);
  });

  it('treats NEVER-succeeded as the loudest case', () => {
    // A source that has produced nothing since it was configured looks identical to a
    // quiet one on a dashboard, and it is the failure that hides longest.
    const alerts = freshnessAlerts([
      { sourceId: 'broken', priority: 3, hoursSinceSuccess: null, consecutiveFailures: 12 },
    ]);
    expect(alerts[0]?.tier).toBe('urgent');
    expect(alerts[0]?.title).toContain('NEVER');
    expect(alerts[0]?.body).toContain('it is not quiet, it is broken');
  });

  it('does not wake him for a low-priority source', () => {
    const alerts = freshnessAlerts([
      { sourceId: 's', priority: 3, hoursSinceSuccess: 100, consecutiveFailures: 4 },
    ]);
    expect(alerts[0]?.tier).toBe('high');
  });

  it('is silent when everything is fresh', () => {
    expect(
      freshnessAlerts([
        { sourceId: 'a', priority: 1, hoursSinceSuccess: 1, consecutiveFailures: 0 },
        { sourceId: 'b', priority: 2, hoursSinceSuccess: 5, consecutiveFailures: 0 },
      ]),
    ).toEqual([]);
  });
});

describe('event alerts', () => {
  const base = {
    eventId: 1,
    title: 'Anthropic ships Claude Opus 5',
    combined: 80,
    confidence: 'HIGH',
    recommendedAction: 'POST_NOW',
    manualFlag: false,
    category: 'ai',
  };

  it('alerts on POST_NOW', () => {
    expect(eventAlert(base)?.tier).toBe('urgent');
  });

  it('does NOT alert on POST_SOON', () => {
    // POST_SOON has no deadline. Interrupting for it trains the operator to ignore
    // interruptions, which is the exact failure this phase names.
    expect(eventAlert({ ...base, recommendedAction: 'POST_SOON' })).toBeUndefined();
  });

  it('does not alert on WAIT, VERIFY, or DONT_POST', () => {
    for (const action of ['WAIT', 'VERIFY', 'DONT_POST']) {
      expect(eventAlert({ ...base, recommendedAction: action }), action).toBeUndefined();
    }
  });

  it('alerts on a manual flag whatever the recommendation', () => {
    // Urgent not because it is exciting, but because publishing it wrongly is
    // unrecoverable — the interruption buys a human decision before anything happens.
    const flagged = eventAlert({ ...base, recommendedAction: 'VERIFY', manualFlag: true });
    expect(flagged?.tier).toBe('urgent');
    expect(flagged?.title).toContain('human review');
  });

  it('alerts at most once per event', () => {
    const first = eventAlert(base);
    const second = eventAlert(base);
    expect(first?.dedupeKey).toBe(second?.dedupeKey);
  });
});

describe('a realistic day stays quiet', () => {
  it('fires very few alerts across a plausible mix', () => {
    // The whole point of the phase: most of a day produces nothing worth interrupting.
    const events = [
      {
        ...{ eventId: 1, title: 'a', combined: 80, confidence: 'HIGH', category: 'ai' },
        recommendedAction: 'POST_NOW',
        manualFlag: false,
      },
      {
        ...{ eventId: 2, title: 'b', combined: 60, confidence: 'MED', category: 'ai' },
        recommendedAction: 'POST_SOON',
        manualFlag: false,
      },
      {
        ...{ eventId: 3, title: 'c', combined: 50, confidence: 'LOW', category: 'ai' },
        recommendedAction: 'WAIT',
        manualFlag: false,
      },
      {
        ...{ eventId: 4, title: 'd', combined: 40, confidence: 'LOW', category: 'ai' },
        recommendedAction: 'DONT_POST',
        manualFlag: false,
      },
      {
        ...{ eventId: 5, title: 'e', combined: 55, confidence: 'MED', category: 'ai' },
        recommendedAction: 'POST_SOON',
        manualFlag: false,
      },
      {
        ...{ eventId: 6, title: 'f', combined: 70, confidence: 'MED', category: 'ai' },
        recommendedAction: 'VERIFY',
        manualFlag: true,
      },
    ];

    const candidates = events.map(eventAlert).filter((a): a is Alert => a !== undefined);
    const run = planAlerts(candidates, context());

    // Six events, two interruptions. That ratio is the product.
    expect(run.sent).toHaveLength(2);
  });
});
