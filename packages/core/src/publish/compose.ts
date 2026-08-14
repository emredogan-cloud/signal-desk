import { MAX_POST_CHARS } from './confirm.js';
import type { OptionKind } from '../strategy/options.js';

/**
 * The draft composer. Turns analysis material into posts the operator can paste.
 *
 * ## The one thing this module exists to guarantee
 *
 * **Model output is untrusted input here, exactly like a fetched RSS item.**
 *
 * That is not paranoia about the vendor. `THREAT-MODEL.md` §T-1 establishes that every
 * analysis is produced by a model that has just read third-party content the operator
 * does not control, and §T-1 mitigation 2 bounds the damage to "a wrong value in a
 * known field". This module is where that bound stops being enough: a wrong value in
 * `draftMaterial.hook` is a string the operator is invited to **paste onto his own
 * timeline**. An injected `@handle` becomes a mention. An injected `t.co` link becomes
 * a click. An injected sentence becomes something he said.
 *
 * So the character limit, the do-not-say list, and the absence of handles, links, and
 * hashtags are enforced **here, in code, with tests** — never delegated to the prompt.
 * The prompt asks for clean lines because that produces better drafts; this module
 * assumes it did not because that produces safe ones.
 *
 * ## What it deliberately does not do
 *
 * It does not post. It does not know how to post. `publish/confirm.ts` owns the T-4
 * control and this module has no path to it — composing a draft and authorising a send
 * are separate acts, and the operator performs the second one by hand.
 *
 * It also does not emit one draft per format for the sake of a full grid. §8 of the
 * dashboard brief: "Do NOT generate five versions merely for the sake of quantity."
 * A format is emitted when it has something the others do not.
 */

/**
 * Re-exported from `confirm.ts` rather than redeclared.
 *
 * Two constants named `MAX_POST_CHARS` that could drift apart is how a draft passes
 * composition and is then refused at the T-4 authorisation gate — the operator would
 * see a valid-looking draft that cannot be sent, with no explanation.
 */
export { MAX_POST_CHARS };

/**
 * The shapes a draft can take. These are *post structures*, not the strategy's
 * `OptionKind` — a `quote` option and a `standalone` post can carry the same lines.
 */
export const DRAFT_FORMATS = ['reaction', 'breakdown', 'operator_take', 'quote', 'thread'] as const;
export type DraftFormat = (typeof DRAFT_FORMATS)[number];

export type DraftKind = 'standalone' | 'quote' | 'thread';

export type Draft = {
  readonly format: DraftFormat;
  readonly kind: DraftKind;
  /** Ready to paste. Already within `MAX_POST_CHARS` for every part. */
  readonly text: string;
  /** Per-part character counts. One entry unless `kind` is `thread`. */
  readonly parts: readonly { readonly text: string; readonly chars: number }[];
  readonly chars: number;
  readonly fits: boolean;
  /** Why this format is offered for this event. Rendered next to it. */
  readonly rationale: string;
};

export type ComposeInput = {
  readonly title: string;
  /** From the Phase 6 analysis. Every field is treated as hostile. */
  readonly hook: string;
  readonly substance: string;
  readonly soWhat: string;
  readonly testableClaim: string;
  readonly before: string;
  readonly after: string;
  /** Claims the operator must not make. Any draft containing one is dropped. */
  readonly doNotSay: readonly string[];
  /** The strategy's recommended option, which decides whether `quote` makes sense. */
  readonly recommendedOption: OptionKind | undefined;
  readonly hasOfficialSource: boolean;
  readonly testable: boolean;
  /** Hours since the event. Under `EARLY_WINDOW_HOURS` a reaction still has value. */
  readonly hoursSinceEvent: number;
};

/**
 * Vocabulary that makes a post read as generated rather than written.
 *
 * §10 of the brief lists most of these by name. They are stripped rather than merely
 * flagged: a warning the operator has to act on is a warning he will eventually paste
 * past at 2am. Matched case-insensitively on word boundaries.
 */
const HYPE_PATTERNS: readonly RegExp[] = [
  /\bgame[- ]?chang(er|ing)\b/gi,
  /\bthis changes everything\b/gi,
  /\bthe future is here\b/gi,
  /\blet that sink in\b/gi,
  /\bmind[- ]?blow(n|ing)\b/gi,
  /\binsane(ly)?\b/gi,
  /\bhuge\b/gi,
  /\bmassive(ly)?\b/gi,
  /\brevolutionar(y|ise|ize)\b/gi,
  /\bunbelievable\b/gi,
  /\bwild\b/gi,
  /\bbanger\b/gi,
  /\bgoes hard\b/gi,
  /\bwe are so back\b/gi,
  /\bit's over\b/gi,
];

/**
 * Everything that must never survive into a draft.
 *
 * Links are removed rather than shortened. A link in an X post costs **$0.200** per the
 * pay-per-use table (ENV-HANDBOOK §4) versus $0.015 without — a 13× multiplier — and
 * the operator publishes by hand anyway, so a URL here buys nothing and risks pasting
 * an address that came out of a hostile document.
 */
