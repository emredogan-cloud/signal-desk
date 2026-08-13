/**
 * Artifact extraction — model names, version strings, product names — **by rule**.
 *
 * ROADMAP.md Phase 4 is explicit that this is rule-based, and that matters for two
 * reasons beyond cost. It runs before the rule gate, so it must be free; and it is
 * an input to *deduplication*, so it must be deterministic — the same item extracted
 * twice must produce the same artifacts, or replaying history produces different
 * clusters than the live run did.
 *
 * Artifacts are the load-bearing signal in dedup stage 2: six outlets writing about
 * one launch will disagree about almost every word except the version string.
 */

export type Artifacts = {
  /** Model identifiers: `claude-opus-5`, `gpt-5`, `Llama 4`, `Qwen3-72B`. */
  readonly models: readonly string[];
  /** Version strings: `v18.3.0`, `2024.1`, `b10405`. */
  readonly versions: readonly string[];
  /** `owner/repo` references. */
  readonly repos: readonly string[];
  /**
   * The subset that appeared in the **title**.
   *
   * **MEASURED CORRECTION, found on 5,208 real items.** An artifact in a title is an
   * identity claim; an artifact in a body is a mention. Five unrelated arXiv papers
   * merged into one event because each abstract happened to say "gpt-4o" — they all
   * *evaluated* the model, none of them *was* the model's release. Stage-2 identity
   * now requires the artifact to be in the title, which is where a launch names the
   * thing it is launching.
   */
  readonly titleModels: readonly string[];
  readonly titleVersions: readonly string[];
};

export const EMPTY_ARTIFACTS: Artifacts = {
  models: [],
  versions: [],
  repos: [],
  titleModels: [],
  titleVersions: [],
};

/**
 * Vendor-shaped model identifiers.
 *
 * Deliberately anchored on known vendor prefixes rather than a general
 * "word-number-number" pattern. The general form matches dates, prices, and product
 * SKUs, and a false artifact is worse than a missing one here: stage-2 dedup merges
 * on a shared artifact, so a spurious match merges two unrelated events into one and
 * *hides* the second.
 */
const MODEL_PATTERNS: readonly RegExp[] = [
  // claude-opus-5, claude-3-5-sonnet-20241022, claude-haiku-4-5
  /\bclaude-[a-z0-9]+(?:-[a-z0-9]+)*\b/gi,
  // gpt-5, gpt-4o, gpt-4-turbo
  /\bgpt-[0-9][a-z0-9]*(?:-[a-z0-9]+)*\b/gi,
  // o1, o3-mini — OpenAI's reasoning line. Bounded to avoid matching "o3" in prose.
  /\bo[1-9]-(?:mini|preview|pro)\b/gi,
  // gemini-2.5-pro, gemini-1.5-flash
  /\bgemini-[0-9][a-z0-9.]*(?:-[a-z]+)*\b/gi,
  // llama-4, llama3.1, Llama 4 Scout
  /\bllama[-\s]?[0-9](?:\.[0-9]+)?(?:[-\s][a-z]+)?\b/gi,
  // mistral-large-2, mixtral-8x7b
  /\b(?:mistral|mixtral|codestral)-[a-z0-9]+(?:[-x][a-z0-9]+)*\b/gi,
  // qwen3-72b, qwen2.5-coder
  /\bqwen[0-9](?:\.[0-9]+)?(?:-[a-z0-9]+)*\b/gi,
  // deepseek-v3, deepseek-r1
  /\bdeepseek-[a-z][0-9]?(?:-[a-z0-9]+)*\b/gi,
  // grok-3, grok-2-vision
  /\bgrok-[0-9](?:-[a-z]+)*\b/gi,
  // phi-4, gemma-3, command-r-plus
  /\b(?:phi|gemma)-[0-9](?:\.[0-9]+)?(?:-[a-z]+)*\b/gi,
];

/**
 * Version strings, requiring a `v` prefix, two dots, or a build-tag shape.
 *
 * `16.3` alone is not enough — it matches prices, ratios, and dates. `v16.3` or
 * `16.3.0` carries enough confidence to merge on.
 *
 * **MEASURED ADDITION.** `\bb\d{4,}\b` catches GitHub build tags. Without it,
 * `llama.cpp b10400` and `b10405` extracted *no artifacts at all*, so nothing
 * distinguished them — and two consecutive releases embedded at cosine 0.9649 and
 * merged into one event, hiding a release. This pattern is the whole reason that
 * case now fails to merge.
 */
const VERSION_PATTERN =
  /\bv[0-9]+\.[0-9]+(?:\.[0-9]+)?(?:-[a-z0-9.]+)?\b|\b[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.]+)?\b|\bb[0-9]{4,}\b/gi;

/** `owner/repo`, as it appears in a GitHub URL or in prose. */
const REPO_PATTERN =
  /\b(?:github\.com\/)?([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9][a-z0-9._-]{0,99})\b/gi;

/**
 * Words that look like `owner/repo` but are not.
 *
 * Without this, "and/or", "input/output", and every date written `08/13` become
 * repository artifacts — and stage-2 dedup then merges every item containing the
 * word "and/or".
 */
const REPO_STOPWORDS = new Set([
  'and',
  'or',
  'input',
  'output',
  'read',
  'write',
  'yes',
  'no',
  'on',
  'off',
  'http',
  'https',
  'am',
  'pm',
  'w',
  'n',
  's',
  'e',
  'a',
  'i',
  'km',
  'kg',
  'ms',
  'gb',
  'tb',
]);

