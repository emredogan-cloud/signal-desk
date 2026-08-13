import type { EventCategory } from '@signal-desk/shared';
import { findAngles, type Angle, type AngleInput } from './angles.js';

/**
 * The educational content engine. `ROADMAP.md` Phase 8.
 *
 * > **OBJECTIVE** Identify one or two genuine teaching opportunities per day, with the
 * > exact method, worked example, and stated limitations.
 * >
 * > **WHY** Teaching a working technique is one of the highest-authority content types
 * > available and it does not depend on being first.
 *
 * That last clause is the whole design. Every other output in this system is a race —
 * the rule gate kills anything over seven days old, the strategy layer discounts a
 * quote-tweet the moment the story cools. A teaching post is the one thing that is
 * worth as much next month as today, which makes it the right output for an operator
 * who cannot be online all day.
 *
 * ## The non-negotiable
 *
 * > "**Every technique must state its limitations and failure modes.** A workflow
 * > presented without its failure cases is the kind of content that damages
 * > credibility when a reader tries it."
 *
 * So `limitations` is not an optional field that is usually filled. An opportunity
 * with no stated limitations is not emitted — `buildEducationalOpportunity` returns
 * `undefined` rather than a lesson someone could follow into a wall. That is enforced
 * in code and asserted by a test.
 */

export const TEACHING_FORMATS = [
  'thread',
  'single_post',
  'code_snippet',
  'comparison_table',
  'walkthrough',
] as const;
export type TeachingFormat = (typeof TEACHING_FORMATS)[number];

export type EducationalOpportunity = {
  readonly eventId: number;
  readonly topic: string;
  /** Why this is worth teaching now rather than at any other time. */
  readonly whyNow: string;
  readonly audience: string;
  /** The opening line. What makes someone stop scrolling. */
  readonly hook: string;
  /** The single reusable thing the reader takes away. */
  readonly teachingPoint: string;
  /** The exact method — concrete enough to follow without guessing. */
  readonly method: readonly string[];
  readonly workedExample: string;
  /**
   * Limitations and failure modes. **Never empty.**
   *
   * An opportunity that cannot state these is not emitted at all.
   */
  readonly limitations: readonly string[];
  readonly format: TeachingFormat;
  /** Which angle this grew from. */
  readonly angle: Angle['kind'];
};

export type EducationalInput = AngleInput & {
  readonly eventId: number;
  readonly category: EventCategory;
  readonly stillUnknown: readonly string[];
  readonly doNotSay: readonly string[];
};

/**
 * Limitations by angle kind.
 *
 * Generic per angle, specific per event. A limitation like "results may vary" is
 * worthless; these name the actual failure mode of the technique being taught, and
 * the event-specific ones are appended from `stillUnknown` and `doNotSay`, which are
 * already event-specific by construction.
 */
const ANGLE_LIMITATIONS: Record<Angle['kind'], readonly string[]> = {
  technical_explanation: [
    'This was tested on one machine with one configuration; behaviour on other setups may differ.',
    'The API surface shown may change without notice — check the version before relying on it.',
  ],
  comparison: [
    'The comparison uses one workload. A different workload can reverse the result entirely.',
    'Both sides were tested at a single point in time; either may have improved since.',
  ],
  version_diff: [
    'Undocumented behaviour changes are, by definition, not in the release notes — this diff covers what was observable, not everything that changed.',
    'A behaviour that changed once can change back.',
  ],
  benchmark_interpretation: [
    'A benchmark measures what it measures. Performance on it does not transfer to a task it does not resemble.',
    'The numbers here come from the published result, not from an independent re-run.',
  ],
  cost_implication: [
    'Costs are computed from published list prices and one real workload; negotiated pricing, caching, and batch discounts all change the figure.',
    'Token counts vary with content. A different corpus produces a different bill.',
  ],
  second_order_effect: [
    'This is reasoning about consequences, not a reported fact. The chain may break at any link.',
    'Timelines stated by vendors slip routinely.',
  ],
  myth_correction: [
    'Correcting a widely-held belief invites scrutiny — every claim here should be checkable against the linked evidence before posting.',
    'The belief may be true in a context this correction does not cover.',
  ],
  skepticism: [
    'Absence of evidence is not evidence of absence; this points at what is unestablished, not at what is false.',
    'If the claim is later confirmed, say so publicly — a correction not issued is worse than the original doubt.',
  ],
};

