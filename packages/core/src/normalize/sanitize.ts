/**
 * Sanitisation. **THREAT-MODEL.md §T-1 mitigation 3.**
 *
 * Everything this system ingests is attacker-writable: RSS bodies, GitHub release
 * notes, commit messages, Reddit text. This module is the layer that runs before any
 * of it reaches an LLM or a browser.
 *
 * It is defence in depth, not the load-bearing control. The load-bearing control is
 * capability starvation — the models in this pipeline hold **no tools**, so a perfect
 * injection wins the ability to put wrong text in a JSON field and nothing more.
 * Sanitisation raises the cost of the attempt and, more usefully, makes attempts
 * *visible* (see `detectInjectionSignals`).
 *
 * What it must handle, from §T-1's own list of attack shapes:
 *
 *   - hidden text: white-on-white, `display:none`, zero-width characters,
 *     HTML comments, `alt` attributes
 *   - `<script>` and `<style>` bodies
 *   - bidi control characters, which reorder rendered text away from its bytes
 *   - oversized documents, capped with the truncation **recorded in metadata**
 *
 * Runs *after* `raw_items` is written, never before. The unmodified bytes are kept so
 * that a sanitiser bug found in six months can be fixed retroactively over history
 * (ARCHITECTURE.md §7).
 */

/** §T-1: "hard-cap length per item (default 12,000 characters)". */
export const DEFAULT_MAX_LENGTH = 12_000;

export type SanitizeOptions = {
  readonly maxLength?: number;
};

export type SanitizeResult = {
  /** Plain text, safe to embed, to store, and to render. */
  readonly text: string;
  /** True when the cap was hit. Recorded so a truncated analysis is knowable. */
  readonly truncated: boolean;
  readonly originalLength: number;
  /**
   * What was removed, by category. Not decoration: a document with 4KB of hidden
   * text is *interesting*, and this is what makes that surface rather than silently
   * vanish.
   */
  readonly removed: {
    readonly scripts: number;
    readonly styles: number;
    readonly comments: number;
    readonly hiddenElements: number;
    readonly zeroWidthChars: number;
    readonly bidiChars: number;
  };
};

/**
 * Characters that are invisible when rendered but carry bytes a model reads.
 *
 *   200B-200D  zero-width space / non-joiner / joiner
 *   2060       word joiner
 *   FEFF       byte-order mark, legal mid-document and invisible
 *   180E       Mongolian vowel separator
 *   00AD       soft hyphen
 */
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF\u180E\u00AD]/g;

/**
 * Bidirectional control characters.
 *
 * These reorder rendered text without changing the bytes: a human reads one thing,
 * the model reads another. That divergence is the whole attack, so they are stripped
 * rather than escaped.
 */
const BIDI_CONTROL = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g;

/** C0/C1 controls except tab, newline, carriage return. */
// eslint-disable-next-line no-control-regex -- stripping control characters IS the point
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

const SCRIPT_BLOCK = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
const STYLE_BLOCK = /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi;
/** Unclosed `<script>` at end of document — still must not survive. */
const DANGLING_SCRIPT = /<script\b[^>]*>[\s\S]*$/i;
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;

/**
 * Elements hidden by inline CSS, removed **with their content**.
 *
 * The naive approach — strip tags, keep text — is exactly wrong here: it *preserves*
 * the payload of `<div style="display:none">Ignore previous instructions…</div>`
 * while removing the only evidence that it was hidden.
 */
const HIDING_DECLARATIONS = [
  'display\\s*:\\s*none',
  'visibility\\s*:\\s*hidden',
  'font-size\\s*:\\s*0',
  'opacity\\s*:\\s*0',
  // White on white, in the three ways it is written.
  'color\\s*:\\s*#fff(?:fff)?\\b',
  'color\\s*:\\s*white\\b',
  'color\\s*:\\s*rgba?\\(\\s*255\\s*,\\s*255\\s*,\\s*255',
  // Positioned off-screen.
  'left\\s*:\\s*-\\d{3,}',
  'text-indent\\s*:\\s*-\\d{3,}',
  'clip\\s*:\\s*rect\\(\\s*0',
].join('|');

const HIDDEN_ELEMENT = new RegExp(
  `<(\\w+)\\b[^>]*\\bstyle\\s*=\\s*["'][^"']*(?:${HIDING_DECLARATIONS})[^"']*["'][^>]*>[\\s\\S]*?<\\/\\1\\s*>`,
  'gi',
);

