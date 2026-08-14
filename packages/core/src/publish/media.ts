/**
 * Attention assessment and the media plan.
 *
 * ## "Viral potential" without becoming an engagement-farming tool
 *
 * The operator asked for viral potential. The obvious implementation — ask a model what
 * would get attention — produces a system that recommends manufactured controversy
 * within a week, because that genuinely does get attention. §11 of the brief rules that
 * out explicitly, and the ruling is enforced structurally rather than by instruction:
 *
 *   - the drivers are a **closed enum** in `packages/ai/src/schema.ts`, and every member
 *     is a property *of the event* — there is no `controversy`, no `hot_take`;
 *   - the verdict is computed **here, from those drivers**, not written by the model;
 *   - the reason shown to the operator lists which drivers fired, so a HIGH he
 *     disagrees with is auditable rather than oracular.
 *
 * A system that says "HIGH because it is independently testable and the before/after
 * gap is large" is making a checkable claim. A system that says "HIGH 🔥" is not.
 */

import type { AttentionDriver, MediaKind } from '@signal-desk/shared';

export const ATTENTION_LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type AttentionLevel = (typeof ATTENTION_LEVELS)[number];

/**
 * Weights, and the honest label on them: these are **guesses**, like the Phase 5 score
 * weights, and they are written down so they can be argued with rather than discovered.
 *
 * The shape of the guess is the defensible part. `independently_testable` and
 * `strong_before_after` carry the most because they are the two drivers the operator
 * can *act on* — both convert a comment into evidence. `timing_window` carries least
 * because it decays to zero on its own and rewards speed over substance.
 */
const DRIVER_WEIGHTS: Record<AttentionDriver, number> = {
  independently_testable: 1.0,
  strong_before_after: 0.9,
  surprising_result: 0.85,
  measurable_comparison: 0.75,
  visually_demonstrable: 0.7,
  practical_consequence: 0.65,
  competitive_implication: 0.6,
  novelty: 0.5,
  timing_window: 0.35,
};

const DRIVER_LABELS: Record<AttentionDriver, string> = {
  independently_testable: 'anyone can run it today',
  strong_before_after: 'the before/after gap is the story',
  surprising_result: 'the result contradicts what you would expect',
  measurable_comparison: 'there is a number to compare',
  visually_demonstrable: 'it shows better than it tells',
  practical_consequence: 'it lands on real work',
  competitive_implication: 'it forces a competitor to respond',
  novelty: 'genuinely new, not an expected iteration',
  timing_window: 'being early still counts',
};

export type AttentionAssessment = {
  readonly level: AttentionLevel;
  readonly score: number;
  readonly drivers: readonly AttentionDriver[];
  /** One sentence naming the drivers that fired. Never a bare adjective. */
  readonly reason: string;
  /** Present when the level is LOW and the operator should be told why not. */
  readonly limitation: string | undefined;
};

export type AttentionInput = {
  readonly drivers: readonly AttentionDriver[];
  /** The model's own sentence. Used only when it survives sanitisation. */
  readonly modelReason: string;
  readonly hoursSinceEvent: number;
  readonly distinctSourceCount: number;
};

export function assessAttention(input: AttentionInput): AttentionAssessment {
  const unique = [...new Set(input.drivers)];
  const raw = unique.reduce((sum, driver) => sum + (DRIVER_WEIGHTS[driver] ?? 0), 0);

  // Two strong drivers should reach HIGH; one alone should not. The thresholds are set
  // against the weights above rather than against a normalised 0..1, because the count
  // of drivers is itself signal — an event with five is different from one with two.
  const level: AttentionLevel = raw >= 2.2 ? 'HIGH' : raw >= 1.1 ? 'MEDIUM' : 'LOW';

  const named = unique
    .slice()
    .sort((a, b) => (DRIVER_WEIGHTS[b] ?? 0) - (DRIVER_WEIGHTS[a] ?? 0))
    .slice(0, 3)
    .map((driver) => DRIVER_LABELS[driver]);

  let limitation: string | undefined;
  if (unique.length === 0) {
    limitation =
      'No attention driver applies. This is ordinary news; post it only if you have something to add.';
  } else if (level === 'LOW') {
    limitation = 'One weak driver. Worth posting only as part of something larger.';
  }

  const reason =
    named.length === 0
      ? 'Nothing here is unusual enough to travel on its own.'
      : `${named.join('; ')}.`;

  return {
    level,
    score: Math.round(raw * 100) / 100,
    drivers: unique,
    reason,
    limitation,
  };
}

