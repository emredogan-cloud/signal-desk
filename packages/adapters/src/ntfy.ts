import type { Alert } from '@signal-desk/core';

/**
 * ntfy delivery, with a console fallback.
 *
 * `ROADMAP.md` Phase 11: "ntfy push with console fallback".
 *
 * ## Why the fallback is not a degradation
 *
 * The operator runs this on his own machine with a terminal open. A console alert is
 * a real alert there — the fallback exists because push delivery is a *convenience*
 * for when he is away from the desk, not because console output is second-best.
 *
 * What must never happen is a silent failure: an unreachable ntfy server that swallows
 * an urgent alert leaves the operator believing he is covered. So a delivery failure
 * always falls back to the console and always says that it fell back.
 *
 * ## The topic is a secret
 *
 * `THREAT-MODEL.md` treats the ntfy topic as a credential: anyone who knows it can
 * both read the operator's alerts and publish to them. It is never logged, and the
 * URL is constructed at call time rather than stored.
 */

export type NtfyConfig = {
  /** The topic. A secret — never logged, never included in an error message. */
  readonly topic: string | undefined;
  readonly server: string;
};

export type DeliveryResult = {
  readonly delivered: 'push' | 'console';
  readonly reason: string;
};

const TIER_PRIORITY: Record<Alert['tier'], string> = {
  urgent: '5',
  high: '4',
  trend: '3',
  educational: '2',
};

/**
 * Send one alert.
 *
 * Never throws. An alert system that can crash the run that produced it is worse than
 * no alert system — the run would fail after doing the work and before recording it.
 */
export async function deliver(
  alert: Alert,
  config: NtfyConfig,
  log: (line: string) => void,
): Promise<DeliveryResult> {
  const console_ = (reason: string): DeliveryResult => {
    log(`[${alert.tier.toUpperCase()}] ${alert.title}`);
    log(`         ${alert.body}`);
    return { delivered: 'console', reason };
  };

  if (config.topic === undefined) {
    return console_('NTFY_TOPIC is not set — console delivery, which is a real alert at his desk');
  }

  try {
    const response = await fetch(`${config.server.replace(/\/$/, '')}/${config.topic}`, {
      method: 'POST',
      body: alert.body,
      headers: {
        Title: alert.title,
        Priority: TIER_PRIORITY[alert.tier],
        Tags: alert.tier,
        // Tapping the notification opens the event, not the dashboard root. ntfy
        // honours `Click` on Android and in the web app.
        ...(alert.clickUrl !== undefined ? { Click: alert.clickUrl } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      // Status only. The URL contains the topic, and the topic is a credential.
      return console_(`ntfy returned ${String(response.status)} — fell back to console`);
    }

    return { delivered: 'push', reason: 'pushed' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The message could contain the URL, and therefore the topic. Only the error's
    // class is safe to surface.
    const safe = error instanceof Error ? error.name : 'unknown error';
    void message;
    return console_(`ntfy delivery failed (${safe}) — fell back to console`);
  }
}