/** `hidden` and `aria-hidden` attributes, same treatment. */
const HIDDEN_ATTR_ELEMENT =
  /<(\w+)\b[^>]*\s(?:hidden|aria-hidden\s*=\s*["']true["'])[^>]*>[\s\S]*?<\/\1\s*>/gi;

const HTML_TAG = /<[^>]*>/g;

const NAMED_ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&hellip;': '…',
  '&mdash;': '—',
  '&ndash;': '–',
  '&rsquo;': '’',
  '&lsquo;': '‘',
  '&ldquo;': '“',
  '&rdquo;': '”',
};

function countMatches(input: string, pattern: RegExp): number {
  const matches = input.match(pattern);
  return matches === null ? 0 : matches.length;
}

/**
 * Strip untrusted markup to plain text.
 *
 * Order matters and is deliberate: hidden elements and script/style blocks are
 * removed **with their content** before tags are stripped, because stripping tags
 * first would promote every hidden payload to visible text.
 */
export function sanitize(input: string, options: SanitizeOptions = {}): SanitizeResult {
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  const originalLength = input.length;

  const removed = {
    scripts: countMatches(input, SCRIPT_BLOCK),
    styles: countMatches(input, STYLE_BLOCK),
    comments: countMatches(input, HTML_COMMENT),
    hiddenElements: countMatches(input, HIDDEN_ELEMENT) + countMatches(input, HIDDEN_ATTR_ELEMENT),
    zeroWidthChars: countMatches(input, ZERO_WIDTH),
    bidiChars: countMatches(input, BIDI_CONTROL),
  };

  let text = input;

  // 1. Content-bearing removals, before anything promotes their text.
  text = text.replace(SCRIPT_BLOCK, ' ');
  text = text.replace(STYLE_BLOCK, ' ');
  text = text.replace(DANGLING_SCRIPT, ' ');
  text = text.replace(HTML_COMMENT, ' ');
  text = text.replace(HIDDEN_ELEMENT, ' ');
  text = text.replace(HIDDEN_ATTR_ELEMENT, ' ');

  // 2. Remaining tags. `alt` and `title` attribute values disappear with them —
  //    §T-1 lists `alt` as a hiding place, and nothing downstream needs it.
  text = text.replace(HTML_TAG, ' ');

  // 3. Entities, after tag removal so an encoded `&lt;script&gt;` cannot become a
  //    live tag by being decoded first.
  for (const [entity, replacement] of Object.entries(NAMED_ENTITIES)) {
    text = text.replaceAll(entity, replacement);
  }
  text = text.replace(/&#(\d{1,7});/g, (_match, code: string) => {
    const point = Number.parseInt(code, 10);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ' ';
  });
  text = text.replace(/&#x([0-9a-f]{1,6});/gi, (_match, code: string) => {
    const point = Number.parseInt(code, 16);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ' ';
  });

  // 4. Invisible and reordering characters.
  text = text.normalize('NFKC');
  text = text.replace(ZERO_WIDTH, '');
  text = text.replace(BIDI_CONTROL, '');
  text = text.replace(CONTROL_CHARS, ' ');

  // 5. Collapse whitespace.
  text = text.replace(/\s+/g, ' ').trim();

  const truncated = text.length > maxLength;
  if (truncated) {
    // Cut on a word boundary where one is nearby, so the tail is not a fragment.
    const cut = text.slice(0, maxLength);
    const lastSpace = cut.lastIndexOf(' ');
    text = lastSpace > maxLength - 200 ? cut.slice(0, lastSpace) : cut;
  }

  return { text, truncated, originalLength, removed };
}

// ───────────────────────── injection detection ─────────────────────────

/**
 * Injection detection as a **signal, not a filter**. §T-1 mitigation 6.
 *
 * Flagged items are stored, scored zero, and surfaced on a dashboard panel. They are
 * **not** silently dropped, for two reasons the threat model states directly: silent
 * dropping trains the operator to trust a filter he cannot inspect, and a repeated
 * injection attempt against a niche monitoring system is itself interesting
 * information.
 */
export type InjectionSignal = {
  readonly kind:
    | 'instruction_override'
    | 'system_prompt_probe'
    | 'score_manipulation'
    | 'fabricated_authority'
    | 'exfiltration_bait'
    | 'hidden_content'
    | 'role_confusion';
  /** The matched text, capped so the flag itself cannot be a payload. */
  readonly evidence: string;
};