/** The method skeleton per angle. Concrete steps, not advice. */
function methodFor(angle: Angle, input: EducationalInput): string[] {
  const subject = input.title.slice(0, 80);

  switch (angle.kind) {
    case 'technical_explanation':
      return [
        `Install or update to the version named in "${subject}".`,
        'Write the smallest program that exercises the new behaviour — one file, no framework.',
        'Run it and capture the actual output, including anything unexpected.',
        'Run the same program against the previous version and capture that output too.',
        'Publish both outputs side by side, with the command that produced them.',
      ];
    case 'comparison':
      return [
        'Pick one workload you actually run — not a synthetic benchmark.',
        'Define the single metric that decides the answer for you (latency, cost, accuracy — one of them).',
        'Run both options on that workload, three times each, and record every result.',
        'Report the median and the spread. A single run is an anecdote.',
        'State the workload explicitly so a reader can judge whether it resembles theirs.',
      ];
    case 'version_diff':
      return [
        'Check out the previous version and the new one side by side.',
        'Run the same script against both and diff the outputs, not the source.',
        'For each difference, find the release-note line that explains it — or note that none does.',
        'The undocumented differences are the post.',
      ];
    case 'benchmark_interpretation':
      return [
        'Find what the benchmark actually asks the model to do — read the task definition, not the leaderboard.',
        'Identify one task you care about that the benchmark does NOT cover.',
        'Explain in one sentence what a high score does and does not predict.',
        'If you can, run your own task and show where the ranking does not hold.',
      ];
    case 'cost_implication':
      return [
        'Take one real job you have run — a real prompt, a real document, real volume.',
        'Count its tokens with the provider’s token-counting endpoint, never with an estimator built for a different tokenizer.',
        'Multiply by the published rate, then by your actual monthly volume.',
        'Compute the same figure for the alternative.',
        'Publish the workload, the token count, and the arithmetic — not just the conclusion.',
      ];
    case 'second_order_effect':
      return [
        `State the fact from "${subject}" plainly, with its source.`,
        'Name exactly who has to change something as a result.',
        'For each, say what they have to change and by when.',
        'Say which link in the chain is the weakest, and what would break it.',
      ];
    case 'myth_correction':
      return [
        'State the widely-repeated claim in the form people actually say it.',
        'Show the evidence that contradicts it, with a link.',
        'Explain how the belief arose — usually it was true once, or true in a narrower case.',
        'Say what IS true, precisely, and what remains genuinely uncertain.',
      ];
    case 'skepticism':
      return [
        'State what is being claimed and by whom, without editorialising.',
        'List what would need to be shown for the claim to hold.',
        'Say which of those things the evidence currently shows, and which it does not.',
        'Commit publicly to updating if the missing evidence appears.',
      ];
  }
}

function formatFor(angle: Angle): TeachingFormat {
  switch (angle.kind) {
    case 'technical_explanation':
      return 'code_snippet';
    case 'comparison':
      return 'comparison_table';
    case 'version_diff':
      return 'walkthrough';
    case 'cost_implication':
      return 'thread';
    case 'benchmark_interpretation':
    case 'myth_correction':
      return 'thread';
    case 'second_order_effect':
    case 'skepticism':
      return 'single_post';
  }
}

/**
 * Build one educational opportunity, or nothing.
 *
 * Returns `undefined` when there is no teachable angle. Most events are not teaching
 * opportunities, and the roadmap asks for "one or two per day" out of hundreds — so
 * returning nothing is the common and correct outcome, not a failure.
 */
export function buildEducationalOpportunity(
  input: EducationalInput,
): EducationalOpportunity | undefined {
  const angles = findAngles(input);

  // Only some angles teach. `second_order_effect` and `skepticism` are commentary:
  // valuable, but they do not leave the reader able to DO something, which is what
  // separates a teaching post from an opinion.
  const teachable = angles.find((angle) =>
    (
      [
        'technical_explanation',
        'cost_implication',
        'comparison',
        'version_diff',
        'benchmark_interpretation',
        'myth_correction',
      ] as Angle['kind'][]
    ).includes(angle.kind),
  );

  if (teachable === undefined) return undefined;

  // A teaching post is only credible if the operator can actually do the thing. An
  // untestable technique taught second-hand is exactly the content §A1 warns about.
  if (!input.testable && teachable.kind !== 'myth_correction') return undefined;

  const limitations = [
    ...ANGLE_LIMITATIONS[teachable.kind],
    // Event-specific limitations. These are the ones that make the section non-generic.
    ...input.stillUnknown.slice(0, 2).map((item) => `Not established by the evidence: ${item}`),
    ...input.doNotSay.slice(0, 2),
  ];

  // THE non-negotiable. Enforced here rather than trusted.
  if (limitations.length === 0) return undefined;

  const subject = input.title.slice(0, 80);

  return {
    eventId: input.eventId,
    topic: subject,
    whyNow: `"${subject}" gives a current, concrete example — the technique itself is not new, but a reader is more likely to try it while the example is live.`,
    audience:
      input.category === 'ai'
        ? 'developers building on AI APIs who have shipped something and hit the cost or reliability wall'
        : 'developers who use this tool in production rather than evaluating it',
    hook: `Most people will read the announcement. Here is what happens when you actually run it.`,
    teachingPoint: teachable.prompt,
    method: methodFor(teachable, input),
    workedExample: `Work the method above against "${subject}" and publish the real numbers — the commands, the raw output, and the part that did not go as expected.`,
    limitations,
    format: formatFor(teachable),
    angle: teachable.kind,
  };
}

