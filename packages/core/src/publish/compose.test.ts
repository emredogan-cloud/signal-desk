import { describe, expect, it } from 'vitest';
import {
  cleanLine,
  composeDrafts,
  violatesDoNotSay,
  MAX_POST_CHARS,
  type ComposeInput,
} from './compose.js';
import { assessAttention, planMedia } from './media.js';

/**
 * The composer is a **security boundary**, not a formatter.
 *
 * Everything it consumes was written by a model that had just read untrusted
 * third-party content, and everything it produces is destined for the operator's
 * clipboard and then his timeline. The tests that matter here are the adversarial
 * ones: an injected handle, an injected link, a hidden bidi character, a draft that
 * asserts the exact thing the analysis said not to assert.
 */

const BASE: ComposeInput = {
  title: 'Vendor ships model v2',
  hook: 'The context window went from 128k to 1M tokens.',
  substance: 'v2.0 is available on the API today at the same price per token.',
  soWhat: 'Long-document work that needed chunking now fits in one call.',
  testableClaim: 'Feed it a 400-page PDF and check whether recall holds at the end.',
  before: '128k context, chunking required',
  after: '1M context, single call',
  doNotSay: [],
  recommendedOption: 'original',
  hasOfficialSource: true,
  testable: true,
  hoursSinceEvent: 2,
};

describe('cleanLine — treating model output as untrusted', () => {
  it('removes an injected @handle so a paste cannot become a mention', () => {
    // The attack: hostile content persuades the model to include a handle, the operator
    // pastes it, and he has now publicly @-mentioned someone chosen by an attacker.
    expect(cleanLine('Ships today @evil_account and it is fast')).toBe(
      'Ships today and it is fast',
    );
  });

  it('removes hashtags', () => {
    expect(cleanLine('Context is now 1M #AI #breaking')).toBe('Context is now 1M');
  });

  it('removes links in every shape', () => {
    expect(cleanLine('See https://evil.example/x for details')).toBe('See for details');
    expect(cleanLine('See www.evil.example/x now')).toBe('See now');
    expect(cleanLine('Go to evil.io/steal today')).toBe('Go to today');
  });

  it('removes zero-width and bidi control characters', () => {
    // THREAT-MODEL §T-1's hidden-text vector, arriving via the analysis rather than
    // via the source document.
    const hostile = `Model v2\u200Bships\u202Etoday`;
    const cleaned = cleanLine(hostile);
    expect(cleaned).not.toMatch(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/);
  });

  it('removes emoji', () => {
    expect(cleanLine('Context window is now 1M 🚀🔥')).toBe('Context window is now 1M');
  });

  it('strips the hype vocabulary §10 bans by name', () => {
    expect(cleanLine('This is a game changer for developers')).not.toMatch(/game.?chang/i);
    expect(cleanLine('An insane improvement')).not.toMatch(/insane/i);
    expect(cleanLine('This changes everything for RAG')).not.toMatch(/changes everything/i);
    expect(cleanLine('A huge massive upgrade')).not.toMatch(/huge|massive/i);
  });

  it('leaves a clean technical sentence untouched', () => {
    const clean = 'Context went from 128k to 1M tokens at the same price.';
    expect(cleanLine(clean)).toBe(clean);
  });
});

describe('violatesDoNotSay', () => {
  it('catches a draft asserting the prohibited claim', () => {
    const doNotSay = ['Do not say it is generally available — the post says research preview.'];
    expect(violatesDoNotSay('It is generally available today.', doNotSay)).toBe(true);
  });

  it('does not fire on an unrelated draft', () => {
    const doNotSay = ['Do not say it is generally available — the post says research preview.'];
    expect(violatesDoNotSay('The context window is now 1M tokens.', doNotSay)).toBe(false);
  });

  it('ignores vague entries that carry no checkable phrase', () => {
    // "do not exaggerate" is advice, not a prohibited claim. Matching on it would
    // suppress every draft.
    expect(violatesDoNotSay('Anything at all here.', ['Do not exaggerate'])).toBe(false);
  });
});

