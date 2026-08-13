import { describe, it, expect } from 'vitest';
import {
  buildEducationalOpportunity,
  buildExperiment,
  MAX_EXPERIMENT_MINUTES,
  TEACHING_FORMATS,
  type EducationalInput,
} from './educational.js';
import { INJECTION_CORPUS } from '../security/injection-corpus.js';

/**
 * `ROADMAP.md` Phase 8 TESTS: "Schema conformance. Limitations section is non-empty
 * and non-generic. Experiment procedures are concrete enough to execute."
 *
 * The limitations rule is the one that matters:
 *
 * > "**Every technique must state its limitations and failure modes.** A workflow
 * > presented without its failure cases is the kind of content that damages
 * > credibility when a reader tries it."
 */

function input(overrides: Partial<EducationalInput> = {}): EducationalInput {
  return {
    eventId: 1,
    title: 'Anthropic ships prompt caching with a 1M context window',
    summary: 'Cache reads are billed at a tenth of the input rate.',
    category: 'ai',
    entities: ['anthropic'],
    testable: true,
    hasVersionArtifact: true,
    hasOfficialSource: true,
    distinctSourceCount: 3,
    expertSourceCount: 0,
    stillUnknown: [],
    whatChanged: 'Pricing for cached tokens changed.',
    doNotSay: [],
    ...overrides,
  };
}

describe('educational opportunities', () => {
  it('produces one for a testable, teachable event', () => {
    const opportunity = buildEducationalOpportunity(input());
    expect(opportunity).toBeDefined();
    expect(TEACHING_FORMATS).toContain(opportunity?.format);
  });

  it('ALWAYS states limitations — the non-negotiable', () => {
    // "A workflow presented without its failure cases is the kind of content that
    // damages credibility when a reader tries it."
    for (const overrides of [
      {},
      { title: 'New model beats the previous version on every benchmark' },
      { title: 'Pricing cut by 60% for the batch API' },
      { title: 'v3.0.0 released with breaking changes' },
      { stillUnknown: ['Methodology is not published.'] },
    ]) {
      const opportunity = buildEducationalOpportunity(input(overrides));
      if (opportunity === undefined) continue;
      expect(opportunity.limitations.length).toBeGreaterThan(0);
      for (const limitation of opportunity.limitations) {
        expect(limitation.length).toBeGreaterThan(25);
      }
    }
  });

  it('gives limitations that are specific, not "results may vary"', () => {
    const opportunity = buildEducationalOpportunity(input());
    const text = (opportunity?.limitations ?? []).join(' ').toLowerCase();
    expect(text).not.toContain('results may vary');
    expect(text).not.toContain('your mileage');
    // Each limitation names an actual failure mode of the technique.
    expect(text.length).toBeGreaterThan(100);
  });

  it('folds event-specific unknowns into the limitations', () => {
    const opportunity = buildEducationalOpportunity(
      input({ stillUnknown: ['Whether the discount applies to the batch API.'] }),
    );
    expect(opportunity?.limitations.join(' ')).toContain('batch API');
  });

  it('folds the do-not-say list into the limitations', () => {
    const opportunity = buildEducationalOpportunity(
      input({ doNotSay: ['Do not say it is generally available — it is a research preview.'] }),
    );
    expect(opportunity?.limitations.join(' ')).toContain('research preview');
  });

  it('produces NOTHING when there is no teachable angle', () => {
    // Most events are not teaching opportunities. The roadmap asks for one or two a
    // day out of hundreds, so returning nothing is the common correct outcome.
    expect(
      buildEducationalOpportunity(
        input({
          title: 'Company announces a new office',
          summary: 'Opening in Q3.',
          whatChanged: '',
          testable: false,
          hasVersionArtifact: false,
          entities: [],
        }),
      ),
    ).toBeUndefined();
  });

  it('refuses to teach something he cannot run himself', () => {
    // A technique taught second-hand is exactly the content §A1 warns about — the
    // credibility comes from having run it.
    const opportunity = buildEducationalOpportunity(
      input({ testable: false, title: 'New GPU architecture announced' }),
    );
    expect(opportunity).toBeUndefined();
  });

  it('gives a method concrete enough to follow without guessing', () => {
    const opportunity = buildEducationalOpportunity(input());
    expect(opportunity?.method.length).toBeGreaterThanOrEqual(4);
    for (const step of opportunity?.method ?? []) {
      expect(step.length).toBeGreaterThan(30);
      // A step that says "consider" or "think about" is advice, not a method.
      expect(step.toLowerCase()).not.toMatch(/^(?:consider|think about|try to)\b/);
    }
  });

  it('fills every field — schema conformance', () => {
    const opportunity = buildEducationalOpportunity(input());
    expect(opportunity).toBeDefined();
    if (opportunity === undefined) return;
    for (const field of [
      'topic',
      'whyNow',
      'audience',
      'hook',
      'teachingPoint',
      'workedExample',
    ] as const) {
      expect(opportunity[field].length, field).toBeGreaterThan(20);
    }
  });
});

