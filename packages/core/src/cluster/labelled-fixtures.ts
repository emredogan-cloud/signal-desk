/**
 * The labelled clustering set, as data.
 *
 * See `fixtures/labelled/README.md` for how it was built, who labelled it, and why
 * the real half is small. In short: `provenance: 'real'` clusters are verbatim from
 * `raw_items`; `provenance: 'synthetic'` clusters are written to exercise the
 * specific behaviours `ROADMAP.md` Phase 4 names, and are correct by construction.
 *
 * Kept in `core` rather than under `fixtures/` as JSON because the measurement test
 * needs it typed, and because a mislabelled entry should be a compile error where it
 * can be.
 */

import type { SourceCategory } from '@signal-desk/shared';

export type LabelledItem = {
  readonly id: string;
  readonly sourceId: string;
  readonly sourceCategory: SourceCategory;
  readonly isOfficial: boolean;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  /** ISO timestamp. */
  readonly publishedAt: string;
};

export type LabelledCluster = {
  readonly label: string;
  readonly provenance: 'real' | 'synthetic';
  /** Why these items are one event, or — for negative cases — why they are not. */
  readonly note: string;
  readonly items: readonly LabelledItem[];
};

const iso = (day: number, hour: number, minute = 0): string =>
  new Date(Date.UTC(2026, 7, day, hour, minute)).toISOString();

// ─────────────────────────────────────────────────────────────────────
// REAL — verbatim from raw_items, ingested 2026-08-13.
// ─────────────────────────────────────────────────────────────────────