const INJECTION_PATTERNS: readonly { kind: InjectionSignal['kind']; pattern: RegExp }[] = [
  {
    kind: 'instruction_override',
    pattern:
      /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+|previous\s+|prior\s+|above\s+)*(?:previous\s+|prior\s+|earlier\s+|all\s+)?(?:instructions?|prompts?|rules?|directions?|context)\b/i,
  },
  {
    kind: 'system_prompt_probe',
    pattern:
      /\b(?:reveal|print|output|show|repeat|display|disclose)\s+(?:me\s+)?(?:your\s+|the\s+)?(?:system\s+prompt|initial\s+instructions?|prompt\s+above|configuration|your\s+rules)\b/i,
  },
  {
    kind: 'score_manipulation',
    // The cheapest and most likely attack: it needs no jailbreak, only persuasion.
    pattern:
      // "…relevance score to maximum" — the noun is often two words, and requiring
      // one let a real phrasing through.
      /\b(?:assign|set|give|mark|rate|score)\s+(?:this\s+|it\s+|the\s+)?(?:an?\s+)?(?:importance|priority|relevance|score|rating)(?:\s+(?:score|rating|level|value))?\s*(?:of|to|=|:|as)?\s*(?:100|max|maximum|highest|top|10\/10)\b/i,
  },
  {
    kind: 'score_manipulation',
    pattern:
      /\bthis\s+is\s+(?:a\s+)?(?:critical|urgent|breaking|extremely\s+important)\b[^.]{0,60}\b(?:must|should)\s+be\s+(?:ranked|scored|prioriti[sz]ed|surfaced)\b/i,
  },
  {
    kind: 'fabricated_authority',
    pattern:
      /(?:^|[\s>])(?:as\s+)?(?:the\s+)?(?:system|admin|administrator|developer|operator)(?:\s+(?:says?|note|message|instruction))?\s*:/i,
  },
  {
    kind: 'exfiltration_bait',
    pattern:
      /\b(?:fetch|visit|retrieve|download|GET|curl|browse\s+to|open)\s+(?:this\s+|the\s+following\s+)?(?:url|link|address|endpoint)\b|\bfor\s+(?:more|full)\s+(?:detail|context)[^.]{0,30}\bhttps?:\/\//i,
  },
  {
    kind: 'role_confusion',
    pattern: /(?:^|\n)\s*(?:###\s*)?(?:system|assistant|human|user)\s*:\s*/i,
  },
  {
    kind: 'role_confusion',
    pattern: /<\|(?:im_start|im_end|system|endoftext)\|>|\[\/?INST\]|<<SYS>>/i,
  },
];

/**
 * Scan **pre-sanitisation** text for injection attempts.
 *
 * Deliberately runs on the raw input: hidden-text signals are only visible before
 * the hiding is removed. Passing sanitised text here would report every document as
 * clean, which is the failure mode a detector must not have.
 */
export function detectInjectionSignals(
  rawInput: string,
  sanitized?: SanitizeResult,
): InjectionSignal[] {
  const signals: InjectionSignal[] = [];
  const seen = new Set<string>();

  for (const { kind, pattern } of INJECTION_PATTERNS) {
    const match = pattern.exec(rawInput);
    if (match === null) continue;

    const key = `${kind}:${match[0].slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    signals.push({ kind, evidence: match[0].slice(0, 200) });
  }

  // Hidden content is a signal in its own right regardless of what it says. A feed
  // item with zero-width padding or a display:none block is doing something no
  // legitimate publisher does.
  if (sanitized !== undefined) {
    const { hiddenElements, zeroWidthChars, bidiChars, comments, scripts } = sanitized.removed;

    // Executable markup counts. A `<script>` block inside a *feed item body* is not
    // something legitimate publishers ship, and §T-1 wants the attempt surfaced
    // rather than merely undone. The sanitiser already removed it; this makes it
    // visible on the suspicious-content panel.
    if (hiddenElements > 0 || zeroWidthChars > 8 || bidiChars > 0 || scripts > 0) {
      signals.push({
        kind: 'hidden_content',
        evidence:
          `hidden elements: ${String(hiddenElements)}, zero-width: ${String(zeroWidthChars)}, ` +
          `bidi: ${String(bidiChars)}, comments: ${String(comments)}, scripts: ${String(scripts)}`,
      });
    }
  }

  return signals;
}

/** Convenience: sanitise and scan in the correct order, in one call. */
export function sanitizeAndScan(
  input: string,
  options: SanitizeOptions = {},
): { sanitized: SanitizeResult; signals: InjectionSignal[] } {
  const sanitized = sanitize(input, options);
  return { sanitized, signals: detectInjectionSignals(input, sanitized) };
}