function stripUnsafe(raw: string): string {
  return (
    raw
      // Anything link-shaped, including bare hosts and protocol-relative forms.
      .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '')
      .replace(/\b[a-z0-9-]+\.(?:com|io|ai|dev|org|net|co|app|xyz|sh|me)\b\/\S*/gi, '')
      // Mentions and hashtags: an injected handle becomes a real mention on send.
      .replace(/(^|\s)[@#][\w]+/g, '$1')
      // Zero-width and bidi controls — the hidden-text vector from §T-1. Written as
      // escapes rather than literals: these characters are invisible in an editor, so a
      // literal class is a line no reviewer can actually read or verify.
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '')
      // Emoji and pictographs. §10 bans them; stripping is how it stays banned.
      // Three separate passes rather than one class: combining a pictograph range with
      // the variation selectors in a single class splits grapheme clusters, which is
      // what `no-misleading-character-class` is warning about.
      .replace(/[\u{1F000}-\u{1FAFF}]/gu, '')
      .replace(/[\u{2600}-\u{27BF}]/gu, '')
      .replace(/[\u{FE00}-\u{FE0F}]/gu, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
  );
}

function stripHype(raw: string): string {
  let out = raw;
  for (const pattern of HYPE_PATTERNS) out = out.replace(pattern, '');
  return out
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
}

/** One sentence, cleaned. Empty when nothing survived — callers must handle that. */
export function cleanLine(raw: string): string {
  const cleaned = stripHype(stripUnsafe(raw));
  if (cleaned === '') return '';
  // Collapse a trailing run of punctuation left behind by a removed clause.
  return cleaned.replace(/[\s,;:]+$/, '');
}

/**
 * Does this text assert something the analysis said not to assert?
 *
 * Deliberately crude and deliberately over-eager. It compares against the *content
 * words* of each do-not-say entry, so "Do not say it is generally available — the post
 * says research preview" catches a draft containing "generally available". A false
 * positive costs one unused draft; a false negative costs the operator's credibility,
 * which is the only asset this system is building.
 */
export function violatesDoNotSay(text: string, doNotSay: readonly string[]): boolean {
  const haystack = text.toLowerCase();

  for (const entry of doNotSay) {
    // The entries are written as instructions. Strip the instruction wrapper to get at
    // the phrase being prohibited.
    const phrase = entry
      .toLowerCase()
      .replace(/^do not (say|claim|state|compare|imply|call)\s*/i, '')
      .split(/[—–\-;:]/)[0]
      ?.trim();
    if (phrase === undefined || phrase.length < 12) continue;

    const words = phrase.split(/\s+/).filter((word) => word.length > 3);
    if (words.length < 2) continue;

    // Every substantial word present, in any order, is enough to suspect the claim.
    if (words.every((word) => haystack.includes(word))) return true;
  }

  return false;
}

/**
 * Trim one line to `limit` characters at a word boundary.
 *
 * Only ever applied to a line that is *alone* too long for a post. Cutting mid-word is
 * how a draft reads as machine output; cutting at a space with an ellipsis reads as an
 * abbreviation, which is what it is.
 */
function trimTo(line: string, limit: number): string {
  if (line.length <= limit) return line;
  const cut = line.slice(0, limit - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

/**
 * Assemble lines into one post that fits.
 *
 * ### Why this packs rather than validates
 *
 * The first version joined every line and rejected the result if it exceeded 280. That
 * turned one verbose sentence from the model into **zero drafts** — the panel rendered
 * "no draft available", which the operator would reasonably read as "there is nothing
 * to say here" rather than "one input ran long". Silence that looks like a verdict is
 * the worst failure this dashboard can produce.
 *
 * So lines are added while they fit, in the order given, and the order is significance:
 * the caller passes the hook first and the least essential line last. A line that does
 * not fit is dropped, not truncated — except the first, which is trimmed, because a
 * post with no opening line is not a post.
 */
function assemble(lines: readonly string[], limit = MAX_POST_CHARS): string {
  const cleaned = lines.map((line) => cleanLine(line)).filter((line) => line !== '');
  if (cleaned.length === 0) return '';

  const parts: string[] = [trimTo(cleaned[0] ?? '', limit)];
  let used = parts[0]?.length ?? 0;

  for (const line of cleaned.slice(1)) {
    const cost = line.length + 2; // the blank line between paragraphs
    if (used + cost > limit) continue;
    parts.push(line);
    used += cost;
  }

  return parts.join('\n\n').trim();
}

function finish(
  format: DraftFormat,
  kind: DraftKind,
  parts: readonly string[],
  rationale: string,
  doNotSay: readonly string[],
): Draft | undefined {
  const cleaned = parts.map((part) => part.trim()).filter((part) => part !== '');
  if (cleaned.length === 0) return undefined;

  // Every part must fit independently. A thread whose third post is 300 characters is
  // not a thread the operator can send, and telling him after he has copied it is too
  // late.
  if (cleaned.some((part) => part.length > MAX_POST_CHARS)) return undefined;

  const text = cleaned.join('\n\n');
  if (violatesDoNotSay(text, doNotSay)) return undefined;

  return {
    format,
    kind,
    text,
    parts: cleaned.map((part) => ({ text: part, chars: part.length })),
    chars: cleaned.reduce((sum, part) => sum + part.length, 0),
    fits: true,
    rationale,
  };
}

/**
 * Compose the drafts worth offering for this event.
 *
 * Returns an empty array when nothing composable survived — which is a real outcome and
 * must render as "no draft", never as a blank box the operator mistakes for a loading
 * state. A MOCK analysis lands here too, and its marker survives into the text by
 * design: a placeholder that looked like a draft is exactly the fabricated-live-result
 * failure this project forbids.
 */
export function composeDrafts(input: ComposeInput): Draft[] {
  const hook = cleanLine(input.hook);
  const substance = cleanLine(input.substance);
  const soWhat = cleanLine(input.soWhat);
  const testable = cleanLine(input.testableClaim);
  const before = cleanLine(input.before);
  const after = cleanLine(input.after);

  const drafts: (Draft | undefined)[] = [];

  // ─── Reaction: the shortest thing worth saying ────────────────────────────
  // Only while being early still means something. After the window, a bare reaction is
  // the lowest-value post available and offering it invites the worst option.
  if (input.hoursSinceEvent <= 12) {
    drafts.push(
      finish(
        'reaction',
        'standalone',
        [assemble([hook, substance])],
        'Short enough to send now, while being early still counts.',
        input.doNotSay,
      ),
    );
  }

  // ─── Breakdown: what changed, concretely ──────────────────────────────────
  if (before !== '' && after !== '') {
    drafts.push(
      finish(
        'breakdown',
        'standalone',
        [assemble([hook, `Before: ${before}`, `Now: ${after}`, soWhat])],
        'The before/after gap is the story here, so state both sides.',
        input.doNotSay,
      ),
    );
  } else {
    drafts.push(
      finish(
        'breakdown',
        'standalone',
        [assemble([hook, substance, soWhat])],
        'Carries the detail a bare reaction leaves out.',
        input.doNotSay,
      ),
    );
  }

  // ─── Operator take: only when he can actually back it ─────────────────────
  // §16: original evidence beats analysis beats reporting. This format is offered ONLY
  // when there is something to test, because "I tested it" without a test is the one
  // failure mode this whole system is built to avoid.
  if (input.testable && testable !== '') {
    drafts.push(
      finish(
        'operator_take',
        'standalone',
        [assemble([hook, testable, soWhat])],
        'You can run this yourself — that turns a comment into evidence.',
        input.doNotSay,
      ),
    );
  }

  // ─── Quote: text designed to sit above someone else's post ────────────────
  // Needs an official source to quote, and only worth offering when the strategy
  // actually picked quoting.
  if (input.hasOfficialSource && input.recommendedOption === 'quote') {
    drafts.push(
      finish(
        'quote',
        'quote',
        [assemble([soWhat, substance])],
        'Sits above the original announcement; assumes the reader can see it.',
        input.doNotSay,
      ),
    );
  }

  // ─── Thread: only when there is genuinely more than one post of substance ─
  const threadParts = [
    assemble([hook, substance]),
    before !== '' && after !== '' ? assemble([`Before: ${before}`, `Now: ${after}`]) : '',
    testable !== '' ? assemble([testable]) : '',
    assemble([soWhat]),
  ].filter((part) => part !== '');

  if (threadParts.length >= 3) {
    const numbered = threadParts.map((part, index) => `${String(index + 1)}/ ${part}`);
    drafts.push(
      finish(
        'thread',
        'thread',
        numbered,
        `${String(numbered.length)} posts of distinct substance — not one post cut into pieces.`,
        input.doNotSay,
      ),
    );
  }

  /**
   * Deduplicate by text, keeping the most specific format.
   *
   * ### Why this is not a tidy-up
   *
   * Observed in the browser on 2026-08-14: an analysis whose `hook` ran to 249
   * characters filled a 280-character post on its own, so `assemble` had no room for
   * the lines that distinguish one format from another — and TEKNİK ÖZET and KENDİ
   * TESTİN rendered as **byte-identical drafts under different headings**.
   *
   * That is worse than offering one draft. It invites the operator to compare two
   * things that are the same, and it quietly breaks the promise the labels make: a
   * draft headed "your own test" that contains no test is a lie about its own content.
   * §8 of the brief — "do NOT generate five versions merely for the sake of quantity"
   * — is a rule about honesty, not about screen space.
   *
   * Specificity order is the order they were pushed, most specific last, so a later
   * duplicate replaces an earlier one only when it claims more.
   */
  const seen = new Map<string, Draft>();
  const specificity: Record<DraftFormat, number> = {
    reaction: 0,
    breakdown: 1,
    quote: 2,
    operator_take: 3,
    thread: 4,
  };

  for (const draft of drafts) {
    if (draft === undefined) continue;
    const existing = seen.get(draft.text);
    if (existing === undefined || specificity[draft.format] > specificity[existing.format]) {
      seen.set(draft.text, draft);
    }
  }

  return [...seen.values()].sort((a, b) => specificity[a.format] - specificity[b.format]);
}