// ───────────────────────────── media plan ─────────────────────────────

export type MediaPlan = {
  readonly kind: MediaKind;
  /** Human label for the card header. */
  readonly label: string;
  /** What is on screen. */
  readonly whatToShow: string;
  /** Why it helps — the §13 requirement that this is not just "add an image". */
  readonly whyItHelps: string;
  /** Ordered, concrete steps. */
  readonly howToMake: readonly string[];
  /** Where the raw material comes from. */
  readonly source: string;
  /** The simplest tool that does the job. Never the most impressive one. */
  readonly tool: string;
  /** Only for screen recordings. */
  readonly video: VideoPlan | undefined;
  /** Only when an original generated image would genuinely help. */
  readonly imagePrompt: string | undefined;
};

export type VideoPlan = {
  readonly seconds: string;
  readonly firstTwoSeconds: string;
  readonly sequence: readonly string[];
  readonly overlayText: string;
  readonly narration: string;
  readonly finalFrame: string;
};

export type MediaInput = {
  readonly kind: MediaKind;
  readonly whatToShow: string;
  readonly sourceHint: string;
  readonly title: string;
  readonly before: string;
  readonly after: string;
  readonly testable: boolean;
  readonly testableClaim: string;
};

const LABELS: Record<MediaKind, string> = {
  none: 'No media',
  screenshot: 'Screenshot',
  benchmark_run: 'Benchmark you run',
  comparison_chart: 'Comparison chart',
  screen_recording: 'Screen recording',
  official_image: 'Official image',
};

/**
 * A copy-ready prompt for an image generator, or nothing.
 *
 * ## Why this is generated in code rather than by the model
 *
 * The failure mode of an AI-written image prompt is that it invents: a logo that does
 * not exist, a benchmark bar at a height nobody measured, a UI that was never shipped.
 * The operator would then post a picture asserting something false, which is a worse
 * outcome than posting no picture — and unlike a wrong sentence, a wrong chart is not
 * obviously wrong to a reader.
 *
 * So the prompt is assembled from **fields that already passed validation**, and it
 * carries explicit negative constraints. It never asks for a brand mark, never asks for
 * a number the analysis did not establish, and never asks for a screenshot of a real
 * product — those are things to capture, not to generate.
 *
 * Returns `undefined` when an image would not help. A generated illustration attached
 * to a technical post is decoration, and decoration on a credibility play is a cost.
 */
function imagePromptFor(input: MediaInput): string | undefined {
  const hasComparison = input.before.trim() !== '' && input.after.trim() !== '';

  // Only two cases genuinely benefit from a generated image. Everything else is better
  // served by a screenshot of the real thing, which is evidence rather than art.
  if (!hasComparison && input.kind !== 'comparison_chart') return undefined;

  const before = input.before.trim().slice(0, 90);
  const after = input.after.trim().slice(0, 90);

  return [
    'A clean, editorial-style technical diagram for a developer audience.',
    hasComparison
      ? `Two labelled panels side by side comparing a before and after state. Left panel labelled "BEFORE": ${before}. Right panel labelled "AFTER": ${after}.`
      : 'A single labelled panel stating one technical comparison.',
    'Style: dark background (#0b0d12), one restrained accent colour, thin geometric lines, generous negative space, no gradients, no glow, no 3D.',
    'Typography: one clean sans-serif, high contrast, large enough to read on a phone.',
    'Aspect ratio 16:9, suitable for an X post.',
    '',
    'Hard constraints — the image must NOT contain:',
    '- any company logo, wordmark, or brand identity of any kind',
    '- any number, percentage, or benchmark figure that is not written above',
    '- any fake user interface, fake screenshot, or fake product photograph',
    '- any human face, any stock-photo styling, any decorative illustration',
    '- any text other than the labels given above',
  ].join('\n');
}

/**
 * Build the plan for the media the analysis suggested.
 *
 * Returns `undefined` for `none`, and `none` is the common case. A dashboard that
 * always shows a video recommendation is a dashboard whose video recommendation is
 * ignored — §15: "Do not recommend video merely because it sounds impressive."
 *
 * The `screen_recording` branch additionally **refuses** when there is nothing to run.
 * A recording of a page being scrolled is not evidence, and recommending one teaches
 * the operator to produce filler.
 */
