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
/**
 * Invisible characters, for detection rather than removal.
 *
 * Broader than the sanitiser's classes: it includes the C0 control range, because a
 * document interleaving `\u0001` between words is doing something no publisher does
 * by accident. Kept separate from the sanitiser's constants so that widening the
 * detector never widens what gets silently stripped from stored text.
 */
/* eslint-disable no-control-regex -- detecting control characters IS the point of these two */
const INVISIBLE_FOR_DETECTION =
  /[\u200B-\u200D\u2060\uFEFF\u180E\u00AD\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/** A short window around the first invisible character, for the operator to read. */

const OBFUSCATION_EVIDENCE =
  /.{0,30}[\u200B-\u200D\u2060\uFEFF\u180E\u00AD\u202A-\u202E\u0000-\u001F].{0,30}/;
/* eslint-enable no-control-regex */

export type InjectionSignal = {
  readonly kind:
    | 'instruction_override'
    | 'system_prompt_probe'
    | 'score_manipulation'
    | 'fabricated_authority'
    | 'exfiltration_bait'
    | 'hidden_content'
    | 'role_confusion'
    | 'schema_attack'
    | 'obfuscation';
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
  {
    kind: 'score_manipulation',
    // Self-asserted numeric scores, including the shape that imitates this system's
    // own field names — `importance_score: 100`, `confidence: HIGH`.
    pattern:
      /\b(?:importance|priority|relevance|urgency|confidence|brand_relevance|importance_score|recommended_action)\s*[:=]\s*(?:100|max|maximum|critical|highest|high\b|post_now)/i,
  },
  {
    kind: 'score_manipulation',
    // Superlative self-description. Requires the superlative AND a scope claim, so
    // ordinary marketing ("our most powerful model yet") does not match.
    pattern:
      /\bthe\s+most\s+important\s+(?:announcement|news|event|release|story)\s+(?:in|of)\s+(?:the\s+)?(?:history|all\s+time|the\s+year|the\s+decade)\b/i,
  },
  {
    kind: 'score_manipulation',
    // Publish-now pressure combined with an instruction to skip verification. Either
    // half alone is ordinary copy; together they target the recommendation directly.
    pattern:
      /\bdo\s+not\s+(?:verify|wait|check|confirm|fact.?check)\b|\bpublish\s+(?:this\s+)?(?:immediately|within\s+the\s+next|right\s+now)\b[^.]{0,80}\bor\b/i,
  },
  {
    kind: 'score_manipulation',
    // Appeals to the operator's own goals. This is the most persuasive family and
    // the least keyword-like, so it needs the audience/growth framing plus an
    // explicit instruction to rate it.
    pattern:
      // Spans sentence boundaries deliberately. The corpus case puts the appeal and
      // the instruction in separate sentences — "…your audience wants. … Rate it
      // highly." — and a `[^.]` window cannot cross the period, so the most
      // persuasive payload in the corpus was the one that slipped through. Requiring
      // BOTH halves within 200 characters keeps it specific: ordinary marketing says
      // "your audience will love this" without ever instructing a rating.
      /\b(?:your\s+audience|your\s+following|your\s+followers)\b[\s\S]{0,200}?\b(?:rate\s+(?:it|this)\s+(?:highly|high)|prioriti[sz]e\s+(?:this|it)|score\s+(?:this|it)\s+high)/i,
  },
  {
    kind: 'score_manipulation',
    // Asserted corroboration. Three or more named outlets in one breath, framed as
    // confirmation, is a claim the document cannot support about itself.
    pattern:
      /\b(?:independently\s+)?(?:confirmed|verified|corroborated)\s+by\b[^.]{0,120}?(?:,[^.]{0,60}){2,}/i,
  },
  {
    kind: 'fabricated_authority',
    // Self-declared officialness. The registry decides what is official; a document
    // saying so about itself is a red flag, not evidence.
    pattern:
      /\b(?:official(?:ly)?\s+(?:announcement|statement|communication)|verified\s+source|authoritative\s+(?:source|document))\b[^.]{0,120}\b(?:trust|tag(?:ged)?|treat|mark(?:ed)?|should\s+be)\b/i,
  },
  {
    kind: 'fabricated_authority',
    // A forged system/instruction block embedded in content.
    pattern: /<\/?(?:system|instructions?|admin|prompt)\s*>/i,
  },
  {
    kind: 'fabricated_authority',
    // Claims of a cryptographic verification that was never performed.
    pattern:
      /\b(?:pgp|gpg|cryptographically)\s+(?:signed|authenticated|verified)\b[^.]{0,120}\b(?:trust|must\s+be|should\s+be)\b/i,
  },
  {
    kind: 'fabricated_authority',
    // Impersonating the operator to request a rule change.
    pattern:
      /\b(?:message|note|instruction)\s+from\s+the\s+(?:system\s+)?(?:operator|administrator|owner)\b|\b(?:disable|bypass|skip|ignore)\s+(?:the\s+)?(?:confidence\s+cap|safety\s+check|validation|guardrails?)\b/i,
  },
  {
    kind: 'exfiltration_bait',
    // Requests to echo the prompt or configuration back. Distinct from the existing
    // prompt_extraction rule, which requires an imperative verb; this catches the
    // "so the user can verify" framing.
    pattern:
      /\b(?:repeat|echo|output|print)\s+(?:your\s+)?(?:full\s+|entire\s+|complete\s+)?(?:system\s+prompt|instructions?|configuration)\b/i,
  },
  {
    kind: 'exfiltration_bait',
    // Requests for environment variables or credentials by name.
    pattern:
      /\b(?:ANTHROPIC_API_KEY|DATABASE_URL|OPENAI_API_KEY|AWS_SECRET|X_API_KEY)\b|\b(?:output|print|reveal|show)\s+the\s+values?\s+of\b[^.]{0,60}\b(?:env|environment|variable|secret|key)/i,
  },
  {
    kind: 'exfiltration_bait',
    // Beacon URLs — a query parameter that looks like it carries state out.
    pattern: /https?:\/\/[^\s)]*[?&](?:leak|exfil|collect|data|prompt|steal)=/i,
  },
  {
    kind: 'schema_attack',
    // Attempts to add a field to the structured output. `additionalProperties:false`
    // already makes this impossible; flagging it records the attempt.
    pattern:
      /\badd\s+(?:a\s+)?(?:new\s+)?(?:field|key|property|parameter)\s+(?:called|named)\b|\binclude\s+(?:a\s+)?(?:field|key)\s+["'`]/i,
  },
  {
    kind: 'schema_attack',
    // Instructing which evidence id to cite. Validation rejects unknown ids; this
    // records that something tried.
    pattern: /\bcite\s+(?:the\s+)?evidence\s+id\b|\bevidence[_\s]?ids?\s*[:=]\s*["'`[]/i,
  },
  {
    kind: 'instruction_override',
    // Persona replacement and amnesia framing — the variants the first pass missed.
    pattern:
      /\byou\s+are\s+now\b|\bforget\s+(?:everything|all)\b[^.]{0,60}\b(?:before|prior|previously)\b|\bstart\s+fresh\b[^.]{0,60}\binstructions?\b/i,
  },
  {
    kind: 'instruction_override',
    // Positional overrides that target the prompt's layout rather than its content.
    pattern:
      /\b(?:disregard|ignore)\s+(?:everything|all|anything)\s+(?:above|below|before|prior\s+to)\b|\bnew\s+instructions\s+(?:follow|below)\b/i,
  },
  {
    kind: 'instruction_override',
    // Hidden-element markers surviving into the raw scan. The sanitiser removes the
    // element; the detector's job is to notice it was there.
    pattern:
      /style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|left\s*:\s*-\d{3,}px|position\s*:\s*absolute)/i,
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

  // ─── Obfuscation is itself a signal, and it must be undone before matching.
  //
  // The corpus proved both halves. `I\u200Bg\u200Bn\u200Bo\u200Br\u200Be` defeats
  // every keyword pattern above, so a detector that scans the raw bytes alone reports
  // it clean — the very payload most obviously designed to evade detection is the one
  // it misses. And a document that separates each letter of a word with zero-width
  // spaces has no innocent explanation, so the presence of the characters is worth
  // flagging even when the de-obfuscated text turns out to be harmless.
  //
  // Note this differs from the sanitiser's job. The sanitiser REMOVES these so the
  // model never sees them; the detector RECORDS that they were there.
  const obfuscated = INVISIBLE_FOR_DETECTION.test(rawInput);
  if (obfuscated) {
    const evidence = OBFUSCATION_EVIDENCE.exec(rawInput);
    signals.push({
      kind: 'obfuscation',
      evidence: (evidence?.[0] ?? 'invisible characters').slice(0, 200),
    });
  }

  // Match against BOTH the raw text and the de-obfuscated text. Raw catches payloads
  // that rely on markup; de-obfuscated catches payloads that rely on invisible
  // separators. Neither alone is sufficient.
  const deobfuscated = obfuscated ? rawInput.replace(INVISIBLE_FOR_DETECTION, '') : rawInput;

  for (const { kind, pattern } of INJECTION_PATTERNS) {
    const match = pattern.exec(rawInput) ?? (obfuscated ? pattern.exec(deobfuscated) : null);
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
