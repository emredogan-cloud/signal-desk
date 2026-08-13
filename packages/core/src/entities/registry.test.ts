import { describe, it, expect } from 'vitest';
import { normalizeAlias } from '@signal-desk/shared';
import { ENTITY_SEEDS, buildAliasRows } from '@signal-desk/db';
import { EntityRegistry, DuplicateAliasError } from './registry.js';

/**
 * ROADMAP.md Phase 2 TESTS: "Entity alias resolution."
 * ROADMAP.md Phase 2 ACCEPTANCE: "Entity registry resolves the alias set for the
 * top 15 entities."
 */

function realRegistry(): EntityRegistry {
  return new EntityRegistry(
    ENTITY_SEEDS.map((e) => ({
      id: e.id,
      name: e.name,
      operatorRelevance: e.operatorRelevance,
    })),
    buildAliasRows(),
  );
}

describe('EntityRegistry — the seeded registry', () => {
  const registry = realRegistry();

  it('loads every seeded entity', () => {
    expect(registry.size).toBe(ENTITY_SEEDS.length);
    expect(registry.size).toBeGreaterThanOrEqual(15);
  });

  it.each([
    ['Anthropic', 'anthropic'],
    ['Claude', 'anthropic'],
    ['claude-opus-5', 'anthropic'],
    ['Claude Opus 5', 'anthropic'],
    ['CLAUDE', 'anthropic'],
    ['Claude Code', 'anthropic'],
    ['OpenAI', 'openai'],
    ['ChatGPT', 'openai'],
    ['gpt-5', 'openai'],
    ['Gemini', 'google-deepmind'],
    ['DeepMind', 'google-deepmind'],
    ['Google DeepMind', 'google-deepmind'],
    ['Google', 'google'],
    ['NVIDIA', 'nvidia'],
    ['CUDA', 'nvidia'],
    ['Hugging Face', 'huggingface'],
    ['HuggingFace', 'huggingface'],
    ['huggingface', 'huggingface'],
    ['Qwen', 'alibaba'],
    ['DeepSeek', 'deepseek'],
    ['Mistral', 'mistral'],
    ['Grok', 'xai'],
    ['x-algorithm', 'xai'],
    ['Next.js', 'vercel'],
    ['NextJS', 'vercel'],
    ['nextjs', 'vercel'],
    ['Supabase', 'supabase'],
    ['Flutter', 'flutter'],
    ['Dart', 'flutter'],
    ['Cloudflare', 'cloudflare'],
    ['Llama', 'meta'],
    ['Azure', 'microsoft'],
  ])('resolves %s → %s', (surfaceForm, expected) => {
    expect(registry.lookup(surfaceForm)).toBe(expected);
  });

  it('collapses the many spellings of one model to one entity', () => {
    // ROADMAP.md Phase 2, stated exactly: "so 'Claude', 'Anthropic', and
    // 'claude-opus-5' resolve to one entity".
    const forms = ['Claude', 'Anthropic', 'claude-opus-5', 'Claude Opus', 'CLAUDE OPUS'];
    const resolved = new Set(forms.map((f) => registry.lookup(f)));
    expect(resolved).toEqual(new Set(['anthropic']));
  });

  it('returns undefined for an unknown name', () => {
    expect(registry.lookup('Some Company That Does Not Exist')).toBeUndefined();
    expect(registry.lookup('')).toBeUndefined();
  });
});