describe('the experiment generator', () => {
  it('produces a runnable experiment for a testable event', () => {
    const experiment = buildExperiment(input());
    expect(experiment).toBeDefined();
    expect(experiment?.status).toBe('queued');
  });

  it('never proposes one that takes longer than two hours', () => {
    // "≥5 experiments the operator judges genuinely runnable in under 2 hours." An
    // experiment needing a week of setup is a research project, and it will not happen.
    for (const title of [
      'Anthropic ships prompt caching',
      'New model tops the leaderboard',
      'Pricing cut by 60%',
      'v3.0.0 released with breaking changes',
      'Framework X versus framework Y on throughput',
    ]) {
      const experiment = buildExperiment(input({ title }));
      if (experiment === undefined) continue;
      expect(experiment.estimatedMinutes, title).toBeLessThanOrEqual(MAX_EXPERIMENT_MINUTES);
    }
  });

  it('asks a question with a checkable answer, not a topic', () => {
    const experiment = buildExperiment(input());
    expect(experiment?.question).toMatch(/\?$/);
    expect(experiment?.question.length).toBeGreaterThan(30);
  });

  it('states a hypothesis BEFORE the run, so being wrong is informative', () => {
    const experiment = buildExperiment(input());
    expect(experiment?.hypothesis.length).toBeGreaterThan(30);
  });

  it('names measurable metrics rather than "see if it is better"', () => {
    const experiment = buildExperiment(input());
    expect(experiment?.metrics.length).toBeGreaterThan(1);
    for (const metric of experiment?.metrics ?? []) {
      expect(metric.toLowerCase()).not.toMatch(/\bbetter\b|\bgood\b|\bworse\b/);
    }
  });

  it('NEVER generates a result — that would be a fabricated measurement', () => {
    // The system proposes the experiment; the operator runs it and fills the result
    // in. A generated result is exactly the thing this project never does.
    const experiment = buildExperiment(input());
    expect(experiment).toBeDefined();
    expect(Object.keys(experiment ?? {})).not.toContain('result');
  });

  it('gives a content angle for BOTH outcomes', () => {
    // An experiment only worth writing up if it confirms the hypothesis is one the
    // operator will quietly abandon when it does not.
    const experiment = buildExperiment(input());
    expect(experiment?.contentAngle).toContain('If the hypothesis holds');
    expect(experiment?.contentAngle).toContain('If it does not hold');
  });

  it('refuses when he cannot run it', () => {
    expect(buildExperiment(input({ testable: false }))).toBeUndefined();
  });

  it('produces a procedure with concrete steps', () => {
    const experiment = buildExperiment(input());
    expect(experiment?.procedure.length).toBeGreaterThanOrEqual(4);
    expect(experiment?.requiredInputs.length).toBeGreaterThan(0);
  });
});

describe('hostile content cannot produce a teaching post', () => {
  it.each(
    INJECTION_CORPUS.filter((entry) => entry.shouldFlag).map((entry) => [entry.id, entry] as const),
  )('%s never yields an opportunity without limitations', (_id, entry) => {
    const opportunity = buildEducationalOpportunity(
      input({ title: entry.title, summary: entry.body.slice(0, 300), whatChanged: '' }),
    );
    // It may produce nothing — that is fine and common. What it must never do is
    // produce a teaching post with no stated failure modes.
    if (opportunity !== undefined) {
      expect(opportunity.limitations.length, entry.note).toBeGreaterThan(0);
    }
  });

  it('never throws on any corpus document', () => {
    for (const entry of INJECTION_CORPUS) {
      expect(() => {
        buildEducationalOpportunity(input({ title: entry.title, summary: entry.body }));
        buildExperiment(input({ title: entry.title, summary: entry.body }));
      }, entry.id).not.toThrow();
    }
  });
});
