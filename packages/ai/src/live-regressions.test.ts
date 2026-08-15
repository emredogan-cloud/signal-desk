import { describe, it, expect } from 'vitest';
import { callCostUsd, estimateCostUsd, MODEL_PRICING } from './budget.js';
import { validateAnalysis, ProvenanceError } from './validate.js';
import { triageSchema, analysisSchema, MAX_REASON_CHARS } from './schema.js';
import {
  TRIAGE_SYSTEM,
  ANALYSIS_SYSTEM,
  TRIAGE_PROMPT_VERSION,
  ANALYSIS_PROMPT_VERSION,
} from './prompts.js';
import type { Analysis } from './schema.js';

/**
 * Regressions for the defects the **first live Anthropic run** found.
 *
 * Every one of these passed the full MOCK suite. They are recorded here so the same
 * class of mistake fails loudly rather than being rediscovered by another live run —
 * these were found by spending real money, and that is the expensive way to learn.
 *
 * `docs/VALIDATION.md` §9 is the narrative version.
 */

const official = { allowedEvidenceIds: new Set(['ev-1']), hasOfficialSource: true };

function analysis(overrides: Partial<Analysis> = {}): Analysis {
  return {
    whatHappened: 'Something happened.',
    whatChanged: 'Something changed.',
    before: '',
    after: '',
    implications: [],
    claims: [],
    stillUnknown: [],
    confidence: 'HIGH',
    recommendedAction: 'POST_NOW',
    doNotSay: [],
    draftMaterial: {
      hook: 'The context window went from 128k to 1M tokens.',
      substance: 'Available on the API today at the same price per token.',
      soWhat: 'Work that needed chunking now fits in one call.',
      testableClaim: '',
    },
    attentionDrivers: [],
    attentionReason: '',
    mediaIdea: { kind: 'none', whatToShow: '', sourceHint: '' },
    injectionObserved: false,
    // Required by the schema. Omitting it made two of these regressions fail with
    // "did not match the schema" — TypeScript could not catch it, because spreading a
    // `Partial<Analysis>` lets the compiler assume the missing key might arrive there.
    injectionNote: '',
    ...overrides,
  };
}

