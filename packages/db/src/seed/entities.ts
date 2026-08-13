import type { EntityKind } from '@signal-desk/shared';

/**
 * The entity registry. ROADMAP.md Phase 2:
 *
 *   "canonical entities (anthropic, openai, nvidia, …) with aliases, so 'Claude',
 *    'Anthropic', and 'claude-opus-5' resolve to one entity"
 *
 * Entities are organisations and projects. Models and products are **aliases**, not
 * entities: the question downstream is "is this the same event", and "Anthropic
 * shipped Opus 5" and "claude-opus-5 is out" are the same event.
 *
 * `operatorRelevance` is a starting guess in every row, refitted in Phase 12 against
 * measured outcomes. The ordering it encodes is the only claim being made: the
 * operator's own stack (Flutter/Dart, Supabase, TypeScript, Anthropic tooling) is
 * where he can *test* something and therefore say something non-obvious, which is
 * what `ROADMAP.md` §7 means by brand relevance.
 */

export type EntitySeed = {
  readonly id: string;
  readonly name: string;
  readonly kind: EntityKind;
  readonly operatorRelevance: number;
  readonly aliases: readonly string[];
  /**
   * Aliases too short to be safe as substrings — "HF", "GPT". These match only on a
   * whole-token boundary with their original casing. Without the restriction, "hf"
   * matches inside ordinary words and every typo becomes a Hugging Face event.
   */
  readonly caseSensitiveAliases?: readonly string[];
};

export const ENTITY_SEEDS: readonly EntitySeed[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'org',
    operatorRelevance: 1.0,
    aliases: [
      'Anthropic',
      'Claude',
      'Claude Code',
      'Claude Opus',
      'Claude Sonnet',
      'Claude Haiku',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-haiku-4-5',
      'Anthropic API',
      'Model Context Protocol',
    ],
    caseSensitiveAliases: ['MCP'],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'org',
    operatorRelevance: 0.85,
    aliases: ['OpenAI', 'ChatGPT', 'OpenAI Codex', 'Sora', 'DALL-E', 'gpt-5', 'gpt-4'],
    caseSensitiveAliases: ['GPT'],
  },
  {
    id: 'google-deepmind',
    name: 'Google DeepMind',
    kind: 'org',
    operatorRelevance: 0.8,
    aliases: ['Google DeepMind', 'DeepMind', 'Gemini', 'AlphaFold'],
    // Three letters, and a common word in several languages.
    caseSensitiveAliases: ['Veo'],
  },
  {
    id: 'google',
    name: 'Google',
    kind: 'org',
    operatorRelevance: 0.7,
    aliases: ['Google', 'Alphabet', 'Google Cloud', 'Vertex AI', 'Google Research'],
    caseSensitiveAliases: ['GCP'],
  },
  {
    id: 'meta',
    name: 'Meta',
    kind: 'org',
    operatorRelevance: 0.6,
    aliases: ['Meta AI', 'Llama', 'Facebook', 'PyTorch'],
  },
  {
    id: 'microsoft',
    name: 'Microsoft',
    kind: 'org',
    operatorRelevance: 0.6,
    aliases: ['Microsoft', 'Azure', 'Azure OpenAI', 'GitHub Copilot', 'Copilot', 'VS Code'],
  },
  {
    id: 'nvidia',
    name: 'NVIDIA',
    kind: 'org',
    operatorRelevance: 0.65,
    aliases: ['NVIDIA', 'CUDA', 'Blackwell', 'GeForce', 'TensorRT'],
  },
  {
    id: 'amazon',
    name: 'Amazon',
    kind: 'org',
    operatorRelevance: 0.55,
    aliases: ['Amazon Web Services', 'Amazon Bedrock', 'Bedrock', 'Trainium'],
    caseSensitiveAliases: ['AWS'],
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    kind: 'org',
    operatorRelevance: 0.6,
    aliases: ['Mistral AI', 'Mistral', 'Mixtral', 'Le Chat'],
  },
  {
    id: 'alibaba',
    name: 'Alibaba',
    kind: 'org',
    operatorRelevance: 0.6,
    aliases: ['Alibaba', 'Qwen', 'QwenLM', 'Tongyi'],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'org',
    operatorRelevance: 0.65,
    aliases: ['DeepSeek'],
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    kind: 'org',
    operatorRelevance: 0.75,
    aliases: ['Hugging Face', 'HuggingFace'],
    caseSensitiveAliases: ['HF'],
  },
  {
    id: 'xai',
    name: 'xAI',
    kind: 'org',
    operatorRelevance: 0.8,
    // Deliberately no bare "X" alias. "X" appears in ordinary prose constantly, and
    // an entity resolver that fires on it would attach half the corpus to xAI.
    // The X *platform* is reached through "x-algorithm" and "For You" instead.
    aliases: ['Grok', 'x-algorithm', 'X algorithm', 'For You ranker'],
    // Three letters. The brand is always written with this exact casing, and
    // "xai" folded case-insensitively is three characters of noise.
    caseSensitiveAliases: ['xAI'],
  },
  {
    id: 'apple',
    name: 'Apple',
    kind: 'org',
    operatorRelevance: 0.5,
    aliases: ['Apple Intelligence', 'Apple Silicon', 'Siri'],
  },
  {
    id: 'vercel',
    name: 'Vercel',
    kind: 'org',
    operatorRelevance: 0.85,
    aliases: ['Vercel', 'Next.js', 'NextJS', 'Turbopack', 'AI SDK'],
  },
  {
    id: 'supabase',
    name: 'Supabase',
    kind: 'org',
    operatorRelevance: 0.9,
    aliases: ['Supabase', 'Supabase Edge Functions'],
  },
  {
    id: 'github',
    name: 'GitHub',
    kind: 'org',
    operatorRelevance: 0.7,
    aliases: ['GitHub', 'GitHub Actions'],
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    kind: 'org',
    operatorRelevance: 0.6,
    aliases: ['Cloudflare', 'Cloudflare Workers', 'Workers AI', 'Cloudflare R2'],
  },
  {
    id: 'flutter',
    name: 'Flutter',
    kind: 'project',
    operatorRelevance: 0.9,
    aliases: ['Flutter', 'Dart'],
  },
];
