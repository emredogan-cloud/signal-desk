import {
  SOURCE_CATEGORY_RELIABILITY,
  DEFAULT_POLL_INTERVAL_SEC,
  type SourceCategory,
  type SourcePlatform,
  type SourcePriority,
} from '@signal-desk/shared';

/**
 * The source registry. SOURCE-INTELLIGENCE.md is the authority; this file is that
 * document expressed as data.
 *
 * `verifiedAt` is the date the URL last returned a valid feed with a non-zero item
 * count. It is written here from the document's own probe runs and overwritten by
 * `pnpm sources:probe`. A source with `verifiedAt: null` has never been probed and
 * must not be trusted to work — it is a claim, not a measurement.
 */

export type SourceSeed = {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly platform: SourcePlatform;
  readonly category: SourceCategory;
  /** Canonical entity slug, or null for sources that speak for nobody in particular. */
  readonly entity: string | null;
  readonly priority: SourcePriority;
  readonly isOfficial: boolean;
  readonly expectedValue: string;
  /** ISO date of the last successful probe, or null if never probed. */
  readonly verifiedAt: string | null;
  /** Override the priority default. Used where a source asks for slower polling. */
  readonly pollIntervalSec?: number;
  /** Override the category default. Used where a specific source is better or worse
   *  than its category suggests. */
  readonly reliability?: number;
};

const gh = (owner: string, repo: string, branch?: string): string =>
  branch === undefined
    ? `https://github.com/${owner}/${repo}/releases.atom`
    : `https://github.com/${owner}/${repo}/commits/${branch}.atom`;

/** Probe date carried over from SOURCE-INTELLIGENCE.md's own curl runs. */
const DOC = '2026-08-12';