describe('LIVE #1 — dated model ids must price correctly', () => {
  it('prices the DATED id the API actually returns', () => {
    // The API returns `claude-haiku-4-5-20251001`; the table is keyed by the alias.
    // Exact-match lookup returned undefined, the caller coalesced it to 0, and REAL
    // SPEND WAS RECORDED AS $0.00 while 8,764 cache-read tokens were billed. The
    // budget guard could never have fired.
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    expect(callCostUsd('claude-haiku-4-5-20251001', usage)).toBeCloseTo(1.0, 6);
    expect(callCostUsd('claude-opus-5-20260101', usage)).toBeCloseTo(5.0, 6);
  });

  it('prefers the LONGEST matching prefix', () => {
    // `claude-opus-4-8-...` must not price as `claude-opus-4-...` if both were keys.
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    expect(callCostUsd('claude-opus-4-8-20260501', usage)).toBeCloseTo(
      MODEL_PRICING['claude-opus-4-8']?.input ?? 0,
      6,
    );
  });

  it('still refuses to price a genuinely unknown model', () => {
    // Prefix matching must not become "price anything". An unpriced model has to stay
    // visible rather than silently costing nothing.
    expect(
      callCostUsd('some-future-vendor-model', {
        inputTokens: 1000,
        outputTokens: 1000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBeUndefined();
  });

  it('estimates a dated id at its real rate rather than the pessimistic fallback', () => {
    expect(estimateCostUsd('claude-haiku-4-5-20251001', 10_000, 1000)).toBeLessThan(
      estimateCostUsd('unknown-model', 10_000, 1000),
    );
  });
});

describe('LIVE #3 — prose bounds must not discard paid work', () => {
  it('accepts the ~320-character reason a real Haiku call produced', () => {
    // Two of six live triage calls wrote reasoning just past the old 300 cap and had
    // the whole object rejected. Structured outputs carry no `maxLength`, so the bound
    // was invisible to the model and fatal to us.
    const reason =
      'A real release from an Anthropic tool, but a bug fix in a specific OAuth scenario with no described breaking change; the one-line summary already covers what a developer would do about it, and nothing follows from it that a careful expensive read would add. Deep analysis would restate the changelog at fifty times the price.';
    expect(reason.length).toBeGreaterThan(300);
    expect(reason.length).toBeLessThan(MAX_REASON_CHARS);

    const parsed = triageSchema.safeParse({
      isRealEvent: true,
      category: 'software',
      oneLine: 'A release.',
      worthDeepAnalysis: false,
      reason,
      injectionObserved: false,
      injectionNote: '',
    });
    expect(parsed.success).toBe(true);
  });

  it('still bounds the headline tightly', () => {
    // `oneLine` is a headline. One that runs long is wrong, not merely verbose.
    const parsed = triageSchema.safeParse({
      isRealEvent: true,
      category: 'ai',
      oneLine: 'x'.repeat(201),
      worthDeepAnalysis: false,
      reason: 'ok',
      injectionObserved: false,
      injectionNote: '',
    });
    expect(parsed.success).toBe(false);
  });

  it('tells the model the limits, since the schema cannot', () => {
    expect(TRIAGE_SYSTEM).toContain('LENGTH LIMITS');
    expect(ANALYSIS_SYSTEM).toContain('LENGTH LIMITS');
  });
});

describe('LIVE #5 — provenance compares value, not presentation', () => {
  it('accepts a claim that writes the same figure with separators', () => {
    // A sourced figure written "27,674" in a claim and "27674" in the narrative failed
    // a substring match and discarded a paid Opus analysis.
    expect(() =>
      validateAnalysis(
        analysis({
          whatHappened: 'Throughput reached 27674 tokens per second.',
          claims: [
            {
              text: 'Measured throughput was 27,674 tokens/sec.',
              evidenceIds: ['ev-1'],
              tag: 'VERIFIED',
            },
          ],
        }),
        official,
      ),
    ).not.toThrow();
  });

  it('still rejects a figure no claim supports at all', () => {
    // Normalisation must not weaken the control. THREAT-MODEL §5 test 6 stands.
    expect(() =>
      validateAnalysis(
        analysis({ whatHappened: 'Throughput reached 27674 tokens per second.', claims: [] }),
        official,
      ),
    ).toThrow(ProvenanceError);
  });

  it('rejects a DIFFERENT number even when a similar one is claimed', () => {
    expect(() =>
      validateAnalysis(
        analysis({
          whatHappened: 'Throughput reached 27674 tokens per second.',
          claims: [
            {
              text: 'Measured throughput was 25,346 tokens/sec.',
              evidenceIds: ['ev-1'],
              tag: 'VERIFIED',
            },
          ],
        }),
        official,
      ),
    ).toThrow(ProvenanceError);
  });

  it('instructs the model not to invent rhetorical figures', () => {
    // A live analysis was discarded for writing "90%" that no source stated — the
    // model's own emphasis, presented as a measurement.
    expect(ANALYSIS_SYSTEM).toContain('rhetorical figures');
    expect(ANALYSIS_SYSTEM).toContain('fabricated measurement');
  });
});

describe('prompt versions were bumped with the text', () => {
  it('records a version past v1, since the prompts changed after live testing', () => {
    // A stored analysis records its prompt version so a Phase 12 replay can compare
    // like with like. Editing the text without bumping the version silently mixes eras.
    expect(TRIAGE_PROMPT_VERSION).not.toContain('-v1-');
    expect(ANALYSIS_PROMPT_VERSION).not.toContain('-v1-');
  });
});

describe('analysis output bounds accommodate a real Opus response', () => {
  it('accepts the 15-claim, 8-do-not-say shape a live call produced', () => {
    const parsed = analysisSchema.safeParse(
      analysis({
        claims: Array.from({ length: 15 }, (_v, i) => ({
          text: `Claim ${String(i)} about the release, stated at the length a real model writes.`,
          evidenceIds: ['ev-1'],
          tag: 'VERIFIED' as const,
        })),
        stillUnknown: Array.from({ length: 6 }, (_v, i) => `Unknown ${String(i)}`),
        doNotSay: Array.from({ length: 8 }, (_v, i) => `Do not say thing ${String(i)}`),
      }),
    );
    expect(parsed.success).toBe(true);
  });
});

describe('provenance false positives that cost paid analyses — 2026-08-15', () => {
  it('does not fail an analysis for citing an evidence id inline', () => {
    // `ev-141` contains `141`. The check matched it and threw, so an analysis was
    // discarded FOR CITING ITS SOURCE. Three live Opus calls died this way at ~$0.11
    // each, and the text they discarded was correct.
    expect(() =>
      validateAnalysis(
        analysis({
          whatHappened: 'Vendor shipped a change, described in ev-141 and ev-143.',
          claims: [],
        }),
        official,
      ),
    ).not.toThrow();
  });

  it('does not read a year in prose as an unsourced measurement', () => {
    // The old exemption only fired when the field contained nothing but a year.
    expect(() =>
      validateAnalysis(
        analysis({
          whatHappened: 'The format has been stable since 1970 and changed today.',
          claims: [],
        }),
        official,
      ),
    ).not.toThrow();
  });

  it('accepts a Turkish-formatted figure against an English-formatted claim', () => {
    // Turkish writes 1.500 where English writes 1,500. The narrative is Turkish and the
    // claims quote English sources, so the same sourced number appeared in two
    // spellings and a correct analysis was discarded (event 140).
    expect(() =>
      validateAnalysis(
        analysis({
          whatHappened: 'Ankette 1.500 kuruluş yer aldı.',
          claims: [
            {
              text: 'The survey covered 1,500 organizations.',
              evidenceIds: ['ev-1'],
              tag: 'VERIFIED',
            },
          ],
        }),
        official,
      ),
    ).not.toThrow();
  });

  it('still distinguishes a decimal from a thousands separator', () => {
    // 2.5 must not normalise to 25, or an unsourced 2.5x would pass against a claim
    // mentioning 25.
    expect(() =>
      validateAnalysis(
        analysis({
          whatHappened: 'Throughput is 2.5x the previous build.',
          claims: [{ text: 'The batch size is 25.', evidenceIds: ['ev-1'], tag: 'VERIFIED' }],
        }),
        official,
      ),
    ).toThrow(/no sourced claim/i);
  });

  it('STILL fails on a genuinely unsourced measurement', () => {
    // The property that matters is unchanged: a magnitude claim with no evidence id
    // behind it is still refused.
    expect(() =>
      validateAnalysis(
        analysis({
          whatHappened: 'Throughput improved by 47% over the previous build.',
          claims: [],
        }),
        official,
      ),
    ).toThrow(/no sourced claim/i);
  });
});
