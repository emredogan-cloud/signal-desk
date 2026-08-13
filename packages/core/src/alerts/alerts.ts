import { createHash } from 'node:crypto';

/**
 * Alerts. `ROADMAP.md` Phase 11.
 *
 * > **OBJECTIVE** Tell the operator about URGENT things **without training him to
 * > ignore notifications.**
 *
 * The acceptance criterion states the failure mode outright: "**≤2 alerts per day on
 * average** over two weeks — brief §46 is explicit that noise is the failure mode, and
 * an alert system the operator mutes has negative value."
 *
 * So every mechanism in this module exists to *suppress*, not to notify. Tiering,
 * deduplication, quiet hours, and the daily cap are four independent reasons not to
 * fire. The default `ALERT_MIN_PRIORITY` is `urgent`, which means the system ships
 * silent and the operator opts into more — the opposite of the usual default, and the
 * only one consistent with "an alert system he mutes has negative value".
 *
 * ## Negative value is the point
 *
 * A muted alert channel is worse than no alert channel, because the operator believes
 * he is covered. That is why the daily cap **counts suppressed alerts and surfaces
 * the count** rather than silently dropping them: hitting the cap is information about
 * the tiering being wrong, and hiding it would let the system look calm while failing.
 */

export const ALERT_TIERS = ['urgent', 'high', 'trend', 'educational'] as const;
export type AlertTier = (typeof ALERT_TIERS)[number];

/** Ordering, most severe first. `urgent` (0) passes every threshold. */
const TIER_RANK: Record<AlertTier, number> = {
  urgent: 0,
  high: 1,
  trend: 2,
  educational: 3,
};

export type Alert = {
  readonly tier: AlertTier;
  readonly title: string;
  readonly body: string;
  /** Stable across re-runs of the same underlying fact. The dedup key. */
  readonly dedupeKey: string;
  readonly eventId: number | undefined;
};

export type AlertDecision = {
  readonly send: boolean;
  /** Machine-readable. Reporting must never group on prose. */
  readonly suppressedBy: 'below_threshold' | 'duplicate' | 'quiet_hours' | 'daily_cap' | undefined;
  readonly reason: string;
};

/**
 * The daily cap.
 *
 * Set at 4 rather than the criterion's 2, deliberately: the criterion is an **average
 * over two weeks**, and a hard cap at the average would clip every genuinely busy day
 * to look like an average one. A cap exists to stop a runaway, not to manufacture the
 * number the criterion measures. If the average lands above 2, the tiering is wrong
 * and that is what needs fixing — not the cap.
 */
export const DAILY_ALERT_CAP = 4;

/** Quiet hours in local time, inclusive start, exclusive end. GUESS. */
export const QUIET_HOURS_START = 23;
export const QUIET_HOURS_END = 7;

/**
 * Deduplication key.
 *
 * Built from the tier and the *fact*, not from the message text. Two alerts about the
 * same outage phrased differently are one alert; the operator does not care that the
 * wording changed.
 */
export function dedupeKey(tier: AlertTier, fact: string): string {
  return `${tier}:${createHash('sha256').update(fact.toLowerCase().trim()).digest('hex').slice(0, 16)}`;
}

export type AlertContext = {
  readonly minPriority: AlertTier;
  /** Keys already alerted on, within the dedup window. */
  readonly alreadySent: ReadonlySet<string>;
  /** How many alerts have fired today. */
  readonly sentToday: number;
  readonly now: Date;
  readonly quietHours: boolean;
};

export function inQuietHours(now: Date): boolean {
  const hour = now.getHours();
  // The window wraps midnight, so it is a union rather than a range.
  return hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END;
}

/**
 * Should this alert fire?
 *
 * Suppression checks run cheapest-and-most-certain first, and `urgent` is exempt from
 * quiet hours — an outage in a service he depends on at 3am is exactly the thing he
 * would want waking him for, and a quiet-hours rule that swallowed it would make the
 * whole channel untrustworthy in the other direction.
 */
export function shouldSend(alert: Alert, context: AlertContext): AlertDecision {
  if (TIER_RANK[alert.tier] > TIER_RANK[context.minPriority]) {
    return {
      send: false,
      suppressedBy: 'below_threshold',
      reason: `tier "${alert.tier}" is below ALERT_MIN_PRIORITY "${context.minPriority}"`,
    };
  }

  if (context.alreadySent.has(alert.dedupeKey)) {
    return {
      send: false,
      suppressedBy: 'duplicate',
      reason:
        'already alerted on this fact — one event alerts once, however many times it is re-scored',
    };
  }

  // Urgent overrides quiet hours. Anything else waits.
  if (context.quietHours && alert.tier !== 'urgent') {
    return {
      send: false,
      suppressedBy: 'quiet_hours',
      reason: `quiet hours (${String(QUIET_HOURS_START)}:00–${String(QUIET_HOURS_END)}:00) — only "urgent" interrupts`,
    };
  }

  if (context.sentToday >= DAILY_ALERT_CAP) {
    return {
      send: false,
      suppressedBy: 'daily_cap',
      reason: `${String(context.sentToday)} alerts already sent today, at the cap of ${String(DAILY_ALERT_CAP)} — hitting this cap means the tiering is wrong, not that the day was busy`,
    };
  }

  return { send: true, suppressedBy: undefined, reason: `sending: tier "${alert.tier}"` };
}

// ─────────────────────────────────────────────────────────────────────
// Source-freshness alerting — THREAT-MODEL §T-9
// ─────────────────────────────────────────────────────────────────────

