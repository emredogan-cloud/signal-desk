/**
 * The budget guard.
 *
 * `ROADMAP.md` Phase 6 acceptance: "Budget guard degrades gracefully, never crashes,
 * **never silently stops detection**."
 *
 * That last clause is the whole design. The failure this guards against is not
 * overspending — it is a system that goes quiet at 80% of the month and lets the
 * operator believe nothing is happening in the world. Detection, ingestion, scoring,
 * and the rule gate are all free and must keep running at any budget state. Only the
 * paid analysis tier degrades, and it degrades **visibly**.
 *
 * ## The ladder
 *
 * | State       | Spend      | Behaviour                                              |
 * |-------------|------------|--------------------------------------------------------|
 * | `NORMAL`    | < 70%      | Triage + deep analysis as scored                        |
 * | `FRUGAL`    | 70–90%     | Triage only; deep analysis for the very top few         |
 * | `TRIAGE`    | 90–100%    | Triage only, and only above the gate                    |
 * | `SUSPENDED` | ≥ 100%     | No paid calls. Ingestion and rules continue, loudly     |
 *
 * `SUSPENDED` still ingests, still clusters, still scores, still gates, still alerts.
 * The operator sees every event with its rules-only score and a banner explaining
 * that analysis is paused. That is degradation; going silent would be failure.
 */

export const BUDGET_STATES = ['NORMAL', 'FRUGAL', 'TRIAGE', 'SUSPENDED'] as const;
export type BudgetState = (typeof BUDGET_STATES)[number];

/** Thresholds as a fraction of the daily budget. GUESSES, like the score weights. */
export const FRUGAL_AT = 0.7;
export const TRIAGE_AT = 0.9;
export const SUSPENDED_AT = 1.0;

/**
 * Price per million tokens, USD. From the published pricing table.
 *
 * Hard-coded deliberately rather than fetched: a budget guard that needs a network
 * call to decide whether it can afford a network call has a bootstrapping problem,
 * and a pricing endpoint that is down must not either halt analysis or silently let
 * spend run unmetered. Stale-but-present beats absent. `unitCostUsd` returns
 * `undefined` for an unknown model, and the caller treats that as "cannot price it",
 * which is a visible state rather than a free one.
 */
export const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  'claude-opus-5': { input: 5.0, output: 25.0, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5.0, output: 25.0, cacheRead: 0.5 },
  'claude-sonnet-5': { input: 3.0, output: 15.0, cacheRead: 0.3 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0, cacheRead: 0.1 },
};

export type TokenUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
};

export const NO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/**
 * Cost of one call, USD. `undefined` when the model is not in the pricing table.
 *
 * Cache writes are billed at 1.25× base input for the 5-minute TTL. Reads are ~0.1×.
 */
export function callCostUsd(model: string, usage: TokenUsage): number | undefined {
  const price = MODEL_PRICING[model];
  if (price === undefined) return undefined;

  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.cacheRead +
      usage.cacheWriteTokens * price.input * 1.25) /
    1_000_000
  );
}

export function budgetState(spentUsd: number, dailyBudgetUsd: number): BudgetState {
  if (dailyBudgetUsd <= 0) return 'SUSPENDED';
  const fraction = spentUsd / dailyBudgetUsd;
  if (fraction >= SUSPENDED_AT) return 'SUSPENDED';
  if (fraction >= TRIAGE_AT) return 'TRIAGE';
  if (fraction >= FRUGAL_AT) return 'FRUGAL';
  return 'NORMAL';
}

export type BudgetDecision = {
  readonly allowed: boolean;
  readonly state: BudgetState;
  /** Always present — a refusal the operator cannot read is a silent failure. */
  readonly reason: string;
};

/**
 * May this call be made?
 *
 * Pure. The caller supplies today's spend; this decides. Keeping it pure is what
 * makes the degradation ladder testable without simulating a day of API traffic —
 * §5 test 5 requires exactly that ("Simulated overspend triggers degradation, not a
 * crash").
 */
export function checkBudget(input: {
  readonly tier: 'triage' | 'analysis';
  readonly spentUsd: number;
  readonly dailyBudgetUsd: number;
  readonly estimatedCostUsd: number;
  /** Combined score. In FRUGAL, only the very top still earns deep analysis. */
  readonly score: number;
}): BudgetDecision {
  const state = budgetState(input.spentUsd, input.dailyBudgetUsd);
  const projected = input.spentUsd + input.estimatedCostUsd;
  const pct = (input.spentUsd / Math.max(input.dailyBudgetUsd, 1e-9)) * 100;

  if (state === 'SUSPENDED') {
    return {
      allowed: false,
      state,
      reason: `daily budget of $${input.dailyBudgetUsd.toFixed(2)} is spent — analysis paused; ingestion, scoring, and the rule gate continue`,
    };
  }

  // A single call may not cross the line. Checking the projection rather than only
  // the current spend is what makes the cap a cap: one expensive Opus call at 99%
  // could otherwise overshoot by more than the whole day's budget.
  if (projected > input.dailyBudgetUsd) {
    return {
      allowed: false,
      state,
      reason: `this call would cost about $${input.estimatedCostUsd.toFixed(4)} and take the day to $${projected.toFixed(4)}, past the $${input.dailyBudgetUsd.toFixed(2)} budget`,
    };
  }

  if (input.tier === 'analysis' && state === 'TRIAGE') {
    return {
      allowed: false,
      state,
      reason: `${pct.toFixed(0)}% of the daily budget is spent — triage continues, deep analysis is paused`,
    };
  }

  if (input.tier === 'analysis' && state === 'FRUGAL' && input.score < 85) {
    return {
      allowed: false,
      state,
      reason: `${pct.toFixed(0)}% of the daily budget is spent — deep analysis reserved for events scoring 85+, this one scored ${String(input.score)}`,
    };
  }

  return {
    allowed: true,
    state,
    reason: `allowed: ${pct.toFixed(0)}% of the daily budget spent, this call adds about $${input.estimatedCostUsd.toFixed(4)}`,
  };
}

/**
 * Rough pre-call cost estimate, for the projection check above.
 *
 * Deliberately pessimistic — it assumes no cache hit and a full-length output. An
 * estimator that under-guesses lets calls through that then overshoot the cap, which
 * is the failure mode the guard exists to prevent. Actual cost is recorded from the
 * response's `usage` afterwards; this is only for the go/no-go.
 */
export function estimateCostUsd(
  model: string,
  promptChars: number,
  maxOutputTokens: number,
): number {
  const price = MODEL_PRICING[model];
  // An unknown model prices as the most expensive known one rather than as free.
  const rate = price ?? { input: 5.0, output: 25.0, cacheRead: 0.5 };
  const inputTokens = promptChars / 3.5; // conservative chars-per-token
  return (inputTokens * rate.input + maxOutputTokens * rate.output) / 1_000_000;
}