// ─────────────────────────────────────────────────────────────────────
// The experiment generator — brief §34, ROADMAP.md Phase 8
// ─────────────────────────────────────────────────────────────────────

export const EXPERIMENT_STATUSES = ['queued', 'running', 'done', 'abandoned'] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

/**
 * An experiment the operator can actually run.
 *
 * `ROADMAP.md` Phase 8 acceptance: "≥5 experiments generated that the operator judges
 * **genuinely runnable in under 2 hours**". That constraint is the design: an
 * experiment needing a week of setup is a research project, and it will not happen.
 *
 * `result` is deliberately absent from the generated object. The system proposes the
 * experiment; the operator runs it and fills the result in. A generated result would
 * be a fabricated measurement, which is the one thing this project never does.
 */
export type Experiment = {
  readonly eventId: number;
  /** A question with a checkable answer, not a topic. */
  readonly question: string;
  /** What he expects, stated before running it — so being wrong is informative. */
  readonly hypothesis: string;
  readonly requiredInputs: readonly string[];
  readonly procedure: readonly string[];
  /** How the answer gets measured. Named metrics, not "see if it's better". */
  readonly metrics: readonly string[];
  readonly estimatedMinutes: number;
  /** What he writes if the answer is yes, and what he writes if it is no. */
  readonly contentAngle: string;
  readonly status: ExperimentStatus;
};

/** Ceiling from the acceptance criterion: runnable in under two hours. */
export const MAX_EXPERIMENT_MINUTES = 120;

export function buildExperiment(input: EducationalInput): Experiment | undefined {
  const angles = findAngles(input);
  const angle = angles[0];
  if (angle === undefined) return undefined;

  // An experiment he cannot run is not an experiment.
  if (!input.testable) return undefined;

  const subject = input.title.slice(0, 80);

  const byAngle: Partial<
    Record<
      Angle['kind'],
      Pick<Experiment, 'question' | 'hypothesis' | 'metrics' | 'estimatedMinutes'>
    >
  > = {
    technical_explanation: {
      question: `Does the behaviour described in "${subject}" hold on a real workload, or only on the vendor's example?`,
      hypothesis:
        'It holds on the happy path and degrades on the edge case the announcement does not mention.',
      metrics: [
        'works / does not work on the real input',
        'output difference vs the previous version',
      ],
      estimatedMinutes: 45,
    },
    cost_implication: {
      question: `What does "${subject}" actually cost on one month of his real traffic?`,
      hypothesis:
        'The list price understates it, because real prompts are longer than the pricing-page example.',
      metrics: [
        'tokens per request (measured, not estimated)',
        'USD per 1,000 requests',
        'delta vs the current setup',
      ],
      estimatedMinutes: 60,
    },
    comparison: {
      question: `On his own workload, does the option in "${subject}" beat what he already uses?`,
      hypothesis: 'It wins on the vendor benchmark and loses or ties on his workload.',
      metrics: [
        'median latency over 3 runs',
        'cost per run',
        'output quality judged against a fixed rubric',
      ],
      estimatedMinutes: 90,
    },
    version_diff: {
      question: `What changed between versions in "${subject}" that the release notes do not mention?`,
      hypothesis: 'At least one observable behaviour changed without being documented.',
      metrics: ['count of undocumented behaviour differences', 'whether any is breaking'],
      estimatedMinutes: 60,
    },
    benchmark_interpretation: {
      question: `Does the benchmark result in "${subject}" predict performance on a task he actually runs?`,
      hypothesis:
        'The ranking does not transfer — the benchmark task and his task differ in the way that matters.',
      metrics: [
        'his-task score for each option',
        'rank correlation with the published leaderboard',
      ],
      estimatedMinutes: 90,
    },
  };

  const spec = byAngle[angle.kind];
  if (spec === undefined) return undefined;
  if (spec.estimatedMinutes > MAX_EXPERIMENT_MINUTES) return undefined;

  return {
    eventId: input.eventId,
    question: spec.question,
    hypothesis: spec.hypothesis,
    requiredInputs: [
      'a real prompt or workload from one of his own projects',
      'API access to the thing under test',
      'the previous version or the incumbent alternative, for comparison',
    ],
    procedure: methodFor(angle, input),
    metrics: spec.metrics,
    estimatedMinutes: spec.estimatedMinutes,
    contentAngle: `If the hypothesis holds: publish the measurement, because it contradicts the announcement and almost nobody will have checked. If it does not hold: publish that too — "I expected X and got Y" is a more honest post than most, and it is one only someone who ran it can write.`,
    status: 'queued',
  };
}