describe('composeDrafts', () => {
  it('produces drafts that all fit inside the post limit', () => {
    for (const draft of composeDrafts(BASE)) {
      for (const part of draft.parts) {
        expect(part.chars).toBeLessThanOrEqual(MAX_POST_CHARS);
      }
      expect(draft.fits).toBe(true);
    }
  });

  it('drops a draft that would assert a do-not-say claim', () => {
    const withProhibition = composeDrafts({
      ...BASE,
      hook: 'It is generally available to everyone today.',
      doNotSay: ['Do not say it is generally available — the post says research preview.'],
    });
    for (const draft of withProhibition) {
      expect(draft.text.toLowerCase()).not.toContain('generally available');
    }
  });

  it('never emits an operator take when there is nothing to test', () => {
    // §16 and §10 together: "I tested it" without a test is the failure mode this
    // system exists to prevent.
    const drafts = composeDrafts({ ...BASE, testable: false, testableClaim: '' });
    expect(drafts.some((draft) => draft.format === 'operator_take')).toBe(false);
  });

  it('emits an operator take when the event is genuinely testable', () => {
    expect(composeDrafts(BASE).some((draft) => draft.format === 'operator_take')).toBe(true);
  });

  it('stops offering a bare reaction once being early no longer counts', () => {
    expect(
      composeDrafts({ ...BASE, hoursSinceEvent: 60 }).some((d) => d.format === 'reaction'),
    ).toBe(false);
  });

  it('only offers a quote draft when the strategy actually chose quoting', () => {
    expect(composeDrafts(BASE).some((draft) => draft.format === 'quote')).toBe(false);
    const quoting = composeDrafts({ ...BASE, recommendedOption: 'quote' });
    expect(quoting.some((draft) => draft.format === 'quote')).toBe(true);
  });

  it('only offers a thread when there are three distinct posts of substance', () => {
    const thin = composeDrafts({
      ...BASE,
      before: '',
      after: '',
      testable: false,
      testableClaim: '',
    });
    expect(thin.some((draft) => draft.format === 'thread')).toBe(false);
  });

  it('numbers thread parts and keeps each within the limit', () => {
    const thread = composeDrafts(BASE).find((draft) => draft.format === 'thread');
    expect(thread).toBeDefined();
    expect(thread?.parts.length).toBeGreaterThanOrEqual(3);
    expect(thread?.parts[0]?.text.startsWith('1/ ')).toBe(true);
    for (const part of thread?.parts ?? []) expect(part.chars).toBeLessThanOrEqual(MAX_POST_CHARS);
  });

  it('returns an empty array rather than a blank draft when nothing survives', () => {
    // Must render as "no draft", never as an empty box mistaken for a loading state.
    const nothing = composeDrafts({
      ...BASE,
      hook: 'https://evil.example',
      substance: '@handle',
      soWhat: '#tag',
      testableClaim: '',
      before: '',
      after: '',
    });
    expect(nothing).toEqual([]);
  });

  it('carries no injected handle or link into any composed draft', () => {
    const drafts = composeDrafts({
      ...BASE,
      hook: 'Ships today @attacker see https://evil.example/pwn',
      substance: 'v2.0 today #ad',
    });
    for (const draft of drafts) {
      expect(draft.text).not.toMatch(/@\w|#\w|https?:\/\//);
    }
  });
});

describe('verbose model output still produces a draft', () => {
  // The regression this locks: a 250-character `substance` line used to yield zero
  // drafts, and "no draft available" reads as a verdict rather than as a packing
  // failure. It cost $0.3563 of discarded analysis to find.
  const verbose = {
    ...BASE,
    substance:
      'The v2.0 release raises the context window from 128,000 tokens to 1,000,000 tokens ' +
      'while keeping the per-token price identical to the previous generation, and it is ' +
      'available on the public API from today rather than behind a waitlist or preview flag.',
  };

  it('still emits drafts when one input line is long', () => {
    const drafts = composeDrafts(verbose);
    expect(drafts.length).toBeGreaterThan(0);
  });

  it('keeps every part inside the post limit', () => {
    for (const draft of composeDrafts(verbose)) {
      for (const part of draft.parts) expect(part.chars).toBeLessThanOrEqual(MAX_POST_CHARS);
    }
  });

  it('trims a single over-long line at a word boundary rather than mid-word', () => {
    const only = composeDrafts({
      ...BASE,
      hook: 'x'.repeat(40) + ' ' + 'word '.repeat(80),
      substance: '',
      soWhat: '',
      testableClaim: '',
      before: '',
      after: '',
    });
    const text = only[0]?.text ?? '';
    expect(text.length).toBeLessThanOrEqual(MAX_POST_CHARS);
    expect(text.endsWith('…')).toBe(true);
    expect(text).not.toMatch(/\bwor…$/);
  });

  it('drops the least significant line rather than the whole draft', () => {
    // soWhat is passed last, so it is what gives way when space runs out.
    const drafts = composeDrafts(verbose);
    const breakdown = drafts.find((draft) => draft.format === 'breakdown');
    expect(breakdown).toBeDefined();
    expect(breakdown?.text.length).toBeLessThanOrEqual(MAX_POST_CHARS);
  });
});

describe('no two drafts are the same post under different labels', () => {
  // Found in the browser: a 249-character hook filled the post by itself, leaving no
  // room for the lines that distinguish formats, and two headings rendered identical
  // text. A draft headed "your own test" containing no test misdescribes itself.
  // A hook that fills the post on its own, so nothing else can be packed in and every
  // format reduces to the same trimmed opening line. This is the real shape observed:
  // a 249-character hook against a 280-character limit.
  const hookOnly = {
    ...BASE,
    hook: `OpenAI enterprise adoption research is built from its own account records ${'covering many organizations and messages '.repeat(6)}`,
    substance: 'The paper is arXiv 2608.12236 and reports concentration among larger firms.',
    soWhat: 'Buyers with budget are already standardised on one general-purpose assistant.',
  };

  it('is a case where the hook really does fill the post', () => {
    expect(cleanLine(hookOnly.hook).length).toBeGreaterThan(MAX_POST_CHARS);
  });

  it('collapses identical drafts to one', () => {
    const texts = composeDrafts(hookOnly).map((draft) => draft.text);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('keeps the more specific format when two collapse', () => {
    const drafts = composeDrafts(hookOnly);
    const formats = drafts.map((draft) => draft.format);
    // breakdown and operator_take would both reduce to the hook alone; the one that
    // survives must be the one claiming more, not the one added first.
    if (formats.includes('operator_take')) expect(formats).not.toContain('breakdown');
  });

  it('still returns distinct drafts when the material has room', () => {
    const drafts = composeDrafts(BASE);
    expect(new Set(drafts.map((d) => d.text)).size).toBe(drafts.length);
    expect(drafts.length).toBeGreaterThan(1);
  });
});

describe('assessAttention — auditable, not oracular', () => {
  it('reaches HIGH only on genuinely strong drivers', () => {
    const high = assessAttention({
      drivers: ['independently_testable', 'strong_before_after', 'surprising_result'],
      modelReason: '',
      hoursSinceEvent: 2,
      distinctSourceCount: 3,
    });
    expect(high.level).toBe('HIGH');
    expect(high.reason).toContain('anyone can run it today');
  });

  it('does not reach HIGH on timing alone', () => {
    // Otherwise every fresh event is HIGH and the signal is worthless.
    const timing = assessAttention({
      drivers: ['timing_window'],
      modelReason: '',
      hoursSinceEvent: 1,
      distinctSourceCount: 1,
    });
    expect(timing.level).toBe('LOW');
    expect(timing.limitation).toBeDefined();
  });

  it('says so plainly when no driver applies', () => {
    const none = assessAttention({
      drivers: [],
      modelReason: '',
      hoursSinceEvent: 5,
      distinctSourceCount: 2,
    });
    expect(none.level).toBe('LOW');
    expect(none.limitation).toContain('No attention driver applies');
  });

  it('always explains itself by naming drivers', () => {
    const assessment = assessAttention({
      drivers: ['measurable_comparison', 'practical_consequence'],
      modelReason: '',
      hoursSinceEvent: 3,
      distinctSourceCount: 2,
    });
    expect(assessment.reason.length).toBeGreaterThan(10);
    expect(assessment.drivers).toHaveLength(2);
  });
});

describe('planMedia', () => {
  const base = {
    kind: 'screenshot' as const,
    whatToShow: 'The pricing table showing the new per-token rate.',
    sourceHint: 'The official pricing page.',
    title: 'Vendor ships model v2',
    before: '128k context',
    after: '1M context',
    testable: true,
    testableClaim: 'Feed it a 400-page PDF.',
  };

  it('returns nothing for kind none, which is the common answer', () => {
    expect(planMedia({ ...base, kind: 'none' })).toBeUndefined();
  });

  it('downgrades a screen recording to a screenshot when there is nothing to run', () => {
    // §15: do not recommend video because it sounds impressive. A recording of a page
    // being scrolled is not evidence.
    const plan = planMedia({
      ...base,
      kind: 'screen_recording',
      testable: false,
      testableClaim: '',
    });
    expect(plan?.kind).toBe('screenshot');
    expect(plan?.video).toBeUndefined();
  });

  it('produces a full shot list when a recording is warranted', () => {
    const plan = planMedia({ ...base, kind: 'screen_recording' });
    expect(plan?.video?.sequence.length).toBeGreaterThanOrEqual(3);
    expect(plan?.video?.firstTwoSeconds).toBeTruthy();
    expect(plan?.video?.finalFrame).toBeTruthy();
  });

  it('always answers what, why, how, source and tool', () => {
    const plan = planMedia(base);
    expect(plan?.whatToShow).toBeTruthy();
    expect(plan?.whyItHelps).toBeTruthy();
    expect(plan?.howToMake.length).toBeGreaterThan(0);
    expect(plan?.source).toBeTruthy();
    expect(plan?.tool).toBeTruthy();
  });

  it('names the actual before and after in a comparison chart', () => {
    const plan = planMedia({ ...base, kind: 'comparison_chart' });
    expect(plan?.howToMake.join(' ')).toContain('128k context');
  });
});
