/**
 * Text normalisation shared by the entity registry and, from Phase 4, the
 * deduplication pipeline.
 *
 * Kept in `shared` rather than `core` because `packages/db` seeds the alias table
 * with the normalised form and must produce byte-identical output to the resolver
 * that later queries it. Two implementations of "lowercase and fold punctuation"
 * that drift apart would fail silently: aliases would simply stop matching.
 */

/**
 * Fold a surface form to its lookup key.
 *
 *   "Claude Opus 5"  → "claudeopus5"
 *   "claude-opus-5"  → "claudeopus5"
 *   "Next.js"        → "nextjs"
 *   "Hugging Face"   → "huggingface"
 *
 * Punctuation and whitespace are removed rather than replaced, so that the many
 * ways a vendor writes the same product name collapse to one key. That is the whole
 * job: `claude-opus-5` and `Claude Opus 5` must be the same event.
 *
 * Unicode is normalised to **NFKD**, which folds compatibility forms (full-width
 * letters) *and* decomposes accented characters into a base letter plus a combining
 * mark. The marks are then stripped, so a name written with diacritics matches one
 * written without.
 *
 * NFKC would be the wrong choice here and quietly so: it composes rather than
 * decomposes, leaving "á" as a single code point that no combining-mark class
 * matches, and the diacritic survives.
 */
export function normalizeAlias(input: string): string {
  return input
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Split text into candidate tokens and n-grams for entity matching.
 *
 * Multi-word aliases ("Hugging Face", "Google DeepMind") cannot be found by
 * single-token scanning, so windows up to `maxGram` words are emitted. The cost is
 * linear in text length and the alternative — substring search per alias — is
 * quadratic in registry size and produces the "hf inside shfted" class of false
 * positive that the case-sensitivity flag exists to prevent.
 */
export function candidateGrams(text: string, maxGram = 3): { raw: string; key: string }[] {
  const words = text.split(/[\s]+/).filter((w) => w.length > 0);
  const out: { raw: string; key: string }[] = [];

  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= maxGram && i + n <= words.length; n++) {
      const raw = words.slice(i, i + n).join(' ');
      const key = normalizeAlias(raw);
      if (key.length > 0) out.push({ raw, key });
    }
  }

  return out;
}
