import type Anthropic from '@anthropic-ai/sdk';
import { buildEnvelope, newDelimiter, type EnvelopeItem } from './envelope.js';
import {
  ANALYSIS_SYSTEM,
  ANALYSIS_PROMPT_VERSION,
  TRIAGE_SYSTEM,
  TRIAGE_PROMPT_VERSION,
  framingBlock,
} from './prompts.js';
import {
  ANALYSIS_JSON_SCHEMA,
  TRIAGE_JSON_SCHEMA,
  type Analysis,
  type TriageResult,
} from './schema.js';
import { complete, AiRefusalError, type CompletionResult } from './client.js';
import {
  validateAnalysis,
  validateTriage,
  ProvenanceError,
  type ValidationContext,
} from './validate.js';
import { MOCK_MODEL, MOCK_USAGE, mockAnalysis, mockTriage } from './mock.js';
import {
  callCostUsd,
  checkBudget,
  estimateCostUsd,
  NO_USAGE,
  type BudgetDecision,
  type TokenUsage,
} from './budget.js';

/**
 * The analysis engine — triage, then (sometimes) deep analysis.
 *
 * `ARCHITECTURE.md` §4's tiering, in code: the rule gate (free, Phase 5) decides who
 * reaches Haiku; Haiku decides who reaches Opus. Each stage is roughly fifty times
 * more expensive than the one before it, which is why each one must be able to say no.
 *
 * Everything here is honest about which mode produced it. A caller can always tell a
 * real analysis from a MOCK placeholder from a skipped call, because the result type
 * says so — `ROADMAP.md`'s standing rule that the system never fabricates live results.
 */

export type EngineMode = 'MOCK' | 'LIVE';

export type EngineConfig = {
  readonly mode: EngineMode;
  readonly client: Anthropic | undefined;
  readonly triageModel: string;
  readonly analysisModel: string;
  readonly dailyBudgetUsd: number;
  readonly analysisThreshold: number;
};

export type AnalysisInput = {
  readonly eventId: number;
  readonly title: string;
  readonly summary: string;
  readonly combinedScore: number;
  readonly items: readonly EnvelopeItem[];
  readonly hasOfficialSource: boolean;
};

/** Machine-readable skip codes. Grouping on prose is fragile; this is not. */
export const SKIP_CODES = [
  'budget',
  'triage_failed',
  'not_an_event',
  'not_worth_it',
  'below_threshold',
] as const;
export type SkipCode = (typeof SKIP_CODES)[number];

export type StageOutcome<T> = {
  readonly status: 'ok' | 'skipped' | 'refused' | 'failed';
  readonly value: T | undefined;
  readonly reason: string;
  /**
   * Present only on a skip. Exists because the CLI first grouped skips by matching
   * substrings in `reason`, silently bucketed most of them as "other", and reported a
   * misleading breakdown of why nothing was analysed. A summary derived from prose is
   * a summary that goes wrong the next time the prose is edited.
   */
  readonly skipCode?: SkipCode;
  readonly usage: TokenUsage;
  readonly costUsd: number;
  readonly model: string;
  readonly promptVersion: string;
};

export type EngineResult = {
  readonly eventId: number;
  readonly triage: StageOutcome<TriageResult>;
  readonly analysis: StageOutcome<Analysis>;
  readonly totalCostUsd: number;
  /** Whether the prompt cache was read on any call in this run. Phase 6 acceptance. */
  readonly cacheRead: boolean;
  readonly budget: BudgetDecision | undefined;
};

function skipped<T>(
  code: SkipCode,
  reason: string,
  model: string,
  promptVersion: string,
): StageOutcome<T> {
  return {
    status: 'skipped',
    value: undefined,
    reason,
    skipCode: code,
    usage: NO_USAGE,
    costUsd: 0,
    model,
    promptVersion,
  };
}

/**
 * A failure description that can actually be diagnosed.
 *
 * The first live run stored `"triage output did not match the schema"` and nothing
 * else — true, and useless. `ProvenanceError` carries the Zod detail; a validation
 * failure recorded without it is one nobody can fix from the ledger.
 */