export function planMedia(input: MediaInput): MediaPlan | undefined {
  if (input.kind === 'none') return undefined;

  const what = input.whatToShow.trim();
  const source =
    input.sourceHint.trim() === '' ? 'The official announcement page.' : input.sourceHint.trim();

  if (input.kind === 'screen_recording' && !(input.testable && input.testableClaim.trim() !== '')) {
    // Downgrade rather than drop: there is still something to show, just not in motion.
    return planMedia({ ...input, kind: 'screenshot' });
  }

  const base = {
    kind: input.kind,
    label: LABELS[input.kind],
    whatToShow: what === '' ? 'Ekranda tam olarak hangi iddianın göründüğü.' : what,
    source,
    video: undefined,
    imagePrompt: imagePromptFor(input),
  };

  switch (input.kind) {
    case 'screenshot':
      return {
        ...base,
        whyItHelps: 'A screenshot is the cheapest way to stop a post being a claim about a claim.',
        howToMake: [
          `Open ${source}.`,
          'Frame only the part that carries the fact — crop out chrome, navigation and unrelated copy.',
          'Take the shot at 2× scale so the text stays legible in the timeline.',
          'Check the crop for anything you did not mean to publish before attaching it.',
        ],
        tool: 'Your OS screenshot tool. Nothing else is needed.',
      };

    case 'benchmark_run':
      return {
        ...base,
        whyItHelps:
          'Running it yourself is the difference between reporting the number and having one. This is the strongest thing you can attach.',
        howToMake: [
          input.testableClaim.trim() === ''
            ? 'Pick the single claim most worth checking.'
            : `Run this: ${input.testableClaim.trim()}`,
          'Run the same task against the previous version or the obvious competitor — one variable at a time.',
          'Capture both outputs side by side, unedited, including the parts that disagree with the announcement.',
          'State your setup in the post. An unreproducible number is worth less than no number.',
        ],
        tool: 'Your normal terminal or the vendor playground. Do not build a harness for one post.',
      };

    case 'comparison_chart':
      return {
        ...base,
        whyItHelps:
          input.before !== '' && input.after !== ''
            ? 'The before/after gap is the whole story and a chart states it in one glance.'
            : 'A single comparison is easier to read as a chart than as a sentence.',
        howToMake: [
          input.before !== '' && input.after !== ''
            ? `Two bars: "${input.before.slice(0, 60)}" against "${input.after.slice(0, 60)}".`
            : 'Two bars, one per thing being compared.',
          'Label the axis with the unit. An unlabelled axis reads as a sales chart.',
          'No gradients, no 3D, no truncated y-axis — a truncated axis is the fastest way to be accused of spin.',
          'Put the source under the chart, in the image.',
        ],
        tool: 'A spreadsheet, or plain SVG. Resist anything heavier.',
        imagePrompt: imagePromptFor(input),
      };

    case 'screen_recording': {
      const claim = input.testableClaim.trim();
      return {
        ...base,
        whyItHelps:
          'Motion carries what a still cannot: that it actually runs, in real time, on your machine.',
        howToMake: [
          'Clear your screen of anything you would not publish — notifications, tabs, other windows.',
          `Rehearse once. The recording should be the second take, not the first.`,
          'Record at a window size where the text is readable on a phone.',
          'Trim the dead air at both ends. No intro.',
        ],
        tool: 'Your OS screen recorder. No editor beyond trimming.',
        video: {
          seconds: '12–20 seconds',
          firstTwoSeconds: 'The result, before the setup. Lead with what surprised you.',
          sequence: [
            'Frame 0–2s: the finished result on screen.',
            claim === ''
              ? 'Frame 2–8s: the command being run.'
              : `Frame 2–8s: running "${claim.slice(0, 80)}".`,
            'Frame 8–15s: the output, uncut, including the slow part if there is one.',
            'Frame 15–20s: the comparison — previous version or competitor, same task.',
          ],
          overlayText: 'I ran this myself. Same task, both versions.',
          narration: 'None. Silent video autoplays in the timeline; narration does not.',
          finalFrame: 'Hold on the side-by-side result so a paused scroll still shows the point.',
        },
      };
    }

    case 'official_image':
      return {
        ...base,
        whyItHelps:
          'Costs nothing and makes the post legible in a scroll. It adds no evidence — pair it with something of your own if you can.',
        howToMake: [
          `Take the announcement image from ${source}.`,
          'Check the licence or terms before reposting it.',
          'Do not crop out attribution.',
        ],
        tool: 'None.',
      };

    default:
      return undefined;
  }
}
