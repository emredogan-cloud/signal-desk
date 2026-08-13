import { createHash } from 'node:crypto';
import type { Analysis, TriageResult } from './schema.js';
import type { EnvelopeItem } from './envelope.js';
import type { TokenUsage } from './budget.js';

/**
 * `AI_MODE=MOCK` — deterministic canned analyses.
 *
 * The user's standing rule: *"never stub something that pretends to be live."* Every
 * field here is either derived from the real input or visibly marked as mock. There
 * is no fabricated insight, no invented benchmark, no plausible-sounding number that
 * a reader might mistake for a finding.
 *
 * ## Deterministic, not random
 *
 * Output is a pure function of the input, via a content hash. The same event always
 * produces the same mock analysis, so a test can assert on it and CI does not flake.
 * `Math.random()` would make MOCK mode untestable, which would defeat the point of
 * having it.
 *
 * ## What MOCK does and does not prove
 *
 * It proves the pipeline runs end to end without credentials: envelope built, schema
 * validated, provenance enforced, budget accounted, rows persisted. It proves nothing
 * about analysis quality — that needs `AI_MODE=LIVE`, and the roadmap's human
 * acceptance gate ("Operator reads 20 analyses and judges them non-obvious").
 */

export const MOCK_MODEL = 'mock-deterministic';
export const MOCK_MARKER = '[MOCK]';

function hashOf(input: string): number {
  const digest = createHash('sha256').update(input).digest();
  return digest.readUInt32BE(0);
}

/** Zero. MOCK costs nothing, and reporting a fake cost would corrupt the budget series. */
export const MOCK_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export function mockTriage(title: string, items: readonly EnvelopeItem[]): TriageResult {
  const hash = hashOf(title + items.map((item) => item.evidenceId).join(','));

  // Even the mock applies the deterministic rules it can: an item with no title is
  // not an event, whatever else is true. A mock that ignored its input would hide
  // pipeline bugs rather than exercising them.
  const isRealEvent = title.trim().length > 0;

  return {
    isRealEvent,
    category: 'ai',
    oneLine: `${MOCK_MARKER} ${title.slice(0, 150)}`,
    // Deterministic split so both downstream branches get exercised in a MOCK run.
    worthDeepAnalysis: isRealEvent && hash % 3 === 0,
    reason: `${MOCK_MARKER} AI_MODE=MOCK — no model was called. This verdict is derived from the input hash, not from judgement.`,
    injectionObserved: false,
    injectionNote: '',
  };
}

export function mockAnalysis(title: string, items: readonly EnvelopeItem[]): Analysis {
  const evidenceIds = items.map((item) => item.evidenceId);
  const sources = [...new Set(items.map((item) => item.sourceId))];

  return {
    whatHappened: `${MOCK_MARKER} No model was called. The pipeline reached the analysis stage for "${title.slice(0, 200)}" with ${String(items.length)} evidence item(s) from ${String(sources.length)} source(s).`,
    whatChanged: `${MOCK_MARKER} Unknown — determining what changed requires a model. Set AI_MODE=LIVE with ANTHROPIC_API_KEY to produce real analysis.`,
    before: '',
    after: '',
    implications: [],
    // The only claim is one that is true by construction: these evidence ids exist.
    // Provenance validation therefore runs for real in MOCK mode, which is the point.
    claims:
      evidenceIds.length === 0
        ? []
        : [
            {
              text: `${MOCK_MARKER} This event has ${String(evidenceIds.length)} evidence item(s) attached.`,
              evidenceIds,
              tag: 'OBSERVED' as const,
            },
          ],
    stillUnknown: [
      `${MOCK_MARKER} Everything. AI_MODE=MOCK produces no analysis, only a shaped placeholder proving the pipeline ran.`,
    ],
    // LOW / VERIFY is the honest verdict for output that contains no analysis. It
    // also means a MOCK run can never recommend publishing anything.
    confidence: 'LOW',
    recommendedAction: 'VERIFY',
    doNotSay: [`${MOCK_MARKER} Do not treat any part of this as analysis — no model produced it.`],
    injectionObserved: false,
    injectionNote: '',
  };
}