function uniqueLowercase(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase().trim();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out.sort();
}

/**
 * Extract artifacts, distinguishing what the title claims from what the body mentions.
 *
 * `title` is optional so callers that only have one blob still work; when it is
 * given, the title subset is what stage-2 identity uses.
 */
export function extractArtifacts(text: string, title?: string): Artifacts {
  const all = extractRaw(text);
  if (title === undefined) {
    return { ...all, titleModels: all.models, titleVersions: all.versions };
  }

  const inTitle = extractRaw(title);
  return {
    ...all,
    titleModels: inTitle.models,
    titleVersions: inTitle.versions,
  };
}

function extractRaw(text: string): Omit<Artifacts, 'titleModels' | 'titleVersions'> {
  const models: string[] = [];
  for (const pattern of MODEL_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      // Normalise "Llama 4" and "llama-4" to one artifact, or they fail to merge.
      models.push(match[0].replace(/\s+/g, '-'));
    }
  }

  const versions: string[] = [];
  VERSION_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(VERSION_PATTERN)) {
    versions.push(match[0]);
  }

  const repos: string[] = [];
  REPO_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(REPO_PATTERN)) {
    const owner = match[1];
    const repo = match[2];
    if (owner === undefined || repo === undefined) continue;
    if (REPO_STOPWORDS.has(owner.toLowerCase()) || REPO_STOPWORDS.has(repo.toLowerCase())) continue;
    // A repo name is rarely a bare number; a date fragment always is.
    if (/^\d+$/.test(owner) || /^\d+$/.test(repo)) continue;
    repos.push(`${owner}/${repo}`);
  }

  return {
    models: uniqueLowercase(models),
    versions: uniqueLowercase(versions),
    repos: uniqueLowercase(repos),
  };
}

/**
 * Artifacts that IDENTIFY an event — models and versions, never repos.
 *
 * **MEASURED CORRECTION, found on 5,208 real items.** A repository is a *container*,
 * not an event: every `llama.cpp` release shares `repo:ggml-org/llama.cpp`, so
 * treating a repo as an identity artifact made stage 2 merge seven consecutive
 * builds — b10403, b10405, b10408 — into one event, hiding six releases. The same
 * mechanism merged an arXiv paper with a Simon Willison post that happened to
 * mention the same repository.
 *
 * The labelled set did not catch this. Twenty-five curated items cannot exhibit a
 * failure that needs seven releases of one repository inside one window; five
 * thousand real ones do it on the first run. That is what the roadmap's "a week of
 * live data reviewed by eye" exit criterion is for.
 *
 * Repos remain useful — for entity resolution and for display — just not for
 * deciding that two items describe the same event.
 */
export function identityArtifactKeys(artifacts: Artifacts): Set<string> {
  return new Set([
    ...artifacts.titleModels.map((m) => `model:${m}`),
    ...artifacts.titleVersions.map((v) => `version:${v}`),
  ]);
}

/** Every artifact including repos. For display and entity resolution. */
/**
 * Vendor implied by a model artifact.
 *
 * **MEASURED ADDITION.** A model id is the strongest entity signal there is, and the
 * alias resolver cannot see it: "Qwen3.8-27B" is one whitespace token, and it folds
 * to `qwen3827b`, which is nobody's alias. So a vendor blog post and its community
 * thread shared an artifact, shared a subject, and shared *no entity* — and stage 2,
 * which requires both, let them apart.
 */
const MODEL_PREFIX_ENTITY: readonly (readonly [RegExp, string])[] = [
  [/^claude-/, 'anthropic'],
  [/^gpt-/, 'openai'],
  [/^o[1-9]-/, 'openai'],
  [/^gemini-/, 'google-deepmind'],
  [/^llama[-\s]?[0-9]/, 'meta'],
  [/^(?:mistral|mixtral|codestral)-/, 'mistral'],
  [/^qwen[0-9]/, 'alibaba'],
  [/^deepseek-/, 'deepseek'],
  [/^grok-/, 'xai'],
  [/^gemma-/, 'google-deepmind'],
  [/^phi-/, 'microsoft'],
];

/** Entity slugs implied by the model artifacts, deduplicated. */
export function entitiesFromArtifacts(artifacts: Artifacts): string[] {
  const found = new Set<string>();
  for (const model of artifacts.models) {
    for (const [pattern, entity] of MODEL_PREFIX_ENTITY) {
      if (pattern.test(model)) {
        found.add(entity);
        break;
      }
    }
  }
  return [...found];
}

export function artifactKeys(artifacts: Artifacts): Set<string> {
  return new Set([
    ...artifacts.models.map((m) => `model:${m}`),
    ...artifacts.versions.map((v) => `version:${v}`),
    ...artifacts.repos.map((r) => `repo:${r}`),
  ]);
}

/** Stage-2 identity overlap. Repos deliberately excluded — see `identityArtifactKeys`. */
export function hasArtifactOverlap(a: Artifacts, b: Artifacts): boolean {
  const keysA = identityArtifactKeys(a);
  if (keysA.size === 0) return false;
  for (const key of identityArtifactKeys(b)) {
    if (keysA.has(key)) return true;
  }
  return false;
}