describe('EntityRegistry — extraction from text', () => {
  const registry = realRegistry();

  it('finds entities mentioned in a headline', () => {
    const ids = registry.extractIds('Anthropic ships claude-opus-5 with a larger context window');
    expect(ids).toContain('anthropic');
  });

  it('prefers the longest alias at a position', () => {
    // "Google DeepMind" must not resolve to `google` plus a stray token, or every
    // DeepMind announcement is also attributed to Google and the two stop being
    // distinguishable in the event stream.
    const matches = registry.extract('Google DeepMind announced a new model today');
    expect(matches.map((m) => m.entityId)).toContain('google-deepmind');
    expect(matches.find((m) => m.entityId === 'google-deepmind')?.matchedText).toBe(
      'Google DeepMind',
    );
  });

  it('counts a repeated mention once', () => {
    const ids = registry.extractIds('Claude, Claude, Claude — Anthropic says Claude again');
    expect(ids.filter((id) => id === 'anthropic')).toHaveLength(1);
  });

  it('finds several entities in one sentence', () => {
    const ids = registry.extractIds('NVIDIA and Supabase both shipped, and so did Vercel');
    expect(ids).toEqual(expect.arrayContaining(['nvidia', 'supabase', 'vercel']));
  });

  it('orders results by relevance to the operator', () => {
    const ids = registry.extractIds('Apple, Supabase, and Microsoft all announced something');
    expect(ids[0]).toBe('supabase');
  });

  it('does not fire on a bare "X"', () => {
    const ids = registry.extractIds('The value of X increased when we set X to 5');
    expect(ids).not.toContain('xai');
  });

  it('ignores a case-sensitive alias in the wrong case', () => {
    // "hf" lowercase inside prose is not Hugging Face.
    expect(registry.lookup('hf')).toBeUndefined();
    expect(registry.lookup('HF')).toBe('huggingface');
    expect(registry.extractIds('we hf the value before storing it')).not.toContain('huggingface');
    expect(registry.extractIds('published on HF this morning')).toContain('huggingface');
  });

  it('handles empty and whitespace-only input', () => {
    expect(registry.extractIds('')).toEqual([]);
    expect(registry.extractIds('   \n  ')).toEqual([]);
  });

  it('is not confused by punctuation around a name', () => {
    expect(registry.extractIds('(Anthropic) — "Claude Code" v2.0!')).toContain('anthropic');
  });
});

describe('EntityRegistry — construction', () => {
  it('rejects an alias claimed by two entities', () => {
    expect(
      () =>
        new EntityRegistry(
          [
            { id: 'a', name: 'A', operatorRelevance: 0.5 },
            { id: 'b', name: 'B', operatorRelevance: 0.5 },
          ],
          [
            { entityId: 'a', alias: 'Gemini', normalized: 'gemini', requiresExactCase: false },
            { entityId: 'b', alias: 'gemini', normalized: 'gemini', requiresExactCase: false },
          ],
        ),
    ).toThrow(DuplicateAliasError);
  });

  it('accepts the same alias listed twice for one entity', () => {
    expect(
      () =>
        new EntityRegistry(
          [{ id: 'a', name: 'A', operatorRelevance: 0.5 }],
          [
            { entityId: 'a', alias: 'Next.js', normalized: 'nextjs', requiresExactCase: false },
            { entityId: 'a', alias: 'NextJS', normalized: 'nextjs', requiresExactCase: false },
          ],
        ),
    ).not.toThrow();
  });

  it('is empty-safe', () => {
    const registry = new EntityRegistry([], []);
    expect(registry.size).toBe(0);
    expect(registry.extractIds('Anthropic shipped something')).toEqual([]);
  });
});

describe('normalizeAlias', () => {
  it.each([
    ['Claude Opus 5', 'claudeopus5'],
    ['claude-opus-5', 'claudeopus5'],
    ['Next.js', 'nextjs'],
    ['Hugging Face', 'huggingface'],
    ['  NVIDIA  ', 'nvidia'],
    ['GPT-4', 'gpt4'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeAlias(input)).toBe(expected);
  });

  it('folds diacritics so a name written either way matches', () => {
    expect(normalizeAlias('Mistral')).toBe(normalizeAlias('Mistrál'));
  });

  it('folds full-width characters', () => {
    expect(normalizeAlias('ＯｐｅｎＡＩ')).toBe('openai');
  });

  it('returns an empty string for punctuation-only input', () => {
    expect(normalizeAlias('--- !!! ---')).toBe('');
  });
});