const REAL: LabelledCluster[] = [
  {
    label: 'amazon-twitch-optout',
    provenance: 'real',
    note:
      'One policy change, two outlets, 50 minutes apart. NO shared artifact string and ' +
      'no shared distinctive title token — stages 1 and 2 cannot catch it. This is the ' +
      'case stage 3 exists for, and it came from the real world.',
    items: [
      {
        id: 'real-2740',
        sourceId: 'arstechnica',
        sourceCategory: 'JOURNALIST',
        isOfficial: false,
        title: 'Twitch content has trained Amazon AI for years, but users can opt out now',
        body:
          "Twitch now lets users opt out of Amazon's use of content from their channels to " +
          'train Amazon\'s "generative AI content models." The change, announced today, comes ' +
          'more than two years after a company executive confirmed the practice.',
        url: 'https://arstechnica.com/ai/2026/08/twitch-content-has-trained-amazon-ai-for-years-but-users-can-opt-out-now/',
        publishedAt: '2026-08-12T21:00:30.000Z',
      },
      {
        id: 'real-3577',
        sourceId: 'techcrunch',
        sourceCategory: 'JOURNALIST',
        isOfficial: false,
        title: 'Amazon will train on Twitch streamers’ content by default, unless they opt out',
        body:
          '"If this was opt-in, nobody would opt in," Twitch CPO Mike Minton said on a ' +
          'livestream responding to user feedback. "That\'s honestly the answer."',
        url: 'https://techcrunch.com/2026/08/12/amazon-will-train-on-twitch-streamers-content-by-default-unless-they-opt-out/',
        publishedAt: '2026-08-12T20:10:40.000Z',
      },
    ],
  },
  {
    label: 'real-hn-mirror-deepseek-harness',
    provenance: 'real',
    note:
      'Hacker News and its ≥100-point mirror carry byte-identical titles and the same ' +
      'target URL. The cheapest possible stage-1 case, and the most common one in this ' +
      'registry.',
    items: [
      {
        id: 'real-hn-1',
        sourceId: 'hn-frontpage',
        sourceCategory: 'COMMUNITY_SIGNAL',
        isOfficial: false,
        title: 'DeepSeek Harness',
        body: 'Discussion on Hacker News.',
        url: 'https://github.com/deepseek-ai/harness',
        publishedAt: '2026-08-13T09:00:00.000Z',
      },
      {
        id: 'real-hn-2',
        sourceId: 'hn-100points',
        sourceCategory: 'COMMUNITY_SIGNAL',
        isOfficial: false,
        title: 'DeepSeek Harness',
        body: 'Discussion on Hacker News.',
        url: 'https://github.com/deepseek-ai/harness',
        publishedAt: '2026-08-13T09:04:00.000Z',
      },
    ],
  },
  {
    label: 'real-llamacpp-b10400',
    provenance: 'real',
    note: 'One release. The next build is a DIFFERENT event — see real-llamacpp-b10405.',
    items: [
      {
        id: 'real-b10400',
        sourceId: 'gh-llama-cpp',
        sourceCategory: 'COMMUNITY_SIGNAL',
        isOfficial: false,
        title: 'b10400',
        body: 'llama.cpp release b10400',
        url: 'https://github.com/ggml-org/llama.cpp/releases/tag/b10400',
        publishedAt: '2026-08-13T06:00:00.000Z',
      },
    ],
  },
  {
    label: 'real-llamacpp-b10405',
    provenance: 'real',
    note:
      'Consecutive builds from one repo, hours apart, near-identical text. MUST NOT merge ' +
      'with b10400 — two releases are two events, and merging them hides one.',
    items: [
      {
        id: 'real-b10405',
        sourceId: 'gh-llama-cpp',
        sourceCategory: 'COMMUNITY_SIGNAL',
        isOfficial: false,
        title: 'b10405',
        body: 'llama.cpp release b10405',
        url: 'https://github.com/ggml-org/llama.cpp/releases/tag/b10405',
        publishedAt: '2026-08-13T11:00:00.000Z',
      },
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────
// SYNTHETIC — the behaviours ROADMAP.md Phase 4 names, correct by construction.
// ─────────────────────────────────────────────────────────────────────

/** "the same launch reported by six outlets (must merge)" */
const SIX_OUTLET_LAUNCH: LabelledCluster = {
  label: 'syn-opus5-launch',
  provenance: 'synthetic',
  note:
    'ROADMAP.md Phase 4 acceptance: "The six-outlet launch case produces exactly one ' +
    'event with six evidence rows." Every item names the same model id, so stage 2 ' +
    'should carry it even without embeddings.',
  items: [
    {
      id: 'syn-opus5-official',
      sourceId: 'anthropic-news-diff',
      sourceCategory: 'OFFICIAL_SOURCE',
      isOfficial: true,
      title: 'Introducing claude-opus-5',
      body:
        'Today we are releasing claude-opus-5, our most capable model. It scores higher on ' +
        'agentic coding benchmarks and supports a longer context window.',
      url: 'https://www.anthropic.com/news/claude-opus-5',
      publishedAt: iso(10, 15, 0),
    },
    {
      id: 'syn-opus5-tc',
      sourceId: 'techcrunch',
      sourceCategory: 'JOURNALIST',
      isOfficial: false,
      title: 'Anthropic launches claude-opus-5, its most capable model yet',
      body:
        'Anthropic released claude-opus-5 on Monday, claiming state-of-the-art results on ' +
        'agentic coding tasks.',
      url: 'https://techcrunch.com/2026/08/10/anthropic-claude-opus-5/',
      publishedAt: iso(10, 15, 40),
    },
    {
      id: 'syn-opus5-verge',
      sourceId: 'theverge',
      sourceCategory: 'JOURNALIST',
      isOfficial: false,
      title: 'Anthropic’s new claude-opus-5 targets developers',
      body: 'The company says claude-opus-5 is aimed squarely at engineering workflows.',
      url: 'https://www.theverge.com/2026/8/10/anthropic-claude-opus-5',
      publishedAt: iso(10, 16, 10),
    },
    {
      id: 'syn-opus5-ars',
      sourceId: 'arstechnica',
      sourceCategory: 'JOURNALIST',
      isOfficial: false,
      title: 'claude-opus-5 arrives with a bigger context window',
      body: 'Anthropic has shipped claude-opus-5, its flagship model for 2026.',
      url: 'https://arstechnica.com/ai/2026/08/claude-opus-5/',
      publishedAt: iso(10, 17, 0),
    },
    {
      id: 'syn-opus5-hn',
      sourceId: 'hn-frontpage',
      sourceCategory: 'COMMUNITY_SIGNAL',
      isOfficial: false,
      title: 'Introducing claude-opus-5',
      body: 'Discussion on Hacker News.',
      url: 'https://news.ycombinator.com/item?id=99887766',
      publishedAt: iso(10, 17, 30),
    },
    {
      id: 'syn-opus5-simon',
      sourceId: 'simonwillison',
      sourceCategory: 'EXPERT_ANALYST',
      isOfficial: false,
      title: 'Notes on claude-opus-5',
      body: 'I ran claude-opus-5 against my usual test suite this afternoon. Here is what I found.',
      url: 'https://simonwillison.net/2026/Aug/10/claude-opus-5/',
      publishedAt: iso(10, 19, 0),
    },
  ],
};

/** "two genuinely different models from the same vendor announced the same day
 *  (must NOT merge)" — two clusters, deliberately adjacent. */
const SAME_DAY_TWO_MODELS: LabelledCluster[] = [
  {
    label: 'syn-sameday-sonnet',
    provenance: 'synthetic',
    note:
      'ROADMAP.md Phase 4 acceptance: "The two-models-same-day case produces two events." ' +
      'Same vendor, same day, same announcement style. A wrong merge here HIDES a launch, ' +
      'which is the worst failure this module can have.',
    items: [
      {
        id: 'syn-sonnet-official',
        sourceId: 'anthropic-news-diff',
        sourceCategory: 'OFFICIAL_SOURCE',
        isOfficial: true,
        title: 'Introducing claude-sonnet-5',
        body:
          'We are releasing claude-sonnet-5, a faster and cheaper model for high-volume ' +
          'workloads.',
        url: 'https://www.anthropic.com/news/claude-sonnet-5',
        publishedAt: iso(10, 15, 5),
      },
      {
        id: 'syn-sonnet-tc',
        sourceId: 'techcrunch',
        sourceCategory: 'JOURNALIST',
        isOfficial: false,
        title: 'Anthropic also ships claude-sonnet-5 for high-volume work',
        body: 'Alongside its flagship, Anthropic released claude-sonnet-5.',
        url: 'https://techcrunch.com/2026/08/10/anthropic-claude-sonnet-5/',
        publishedAt: iso(10, 16, 0),
      },
    ],
  },
];

/** "an update to an existing event arriving 3 days later" — outside the window. */
const LATE_UPDATE: LabelledCluster = {
  label: 'syn-opus5-followup',
  provenance: 'synthetic',
  note:
    'A follow-up three days after the launch. Outside the 48-hour window, so it is a ' +
    'separate event even though it shares the artifact. Merging it would date the launch ' +
    'wrongly and corrupt the latency KPI.',
  items: [
    {
      id: 'syn-opus5-pricing',
      sourceId: 'anthropic-news-diff',
      sourceCategory: 'OFFICIAL_SOURCE',
      isOfficial: true,
      title: 'Pricing update for claude-opus-5',
      body: 'We are reducing the price of claude-opus-5 input tokens, effective immediately.',
      url: 'https://www.anthropic.com/news/claude-opus-5-pricing',
      publishedAt: iso(13, 15, 0),
    },
  ],
};

/** Distinct events that share entities and sit close in time — the false-merge risk. */
const DISTINCT_NEARBY: LabelledCluster[] = [
  {
    label: 'syn-nvidia-chip',
    provenance: 'synthetic',
    note: 'Same vendor and same day as syn-nvidia-pricing, different subject and category.',
    items: [
      {
        id: 'syn-nvidia-chip-1',
        sourceId: 'nvidia-blog',
        sourceCategory: 'OFFICIAL_SOURCE',
        isOfficial: true,
        title: 'NVIDIA announces the Blackwell Ultra GPU for data centres',
        body: 'The new Blackwell Ultra silicon doubles memory bandwidth over the prior generation.',
        url: 'https://blogs.nvidia.com/blog/blackwell-ultra/',
        publishedAt: iso(11, 14, 0),
      },
    ],
  },
  {
    label: 'syn-nvidia-pricing',
    provenance: 'synthetic',
    note: 'A policy/pricing event, not a hardware launch. Must not merge with the chip news.',
    items: [
      {
        id: 'syn-nvidia-pricing-1',
        sourceId: 'nvidia-blog',
        sourceCategory: 'OFFICIAL_SOURCE',
        isOfficial: true,
        title: 'Updated pricing and licensing terms for NVIDIA AI Enterprise',
        body: 'We are changing the licensing terms and pricing for NVIDIA AI Enterprise subscriptions.',
        url: 'https://blogs.nvidia.com/blog/ai-enterprise-pricing/',
        publishedAt: iso(11, 15, 0),
      },
    ],
  },
  {
    label: 'syn-openai-outage',
    provenance: 'synthetic',
    note: 'An outage, corroborated by the status page and a community thread.',
    items: [
      {
        id: 'syn-outage-status',
        sourceId: 'status-openai',
        sourceCategory: 'OFFICIAL_SOURCE',
        isOfficial: true,
        title: 'Elevated error rates on the API',
        body: 'We are investigating elevated error rates affecting API requests.',
        url: 'https://status.openai.com/incidents/abc123',
        publishedAt: iso(12, 9, 0),
      },
      {
        id: 'syn-outage-hn',
        sourceId: 'hn-frontpage',
        sourceCategory: 'COMMUNITY_SIGNAL',
        isOfficial: false,
        title: 'OpenAI API is returning elevated error rates',
        body: 'Anyone else seeing 500s from the OpenAI API right now?',
        url: 'https://news.ycombinator.com/item?id=99887799',
        publishedAt: iso(12, 9, 20),
      },
    ],
  },
  {
    label: 'syn-qwen-release',
    provenance: 'synthetic',
    note: 'An open-weights release covered by the vendor blog and a community thread.',
    items: [
      {
        id: 'syn-qwen-blog',
        sourceId: 'qwen-blog',
        sourceCategory: 'OFFICIAL_SOURCE',
        isOfficial: true,
        title: 'Qwen3.8-27B: open weights release',
        body: 'We are releasing Qwen3.8-27B under an Apache 2.0 licence.',
        url: 'https://qwenlm.github.io/blog/qwen3-8-27b/',
        publishedAt: iso(12, 11, 0),
      },
      {
        id: 'syn-qwen-reddit',
        sourceId: 'reddit-localllama',
        sourceCategory: 'COMMUNITY_SIGNAL',
        isOfficial: false,
        title: 'Qwen3.8-27B is out',
        body: 'Qwen3.8-27B just dropped on Hugging Face. Benchmarks in the comments.',
        url: 'https://www.reddit.com/r/LocalLLaMA/comments/qwen3827b/',
        publishedAt: iso(12, 11, 45),
      },
    ],
  },
  {
    label: 'syn-nextjs-release',
    provenance: 'synthetic',
    note: 'A framework release, announced once. A singleton — most events are.',
    items: [
      {
        id: 'syn-nextjs-1',
        sourceId: 'gh-nextjs',
        sourceCategory: 'OFFICIAL_SOURCE',
        isOfficial: true,
        title: 'v16.4.0',
        body: 'Next.js 16.4.0 improves Turbopack cold start times.',
        url: 'https://github.com/vercel/next.js/releases/tag/v16.4.0',
        publishedAt: iso(12, 13, 0),
      },
    ],
  },
  {
    label: 'syn-flutter-release',
    provenance: 'synthetic',
    note: 'Unrelated to everything else in the window. Must stay on its own.',
    items: [
      {
        id: 'syn-flutter-1',
        sourceId: 'gh-flutter',
        sourceCategory: 'OFFICIAL_SOURCE',
        isOfficial: true,
        title: 'Flutter 3.47 stable',
        body: 'Flutter 3.47 is now stable, with improved impeller performance on Android.',
        url: 'https://github.com/flutter/flutter/releases/tag/3.47.0',
        publishedAt: iso(12, 14, 0),
      },
    ],
  },
  {
    label: 'syn-cloudflare-outage',
    provenance: 'synthetic',
    note: 'A different vendor’s outage on the same day as the OpenAI one. Must not merge.',
    items: [
      {
        id: 'syn-cf-status',
        sourceId: 'status-cloudflare',
        sourceCategory: 'OFFICIAL_SOURCE',
        isOfficial: true,
        title: 'DNS resolution errors in several regions',
        body: 'We are investigating DNS resolution errors affecting multiple points of presence.',
        url: 'https://www.cloudflarestatus.com/incidents/xyz789',
        publishedAt: iso(12, 9, 10),
      },
    ],
  },
  {
    label: 'syn-arxiv-paper',
    provenance: 'synthetic',
    note: 'A research paper. High-volume, low-density — must not absorb anything.',
    items: [
      {
        id: 'syn-arxiv-1',
        sourceId: 'arxiv-cs-ai',
        sourceCategory: 'TECHNICAL_RESEARCHER',
        isOfficial: false,
        title: 'Retrieval-Augmented Generation with Confidence-Aware Reranking',
        body: 'We propose a reranking method that conditions on retrieval confidence.',
        url: 'https://arxiv.org/abs/2608.01234',
        publishedAt: iso(12, 5, 0),
      },
    ],
  },
];

export const LABELLED_CLUSTERS: readonly LabelledCluster[] = [
  ...REAL,
  SIX_OUTLET_LAUNCH,
  ...SAME_DAY_TWO_MODELS,
  LATE_UPDATE,
  ...DISTINCT_NEARBY,
];

export const LABELLED_ITEMS: readonly (LabelledItem & { label: string })[] =
  LABELLED_CLUSTERS.flatMap((cluster) =>
    cluster.items.map((item) => ({ ...item, label: cluster.label })),
  );