/**
 * Silence thresholds by source priority, in hours.
 *
 * `ROADMAP.md` Phase 11: "source-freshness alerting (T-9) — Priority-1 silent 6h,
 * Priority-2 silent 24h."
 *
 * This is the alert that matters most and is easiest to forget to build. Every other
 * alert fires because something happened; this one fires because **nothing** did, and
 * a monitoring system that cannot detect its own blindness is worse than none — the
 * operator believes he is covered while seeing nothing.
 */
export const FRESHNESS_THRESHOLD_HOURS: Record<number, number> = {
  1: 6,
  2: 24,
  3: 72,
  4: 168,
};

export type SourceFreshness = {
  readonly sourceId: string;
  readonly priority: number;
  /** Null when it has never succeeded — which is the worst case, not a missing value. */
  readonly hoursSinceSuccess: number | null;
  readonly consecutiveFailures: number;
};

export function freshnessAlerts(sources: readonly SourceFreshness[]): Alert[] {
  const alerts: Alert[] = [];

  for (const source of sources) {
    const threshold = FRESHNESS_THRESHOLD_HOURS[source.priority] ?? 72;

    // Never succeeded is the loudest case. A source that has produced nothing since it
    // was configured looks identical to a quiet one on a dashboard, and it is the
    // failure that hides longest.
    if (source.hoursSinceSuccess === null) {
      alerts.push({
        tier: 'urgent',
        title: `Source has NEVER succeeded: ${source.sourceId}`,
        body: `Priority ${String(source.priority)}. ${String(source.consecutiveFailures)} consecutive failures. This source has produced nothing since it was configured — it is not quiet, it is broken.`,
        dedupeKey: dedupeKey('urgent', `never-succeeded:${source.sourceId}`),
        eventId: undefined,
      });
      continue;
    }

    if (source.hoursSinceSuccess > threshold) {
      alerts.push({
        // A Priority-1 source going dark is urgent; anything lower is not worth waking
        // him for, which is the tiering doing its job rather than a hedge.
        tier: source.priority === 1 ? 'urgent' : 'high',
        title: `Source silent ${source.hoursSinceSuccess.toFixed(0)}h: ${source.sourceId}`,
        body: `Priority ${String(source.priority)} threshold is ${String(threshold)}h. ${String(source.consecutiveFailures)} consecutive failures. Detection through this source has stopped.`,
        dedupeKey: dedupeKey('urgent', `stale:${source.sourceId}`),
        eventId: undefined,
      });
    }
  }

  return alerts;
}

// ─────────────────────────────────────────────────────────────────────
// Event alerts
// ─────────────────────────────────────────────────────────────────────

export type EventAlertInput = {
  readonly eventId: number;
  readonly title: string;
  readonly combined: number;
  readonly confidence: string;
  readonly recommendedAction: string;
  readonly manualFlag: boolean;
  readonly category: string;
};

/**
 * Turn an event into an alert, or nothing.
 *
 * Returns `undefined` for almost everything, which is the design. Only two things
 * interrupt the operator: something he should act on **now**, and something that has
 * been escalated for human review. Everything else waits for him to open the
 * dashboard, which he does anyway.
 */
export function eventAlert(input: EventAlertInput): Alert | undefined {
  // An accusation escalated by the Phase 7 forcing rules. Urgent not because it is
  // exciting but because publishing it wrongly is unrecoverable — the interruption
  // buys a human decision before anything happens.
  if (input.manualFlag) {
    return {
      tier: 'urgent',
      title: `Needs human review: ${input.title.slice(0, 80)}`,
      body: 'Forced to VERIFY and flagged. An unverified accusation amplified damages a third party who had no say in it.',
      dedupeKey: dedupeKey('urgent', `manual-flag:${String(input.eventId)}`),
      eventId: input.eventId,
    };
  }

  if (input.recommendedAction === 'POST_NOW') {
    return {
      tier: 'urgent',
      title: `POST NOW: ${input.title.slice(0, 80)}`,
      body: `Combined ${String(input.combined)}, confidence ${input.confidence}. Inside the early window — the recommendation decays with time.`,
      dedupeKey: dedupeKey('urgent', `post-now:${String(input.eventId)}`),
      eventId: input.eventId,
    };
  }

  // POST_SOON is deliberately NOT an alert. It has no deadline, so interrupting for it
  // trains the operator to ignore interruptions — the exact failure this phase names.
  return undefined;
}

export type AlertRun = {
  readonly sent: readonly Alert[];
  readonly suppressed: readonly { alert: Alert; decision: AlertDecision }[];
  readonly byReason: Record<string, number>;
};

/**
 * Decide a whole batch, threading the daily count through.
 *
 * Suppressed alerts are returned rather than dropped. Hitting the daily cap is
 * information about the tiering being wrong, and a run that hid it would let the
 * system look calm while failing.
 */
export function planAlerts(alerts: readonly Alert[], context: AlertContext): AlertRun {
  const sent: Alert[] = [];
  const suppressed: { alert: Alert; decision: AlertDecision }[] = [];
  const byReason: Record<string, number> = {};
  const seen = new Set(context.alreadySent);
  let sentToday = context.sentToday;

  for (const alert of alerts) {
    const decision = shouldSend(alert, { ...context, alreadySent: seen, sentToday });

    if (decision.send) {
      sent.push(alert);
      // Added immediately so two alerts about the same fact in one batch collapse —
      // deduping only against history would let a single run fire duplicates.
      seen.add(alert.dedupeKey);
      sentToday += 1;
    } else {
      suppressed.push({ alert, decision });
      const key = decision.suppressedBy ?? 'unknown';
      byReason[key] = (byReason[key] ?? 0) + 1;
    }
  }

  return { sent, suppressed, byReason };
}