function describeFailure(error: unknown): string {
  if (error instanceof ProvenanceError) {
    return `${error.message}: ${error.detail.slice(0, 400)}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Bound the user turn so one enormous document cannot blow the budget on its own. */
const MAX_ENVELOPE_CHARS = 60_000;

function renderUser(input: AnalysisInput, envelopeText: string): string {
  const header = [
    `EVENT: ${input.title}`,
    `SUMMARY: ${input.summary}`,
    `EVIDENCE IDS YOU MAY CITE: ${input.items.map((item) => item.evidenceId).join(', ') || '(none)'}`,
    '',
    'The evidence follows, fenced between the markers described in your instructions.',
    '',
  ].join('\n');

  const body =
    envelopeText.length > MAX_ENVELOPE_CHARS
      ? `${envelopeText.slice(0, MAX_ENVELOPE_CHARS)}\n[TRUNCATED — evidence exceeded ${String(MAX_ENVELOPE_CHARS)} characters]`
      : envelopeText;

  return `${header}${body}`;
}

/** Triage. Cheap, and allowed to say "not worth the expensive model". */
export async function runTriage(
  config: EngineConfig,
  input: AnalysisInput,
  spentUsd: number,
): Promise<StageOutcome<TriageResult>> {
  if (config.mode === 'MOCK' || config.client === undefined) {
    return {
      status: 'ok',
      value: mockTriage(input.title, input.items),
      reason: 'AI_MODE=MOCK — deterministic placeholder, no model called',
      usage: MOCK_USAGE,
      costUsd: 0,
      model: MOCK_MODEL,
      promptVersion: TRIAGE_PROMPT_VERSION,
    };
  }

  const delimiter = newDelimiter();
  const envelope = buildEnvelope(input.items, delimiter);
  const user = renderUser(input, envelope.text);

  const estimated = estimateCostUsd(config.triageModel, TRIAGE_SYSTEM.length + user.length, 700);
  const decision = checkBudget({
    tier: 'triage',
    spentUsd,
    dailyBudgetUsd: config.dailyBudgetUsd,
    estimatedCostUsd: estimated,
    score: input.combinedScore,
  });
  if (!decision.allowed) {
    return skipped('budget', decision.reason, config.triageModel, TRIAGE_PROMPT_VERSION);
  }

  let result: CompletionResult;
  try {
    result = await complete(config.client, {
      model: config.triageModel,
      systemCached: TRIAGE_SYSTEM,
      systemDynamic: framingBlock(delimiter),
      userContent: user,
      jsonSchema: TRIAGE_JSON_SCHEMA,
      maxTokens: 700,
    });
  } catch (error) {
    if (error instanceof AiRefusalError) {
      return {
        status: 'refused',
        value: undefined,
        reason: error.message,
        usage: NO_USAGE,
        costUsd: 0,
        model: config.triageModel,
        promptVersion: TRIAGE_PROMPT_VERSION,
      };
    }
    return {
      status: 'failed',
      value: undefined,
      reason: error instanceof Error ? error.message : String(error),
      usage: NO_USAGE,
      costUsd: 0,
      model: config.triageModel,
      promptVersion: TRIAGE_PROMPT_VERSION,
    };
  }

  const cost = callCostUsd(result.model, result.usage) ?? 0;
  try {
    return {
      status: 'ok',
      value: validateTriage(result.json),
      reason: 'triaged',
      usage: result.usage,
      costUsd: cost,
      model: result.model,
      promptVersion: TRIAGE_PROMPT_VERSION,
    };
  } catch (error) {
    // The call was made and billed even though the output was unusable. Recording the
    // cost anyway is the honest accounting: a validation failure that showed as free
    // would let a systematic schema problem drain the budget invisibly.
    return {
      status: 'failed',
      value: undefined,
      reason: describeFailure(error),
      usage: result.usage,
      costUsd: cost,
      model: result.model,
      promptVersion: TRIAGE_PROMPT_VERSION,
    };
  }
}

/** Deep analysis. Expensive, gated three ways: score, triage verdict, budget. */
export async function runAnalysis(
  config: EngineConfig,
  input: AnalysisInput,
  spentUsd: number,
): Promise<StageOutcome<Analysis>> {
  const context: ValidationContext = {
    allowedEvidenceIds: new Set(input.items.map((item) => item.evidenceId)),
    hasOfficialSource: input.hasOfficialSource,
  };

  if (config.mode === 'MOCK' || config.client === undefined) {
    return {
      status: 'ok',
      // Even the mock goes through validation — that is what makes MOCK mode a real
      // test of the pipeline rather than a bypass of it.
      value: validateAnalysis(mockAnalysis(input.title, input.items), context),
      reason: 'AI_MODE=MOCK — deterministic placeholder, no model called',
      usage: MOCK_USAGE,
      costUsd: 0,
      model: MOCK_MODEL,
      promptVersion: ANALYSIS_PROMPT_VERSION,
    };
  }

  const delimiter = newDelimiter();
  const envelope = buildEnvelope(input.items, delimiter);
  const user = renderUser(input, envelope.text);

  const estimated = estimateCostUsd(
    config.analysisModel,
    ANALYSIS_SYSTEM.length + user.length,
    4000,
  );
  const decision = checkBudget({
    tier: 'analysis',
    spentUsd,
    dailyBudgetUsd: config.dailyBudgetUsd,
    estimatedCostUsd: estimated,
    score: input.combinedScore,
  });
  if (!decision.allowed) {
    return skipped('budget', decision.reason, config.analysisModel, ANALYSIS_PROMPT_VERSION);
  }

  let result: CompletionResult;
  try {
    result = await complete(config.client, {
      model: config.analysisModel,
      systemCached: ANALYSIS_SYSTEM,
      systemDynamic: framingBlock(delimiter),
      userContent: user,
      jsonSchema: ANALYSIS_JSON_SCHEMA,
      // 16k, not 4k. Claude Opus 5 thinks by DEFAULT, and `max_tokens` caps thinking
      // plus response text together — so a 4k budget spent most of itself reasoning
      // and truncated the JSON mid-object. The failure surfaced as "response was not
      // valid JSON despite structured outputs", which reads like a schema problem and
      // is actually a budget one.
      maxTokens: 16_000,
      effort: 'medium',
    });
  } catch (error) {
    if (error instanceof AiRefusalError) {
      return {
        status: 'refused',
        value: undefined,
        reason: error.message,
        usage: NO_USAGE,
        costUsd: 0,
        model: config.analysisModel,
        promptVersion: ANALYSIS_PROMPT_VERSION,
      };
    }
    return {
      status: 'failed',
      value: undefined,
      reason: error instanceof Error ? error.message : String(error),
      usage: NO_USAGE,
      costUsd: 0,
      model: config.analysisModel,
      promptVersion: ANALYSIS_PROMPT_VERSION,
    };
  }

  const cost = callCostUsd(result.model, result.usage) ?? 0;
  try {
    return {
      status: 'ok',
      value: validateAnalysis(result.json, context),
      reason: 'analysed',
      usage: result.usage,
      costUsd: cost,
      model: result.model,
      promptVersion: ANALYSIS_PROMPT_VERSION,
    };
  } catch (error) {
    return {
      status: 'failed',
      value: undefined,
      reason: describeFailure(error),
      usage: result.usage,
      costUsd: cost,
      model: result.model,
      promptVersion: ANALYSIS_PROMPT_VERSION,
    };
  }
}

/**
 * Both stages, with the gate between them.
 *
 * Deep analysis requires ALL of: triage succeeded, triage called it a real event,
 * triage judged it worth the cost, and the combined score cleared
 * `AI_ANALYSIS_THRESHOLD`. Any one of those failing skips the expensive call — and
 * says which one, so the operator can see why an event he cared about was not analysed.
 */
export async function analyseEvent(
  config: EngineConfig,
  input: AnalysisInput,
  spentUsd: number,
): Promise<EngineResult> {
  const triage = await runTriage(config, input, spentUsd);
  const afterTriage = spentUsd + triage.costUsd;

  let analysis: StageOutcome<Analysis>;
  if (triage.status !== 'ok' || triage.value === undefined) {
    analysis = skipped(
      'triage_failed',
      `triage did not produce a verdict (${triage.status}), so deep analysis was not attempted`,
      config.analysisModel,
      ANALYSIS_PROMPT_VERSION,
    );
  } else if (!triage.value.isRealEvent) {
    analysis = skipped(
      'not_an_event',
      'triage judged this not to be a real event',
      config.analysisModel,
      ANALYSIS_PROMPT_VERSION,
    );
  } else if (!triage.value.worthDeepAnalysis) {
    analysis = skipped(
      'not_worth_it',
      `triage judged deep analysis unwarranted: ${triage.value.reason}`,
      config.analysisModel,
      ANALYSIS_PROMPT_VERSION,
    );
  } else if (input.combinedScore < config.analysisThreshold) {
    analysis = skipped(
      'below_threshold',
      `combined score ${String(input.combinedScore)} is below AI_ANALYSIS_THRESHOLD of ${String(config.analysisThreshold)}`,
      config.analysisModel,
      ANALYSIS_PROMPT_VERSION,
    );
  } else {
    analysis = await runAnalysis(config, input, afterTriage);
  }

  return {
    eventId: input.eventId,
    triage,
    analysis,
    totalCostUsd: triage.costUsd + analysis.costUsd,
    cacheRead: triage.usage.cacheReadTokens > 0 || analysis.usage.cacheReadTokens > 0,
    budget: undefined,
  };
}