export const SOURCE_SEEDS: readonly SourceSeed[] = [
  // ─────────────────────────────────────────────────────────────────────
  // TIER 1a — AI labs and model vendors. SOURCE-INTELLIGENCE.md §1a.
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'openai-news',
    name: 'OpenAI News',
    url: 'https://openai.com/news/rss.xml',
    platform: 'rss',
    category: 'OFFICIAL_SOURCE',
    entity: 'openai',
    priority: 1,
    isOfficial: true,
    expectedValue: 'Model launches, pricing changes, deprecations. Minutes of latency.',
    verifiedAt: DOC,
  },
  {
    id: 'deepmind-blog',
    name: 'Google DeepMind Blog',
    url: 'https://deepmind.google/blog/rss.xml',
    platform: 'rss',
    category: 'OFFICIAL_SOURCE',
    entity: 'google-deepmind',
    priority: 1,
    isOfficial: true,
    expectedValue: 'Gemini launches and research announcements.',
    verifiedAt: DOC,
  },
  {
    id: 'google-keyword-ai',
    name: 'Google — The Keyword (AI)',
    url: 'https://blog.google/technology/ai/rss/',
    platform: 'rss',
    category: 'OFFICIAL_SOURCE',
    entity: 'google',
    priority: 1,
    isOfficial: true,
    expectedValue: 'Consumer-facing AI announcements.',
    verifiedAt: DOC,
  },
  {
    id: 'google-research-blog',
    name: 'Google Research Blog',
    url: 'https://research.google/blog/rss/',
    platform: 'rss',
    category: 'TECHNICAL_RESEARCHER',
    entity: 'google',
    priority: 2,
    isOfficial: true,
    expectedValue: 'Deeper and less product-shaped than The Keyword.',
    verifiedAt: DOC,
  },
  {
    id: 'huggingface-blog',
    name: 'Hugging Face Blog',
    url: 'https://huggingface.co/blog/feed.xml',
    platform: 'rss',
    category: 'OFFICIAL_SOURCE',
    entity: 'huggingface',
    priority: 2,
    isOfficial: true,
    expectedValue: 'Open-model releases and technique writeups.',
    verifiedAt: DOC,
  },
  {
    id: 'qwen-blog',
    name: 'Qwen (Alibaba)',
    url: 'https://qwenlm.github.io/blog/index.xml',
    platform: 'rss',
    category: 'OFFICIAL_SOURCE',
    entity: 'alibaba',
    priority: 2,
    isOfficial: true,
    expectedValue: 'The most under-covered high-signal lab in Western feeds.',
    verifiedAt: DOC,
  },
  {
    id: 'nvidia-blog',
    name: 'NVIDIA Blog',
    url: 'https://blogs.nvidia.com/feed/',
    platform: 'rss',
    category: 'OFFICIAL_SOURCE',
    entity: 'nvidia',
    priority: 2,
    isOfficial: true,
    expectedValue: 'Hardware, pricing, CUDA ecosystem.',
    verifiedAt: DOC,
  },
  {
    id: 'aws-ml-blog',
    name: 'AWS Machine Learning Blog',
    url: 'https://aws.amazon.com/blogs/machine-learning/feed/',
    platform: 'rss',
    category: 'OFFICIAL_SOURCE',
    entity: 'amazon',
    priority: 3,
    isOfficial: true,
    expectedValue: 'High volume, low density. Requires aggressive filtering.',
    verifiedAt: DOC,
  },
  {
    id: 'azure-blog',
    name: 'Azure Blog',
    url: 'https://azure.microsoft.com/en-us/blog/feed/',
    platform: 'rss',
    category: 'OFFICIAL_SOURCE',
    entity: 'microsoft',
    priority: 3,
    isOfficial: true,
    expectedValue: 'High volume, low density. Requires aggressive filtering.',
    verifiedAt: DOC,
  },

  // ─────────────────────────────────────────────────────────────────────
  // Anthropic — no RSS feed exists. SOURCE-INTELLIGENCE.md §1a, re-verified
  // 2026-08-13. Covered by HTML diffing plus SDK release atoms.
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'anthropic-news-diff',
    name: 'Anthropic News (HTML diff)',
    url: 'https://www.anthropic.com/news',
    platform: 'html_diff',
    category: 'OFFICIAL_SOURCE',
    entity: 'anthropic',
    priority: 1,
    isOfficial: true,
    expectedValue:
      'The highest-relevance vendor, with no feed. Diffed on the set of /news/<slug> links, ' +
      'which are server-rendered. robots.txt allows all (checked 2026-08-13). 15-minute floor.',
    verifiedAt: '2026-08-13',
    pollIntervalSec: 15 * 60,
  },
  {
    id: 'anthropic-release-notes-diff',
    name: 'Anthropic API release notes (HTML diff)',
    url: 'https://platform.claude.com/docs/en/release-notes/overview',
    platform: 'html_diff',
    category: 'OFFICIAL_SOURCE',
    entity: 'anthropic',
    priority: 2,
    isOfficial: true,
    expectedValue:
      'Model IDs and API changes, often before the news post. Registered at its CANONICAL ' +
      'host: docs.claude.com 301s here, and the SSRF allowlist correctly refused to follow a ' +
      'cross-host redirect (found on the first LIVE run, 2026-08-13). 64% of the page is ' +
      'script bundle, so diff extracted text only — raw-byte diffing fires on every deploy. ' +
      '15-minute floor.',
    verifiedAt: '2026-08-13',
    pollIntervalSec: 15 * 60,
  },

  // ─────────────────────────────────────────────────────────────────────
  // TIER 1b — GitHub .atom. No token, no visible quota. §1b.
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'gh-x-algorithm',
    name: 'xai-org/x-algorithm commits',
    url: gh('xai-org', 'x-algorithm', 'main'),
    platform: 'github_atom',
    category: 'OFFICIAL_SOURCE',
    entity: 'xai',
    priority: 1,
    isOfficial: true,
    expectedValue:
      'The live X For You ranker. As of 2026-08-12 it had been static for ~3 months, so the ' +
      'commonly repeated "republished every 4 weeks" cadence does not hold. Any push is a ' +
      'Priority-1 event: a rare, checkable, high-authority topic for real analysis.',
    verifiedAt: DOC,
  },
  {
    id: 'gh-anthropic-sdk-python',
    name: 'anthropics/anthropic-sdk-python releases',
    url: gh('anthropics', 'anthropic-sdk-python'),
    platform: 'github_atom',
    category: 'EARLY_SIGNAL',
    entity: 'anthropic',
    priority: 2,
    isOfficial: true,
    expectedValue: 'SDK releases frequently name new model IDs before or with the announcement.',
    verifiedAt: DOC,
  },
  {
    id: 'gh-anthropic-sdk-typescript',
    name: 'anthropics/anthropic-sdk-typescript releases',
    url: gh('anthropics', 'anthropic-sdk-typescript'),
    platform: 'github_atom',
    category: 'EARLY_SIGNAL',
    entity: 'anthropic',
    priority: 2,
    isOfficial: true,
    expectedValue: 'As above, and the operator’s own language.',
    verifiedAt: null,
  },
  {
    id: 'gh-claude-code',
    name: 'anthropics/claude-code releases',
    url: gh('anthropics', 'claude-code'),
    platform: 'github_atom',
    category: 'OFFICIAL_SOURCE',
    entity: 'anthropic',
    priority: 2,
    isOfficial: true,
    expectedValue: 'Agent tooling the operator uses daily — directly testable, high brand fit.',
    verifiedAt: null,
  },
  {
    id: 'gh-openai-python',
    name: 'openai/openai-python releases',
    url: gh('openai', 'openai-python'),
    platform: 'github_atom',
    category: 'EARLY_SIGNAL',
    entity: 'openai',
    priority: 2,
    isOfficial: true,
    expectedValue: 'Leaks model IDs and parameter changes early.',
    verifiedAt: null,
  },
  {
    id: 'gh-google-genai-python',
    name: 'googleapis/python-genai releases',
    url: gh('googleapis', 'python-genai'),
    platform: 'github_atom',
    category: 'EARLY_SIGNAL',
    entity: 'google',
    priority: 3,
    isOfficial: true,
    expectedValue: 'Gemini API surface changes.',
    verifiedAt: null,
  },
  {
    id: 'gh-llama-cpp',
    name: 'ggml-org/llama.cpp releases',
    url: gh('ggml-org', 'llama.cpp'),
    platform: 'github_atom',
    category: 'COMMUNITY_SIGNAL',
    entity: null,
    priority: 2,
    isOfficial: false,
    expectedValue: 'Local inference. Support for a new architecture lands here first.',
    verifiedAt: DOC,
  },
  {
    id: 'gh-vllm',
    name: 'vllm-project/vllm releases',
    url: gh('vllm-project', 'vllm'),
    platform: 'github_atom',
    category: 'COMMUNITY_SIGNAL',
    entity: null,
    priority: 3,
    isOfficial: false,
    expectedValue: 'Serving-side performance and model support.',
    verifiedAt: null,
  },
  {
    id: 'gh-ollama',
    name: 'ollama/ollama releases',
    url: gh('ollama', 'ollama'),
    platform: 'github_atom',
    category: 'COMMUNITY_SIGNAL',
    entity: null,
    priority: 3,
    isOfficial: false,
    expectedValue: 'Local model distribution; a proxy for what is becoming widely runnable.',
    verifiedAt: null,
  },
  {
    id: 'gh-transformers',
    name: 'huggingface/transformers releases',
    url: gh('huggingface', 'transformers'),
    platform: 'github_atom',
    // Hugging Face's own repository, so its releases are the record for this
    // project rather than commentary on it — OFFICIAL_SOURCE, not COMMUNITY_SIGNAL.
    category: 'OFFICIAL_SOURCE',
    entity: 'huggingface',
    priority: 3,
    isOfficial: true,
    expectedValue: 'New architectures appear here before the papers are widely read.',
    verifiedAt: null,
  },
  {
    id: 'gh-mcp-servers',
    name: 'modelcontextprotocol/servers releases',
    url: gh('modelcontextprotocol', 'servers'),
    platform: 'github_atom',
    category: 'COMMUNITY_SIGNAL',
    entity: null,
    priority: 3,
    isOfficial: false,
    expectedValue: 'MCP ecosystem movement.',
    verifiedAt: null,
  },
  {
    id: 'gh-cline',
    name: 'cline/cline releases',
    url: gh('cline', 'cline'),
    platform: 'github_atom',
    category: 'COMMUNITY_SIGNAL',
    entity: null,
    priority: 3,
    isOfficial: false,
    expectedValue: 'Agentic coding tooling; a competitive check on the operator’s own workflow.',
    verifiedAt: null,
  },
  {
    id: 'gh-nextjs',
    name: 'vercel/next.js releases',
    url: gh('vercel', 'next.js'),
    platform: 'github_atom',
    category: 'OFFICIAL_SOURCE',
    entity: 'vercel',
    priority: 2,
    isOfficial: true,
    expectedValue: 'The operator’s own stack. High brand relevance, directly testable.',
    verifiedAt: DOC,
  },
  {
    id: 'gh-flutter',
    name: 'flutter/flutter releases',
    url: gh('flutter', 'flutter'),
    platform: 'github_atom',
    category: 'OFFICIAL_SOURCE',
    entity: 'flutter',
    priority: 2,
    isOfficial: true,
    expectedValue: 'The operator writes Dart daily. Directly testable.',
    verifiedAt: null,
  },
  {
    id: 'gh-supabase',
    name: 'supabase/supabase releases',
    url: gh('supabase', 'supabase'),
    platform: 'github_atom',
    category: 'OFFICIAL_SOURCE',
    entity: 'supabase',
    priority: 2,
    isOfficial: true,
    expectedValue: 'The operator’s backend. Directly testable.',
    verifiedAt: null,
  },

  // ─────────────────────────────────────────────────────────────────────
  // TIER 1c — Status pages. §1c. The cheapest, highest-precision detector
  // in the system, and one of the few event classes where being ten
  // minutes early is genuinely differentiating.
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'status-anthropic',
    name: 'Anthropic Status',
    url: 'https://status.claude.com/history.rss',
    platform: 'statuspage',
    category: 'OFFICIAL_SOURCE',
    entity: 'anthropic',
    priority: 1,
    isOfficial: true,
    expectedValue:
      'Outages on the operator’s primary vendor. NOTE: status.anthropic.com now 302s here — ' +
      'Anthropic moved its status page to the claude.com domain. Registered at the canonical ' +
      'host; found on the first LIVE run, 2026-08-13.',
    verifiedAt: '2026-08-13',
  },
  {
    id: 'status-openai',
    name: 'OpenAI Status',
    url: 'https://status.openai.com/history.rss',
    platform: 'statuspage',
    category: 'OFFICIAL_SOURCE',
    entity: 'openai',
    priority: 1,
    isOfficial: true,
    expectedValue: 'Outages with a large actively-searching audience.',
    verifiedAt: DOC,
  },
  {
    id: 'status-github',
    name: 'GitHub Status',
    url: 'https://www.githubstatus.com/history.rss',
    platform: 'statuspage',
    category: 'OFFICIAL_SOURCE',
    entity: 'github',
    priority: 2,
    isOfficial: true,
    expectedValue: 'Developer-wide impact.',
    verifiedAt: DOC,
  },
  {
    id: 'status-google-cloud',
    name: 'Google Cloud Status',
    url: 'https://status.cloud.google.com/en/feed.atom',
    platform: 'statuspage',
    category: 'OFFICIAL_SOURCE',
    entity: 'google',
    priority: 2,
    isOfficial: true,
    expectedValue: 'Atom rather than RSS — a different shape from the Statuspage tenants.',
    verifiedAt: DOC,
  },
  {
    id: 'status-cloudflare',
    name: 'Cloudflare Status',
    url: 'https://www.cloudflarestatus.com/history.rss',
    platform: 'statuspage',
    category: 'OFFICIAL_SOURCE',
    entity: 'cloudflare',
    priority: 2,
    isOfficial: true,
    expectedValue: 'A Cloudflare outage takes a visible fraction of the web with it.',
    verifiedAt: '2026-08-13',
  },
  {
    id: 'status-vercel',
    name: 'Vercel Status',
    url: 'https://www.vercel-status.com/history.rss',
    platform: 'statuspage',
    category: 'OFFICIAL_SOURCE',
    entity: 'vercel',
    priority: 2,
    isOfficial: true,
    expectedValue: 'The operator’s deployment platform.',
    verifiedAt: '2026-08-13',
  },
  {
    id: 'status-aws',
    name: 'AWS Service Health',
    url: 'https://status.aws.amazon.com/rss/all.rss',
    platform: 'statuspage',
    category: 'OFFICIAL_SOURCE',
    entity: 'amazon',
    priority: 2,
    isOfficial: true,
    expectedValue:
      'The legacy RSS endpoint still serves (200, 36 items, 2026-08-13) even though the ' +
      'human-facing page moved to health.aws.amazon.com, which is HTML only.',
    verifiedAt: '2026-08-13',
  },
  {
    id: 'status-supabase',
    name: 'Supabase Status',
    url: 'https://status.supabase.com/history.rss',
    platform: 'statuspage',
    category: 'OFFICIAL_SOURCE',
    entity: 'supabase',
    priority: 2,
    isOfficial: true,
    expectedValue: 'The operator’s backend.',
    verifiedAt: '2026-08-13',
  },

  // ─────────────────────────────────────────────────────────────────────
  // TIER 2 — Discussion, discovery, velocity. §2.
  // These rarely produce the canonical record. They produce velocity,
  // sentiment, and "what is being misunderstood" — which is where the
  // differentiated angle usually comes from.
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'hn-frontpage',
    name: 'Hacker News front page',
    url: 'https://news.ycombinator.com/rss',
    platform: 'rss',
    category: 'COMMUNITY_SIGNAL',
    entity: null,
    priority: 2,
    isOfficial: false,
    expectedValue: 'Official, no key. Primary velocity signal and the X-velocity substitute.',
    verifiedAt: DOC,
  },
  {
    id: 'hn-100points',
    name: 'Hacker News ≥100 points',
    url: 'https://hnrss.org/newest?points=100',
    platform: 'rss',
    category: 'COMMUNITY_SIGNAL',
    entity: null,
    priority: 2,
    isOfficial: false,
    expectedValue:
      'Third-party (hnrss.org) with no SLA. Treat availability as best-effort; hn-frontpage ' +
      'plus client-side filtering is the fallback.',
    verifiedAt: DOC,
    reliability: 0.4,
  },
  {
    id: 'lobsters',
    name: 'Lobsters',
    url: 'https://lobste.rs/rss',
    platform: 'rss',
    category: 'COMMUNITY_SIGNAL',
    entity: null,
    priority: 3,
    isOfficial: false,
    expectedValue: 'Higher signal-to-noise than HN, much lower volume.',
    verifiedAt: DOC,
  },
  {
    id: 'reddit-localllama',
    name: 'r/LocalLLaMA',
    url: 'https://www.reddit.com/r/LocalLLaMA/.rss',
    platform: 'rss',
    category: 'COMMUNITY_SIGNAL',
    entity: null,
    priority: 2,
    isOfficial: false,
    expectedValue:
      'Public .rss, no auth. Store as short-lived signal only — never mirror Reddit user text ' +
      'into durable storage (SOURCE-INTELLIGENCE.md §2).',
    verifiedAt: DOC,
  },
  {
    id: 'producthunt',
    name: 'Product Hunt',
    url: 'https://www.producthunt.com/feed',
    platform: 'rss',
    category: 'COMMUNITY_SIGNAL',
    entity: null,
    priority: 4,
    isOfficial: false,
    expectedValue: 'Launch discovery; low technical density.',
    verifiedAt: DOC,
  },
  {
    id: 'arxiv-cs-ai',
    name: 'arXiv cs.AI',
    url: 'https://export.arxiv.org/rss/cs.AI',
    platform: 'rss',
    category: 'TECHNICAL_RESEARCHER',
    entity: null,
    priority: 3,
    isOfficial: false,
    expectedValue:
      'Very high volume (344 items in one pull). Hard-gated in Phase 5: an arXiv item may not ' +
      'reach the LLM tier unless already corroborated by HN ≥100 points, a lab blog post, or ' +
      '≥2 monitored repos.',
    verifiedAt: DOC,
  },
  {
    id: 'github-blog',
    name: 'GitHub Blog',
    url: 'https://github.blog/feed/',
    platform: 'rss',
    category: 'OFFICIAL_SOURCE',
    entity: 'github',
    priority: 3,
    isOfficial: true,
    expectedValue: 'Platform direction.',
    verifiedAt: DOC,
  },
  {
    id: 'github-changelog',
    name: 'GitHub Changelog',
    url: 'https://github.blog/changelog/feed/',
    platform: 'rss',
    category: 'OFFICIAL_SOURCE',
    entity: 'github',
    priority: 2,
    isOfficial: true,
    expectedValue: 'Platform and policy changes — event Category D.',
    verifiedAt: DOC,
  },
  {
    id: 'cloudflare-blog',
    name: 'Cloudflare Blog',
    url: 'https://blog.cloudflare.com/rss/',
    platform: 'rss',
    category: 'OFFICIAL_SOURCE',
    entity: 'cloudflare',
    priority: 3,
    isOfficial: true,
    expectedValue: 'Unusually deep engineering writeups — good teaching material.',
    verifiedAt: DOC,
  },
  {
    id: 'vercel-changelog',
    name: 'Vercel',
    url: 'https://vercel.com/atom',
    platform: 'atom',
    category: 'OFFICIAL_SOURCE',
    entity: 'vercel',
    priority: 3,
    isOfficial: true,
    expectedValue: 'The operator’s deployment platform.',
    verifiedAt: DOC,
  },
  {
    id: 'gitlab-blog',
    name: 'GitLab',
    url: 'https://about.gitlab.com/atom.xml',
    platform: 'atom',
    category: 'OFFICIAL_SOURCE',
    entity: null,
    priority: 4,
    isOfficial: true,
    expectedValue: 'Low priority; occasional platform-policy signal.',
    verifiedAt: DOC,
  },

  // ─────────────────────────────────────────────────────────────────────
  // TIER 3 — Journalism and expert analysis. §3.
  // Corroboration and "what is the mainstream reading of this" only.
  // NEVER the sole basis of a factual claim (enforced in Phase 6).
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'simonwillison',
    name: 'Simon Willison',
    url: 'https://simonwillison.net/atom/everything/',
    platform: 'atom',
    category: 'EXPERT_ANALYST',
    entity: null,
    priority: 2,
    isOfficial: false,
    expectedValue:
      'One of the few individual feeds where the author tests things and publishes the result ' +
      'within hours. Both a latency benchmark and a competitive check: if he has already run ' +
      'the experiment, the operator’s angle must differ rather than duplicate.',
    verifiedAt: DOC,
    reliability: 0.85,
  },
  // ─────────────────────────────────────────────────────────────────────
  // INDIVIDUALS. SOURCE-INTELLIGENCE.md §4 called this "the single largest
  // remaining gap in this registry". Filled 2026-08-13 by the two routes §4
  // says remain viable now that X pricing removed the third: individual blogs,
  // and GitHub activity atoms.
  //
  // HONEST LIMIT ON THIS SELECTION. §4 sets four criteria. Three are
  // observable from a few posts and were applied: publishes evidence (numbers,
  // code, screenshots) rather than reaction; operates in applied AI
  // engineering rather than AI commentary; and — for the GitHub atoms — is a
  // maintainer whose commits precede their writing. The fourth, "has been
  // *first* on a checkable claim at least twice in the last six months", needs
  // an archive read and a judgment call, and is **NOT** verified here. Treat
  // this list as probed and plausible, not as vetted. Prune it at the Phase 12
  // review, when there is measured precision per source to prune on.
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'sebastian-raschka',
    name: 'Sebastian Raschka — Ahead of AI',
    url: 'https://magazine.sebastianraschka.com/feed',
    platform: 'rss',
    category: 'EXPERT_ANALYST',
    entity: null,
    priority: 3,
    isOfficial: false,
    expectedValue:
      'Implements architectures from scratch and publishes the code. Teaching material.',
    verifiedAt: '2026-08-13',
  },
  {
    id: 'hamel-husain',
    name: 'Hamel Husain',
    url: 'https://hamel.dev/index.xml',
    platform: 'atom',
    category: 'EXPERT_ANALYST',
    entity: null,
    priority: 3,
    isOfficial: false,
    expectedValue:
      'Evals and LLM engineering practice. Unusually concrete about what does not work. ' +
      'NOTE: the feed is malformed — it serves a complete document, a stray "em>", then a ' +
      'SECOND concatenated document from a staging domain (checked 2026-08-13). The parser ' +
      'recovers the real items and the probe raises a warning rather than failing it.',
    verifiedAt: '2026-08-13',
  },
  {
    id: 'eugene-yan',
    name: 'Eugene Yan',
    url: 'https://eugeneyan.com/rss/',
    platform: 'rss',
    category: 'EXPERT_ANALYST',
    entity: null,
    priority: 3,
    isOfficial: false,
    expectedValue:
      'Applied ML systems. The feed carries the full archive (212 items at probe time), so the ' +
      'first ingest will be large and almost entirely old.',
    verifiedAt: '2026-08-13',
  },
  {
    id: 'chip-huyen',
    name: 'Chip Huyen',
    url: 'https://huyenchip.com/feed.xml',
    platform: 'atom',
    category: 'EXPERT_ANALYST',
    entity: null,
    priority: 3,
    isOfficial: false,
    expectedValue: 'ML systems design, deployment economics.',
    verifiedAt: '2026-08-13',
  },
  {
    id: 'lilian-weng',
    name: 'Lil’Log (Lilian Weng)',
    url: 'https://lilianweng.github.io/index.xml',
    platform: 'atom',
    category: 'TECHNICAL_RESEARCHER',
    entity: null,
    priority: 3,
    isOfficial: false,
    expectedValue: 'Long-form technical surveys. Infrequent, high depth — a teaching source.',
    verifiedAt: '2026-08-13',
  },
  {
    id: 'answer-ai',
    name: 'Answer.AI',
    url: 'https://www.answer.ai/index.xml',
    platform: 'atom',
    category: 'EXPERT_ANALYST',
    entity: null,
    priority: 3,
    isOfficial: false,
    expectedValue:
      'An organisation rather than an individual, listed here because the writing is ' +
      'individually authored and applied.',
    verifiedAt: '2026-08-13',
  },
  {
    id: 'gh-user-simonw',
    name: 'Simon Willison — GitHub activity',
    url: 'https://github.com/simonw.atom',
    platform: 'github_atom',
    category: 'EARLY_SIGNAL',
    entity: null,
    priority: 3,
    isOfficial: false,
    expectedValue:
      'SOURCE-INTELLIGENCE.md §4: for engineers and maintainers, public GitHub activity is ' +
      'often earlier than their writing. The commit precedes the post.',
    verifiedAt: '2026-08-13',
  },
  {
    id: 'gh-user-karpathy',
    name: 'Andrej Karpathy — GitHub activity',
    url: 'https://github.com/karpathy.atom',
    platform: 'github_atom',
    category: 'EARLY_SIGNAL',
    entity: null,
    priority: 3,
    isOfficial: false,
    expectedValue:
      'Low volume, high signal. His blog feed at karpathy.bearblog.dev returns 403 to ' +
      'non-browser clients (checked 2026-08-13), so this is the only free route.',
    verifiedAt: '2026-08-13',
  },
  {
    id: 'gh-user-ggerganov',
    name: 'Georgi Gerganov — GitHub activity',
    url: 'https://github.com/ggerganov.atom',
    platform: 'github_atom',
    category: 'EARLY_SIGNAL',
    entity: null,
    priority: 3,
    isOfficial: false,
    expectedValue: 'llama.cpp / ggml. Local-inference capability changes show up here first.',
    verifiedAt: '2026-08-13',
  },

  {
    id: 'ieee-spectrum',
    name: 'IEEE Spectrum',
    url: 'https://spectrum.ieee.org/feeds/feed.rss',
    platform: 'rss',
    category: 'EXPERT_ANALYST',
    entity: null,
    priority: 4,
    isOfficial: false,
    expectedValue: 'Hardware and engineering depth.',
    verifiedAt: DOC,
  },
  {
    id: 'techcrunch',
    name: 'TechCrunch',
    url: 'https://techcrunch.com/feed/',
    platform: 'rss',
    category: 'JOURNALIST',
    entity: null,
    priority: 3,
    isOfficial: false,
    expectedValue: 'Corroboration and funding/business context.',
    verifiedAt: DOC,
  },
  {
    id: 'theverge',
    name: 'The Verge',
    url: 'https://www.theverge.com/rss/index.xml',
    platform: 'atom',
    category: 'JOURNALIST',
    entity: null,
    priority: 3,
    isOfficial: false,
    expectedValue: 'Consumer framing — useful for "what is being misunderstood".',
    verifiedAt: DOC,
  },
  {
    id: 'arstechnica',
    name: 'Ars Technica',
    url: 'https://feeds.arstechnica.com/arstechnica/index',
    platform: 'rss',
    category: 'JOURNALIST',
    entity: null,
    priority: 3,
    isOfficial: false,
    expectedValue: 'The most technically careful of the mainstream outlets.',
    verifiedAt: DOC,
  },
  {
    id: 'wired',
    name: 'Wired',
    url: 'https://www.wired.com/feed/rss',
    platform: 'rss',
    category: 'JOURNALIST',
    entity: null,
    priority: 4,
    isOfficial: false,
    expectedValue: 'Broad framing; lowest technical density of the three.',
    verifiedAt: DOC,
  },
];

/** Resolve a seed to its stored row shape, applying category and priority defaults. */
export function resolveSourceSeed(seed: SourceSeed) {
  return {
    id: seed.id,
    name: seed.name,
    url: seed.url,
    platform: seed.platform,
    category: seed.category,
    entity: seed.entity,
    priority: seed.priority,
    isOfficial: seed.isOfficial,
    reliability: seed.reliability ?? SOURCE_CATEGORY_RELIABILITY[seed.category],
    pollIntervalSec: seed.pollIntervalSec ?? DEFAULT_POLL_INTERVAL_SEC[seed.priority],
    expectedValue: seed.expectedValue,
    verifiedAt: seed.verifiedAt === null ? null : new Date(`${seed.verifiedAt}T00:00:00Z`),
  };
}
