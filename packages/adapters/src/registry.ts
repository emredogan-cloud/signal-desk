import type { SourcePlatform } from '@signal-desk/shared';
import { rssAdapter, atomAdapter, githubAtomAdapter, statusPageAdapter } from './feed-adapter.js';
import { htmlDiffAdapters, defaultHtmlDiffAdapter } from './html-diff.js';
import { makeMockFeedAdapter, makeMockHtmlDiffAdapter } from './mock.js';
import type { AdapterSource, SourceAdapter } from './types.js';

/**
 * Picking the adapter for a source.
 *
 * The MOCK/LIVE split lives here rather than inside each adapter, so that no adapter
 * has a branch on mode and none can accidentally make a network call in MOCK. That
 * separation is what ARCHITECTURE.md §8 means by the distinction being explicit and
 * never inferred.
 */

export type AdapterMode = 'MOCK' | 'LIVE';

export type AdapterRegistryOptions = {
  readonly mode: AdapterMode;
  /** Required in MOCK mode. */
  readonly fixturesDir?: string | undefined;
};

export class NoAdapterError extends Error {
  constructor(platform: SourcePlatform) {
    super(`no adapter registered for platform "${platform}"`);
    this.name = 'NoAdapterError';
  }
}

export function createAdapterRegistry(options: AdapterRegistryOptions) {
  if (options.mode === 'MOCK') {
    const fixturesDir = options.fixturesDir;
    if (fixturesDir === undefined) {
      throw new Error('MOCK mode requires a fixturesDir — there is nothing to read otherwise');
    }
    const feed = makeMockFeedAdapter({ fixturesDir });
    const diff = makeMockHtmlDiffAdapter();

    return {
      mode: 'MOCK' as const,
      for(source: AdapterSource): SourceAdapter {
        return source.platform === 'html_diff' ? diff : feed;
      },
    };
  }

  return {
    mode: 'LIVE' as const,
    for(source: AdapterSource): SourceAdapter {
      switch (source.platform) {
        case 'rss':
          return rssAdapter;
        case 'atom':
          return atomAdapter;
        case 'github_atom':
          return githubAtomAdapter;
        case 'statuspage':
          return statusPageAdapter;
        case 'html_diff':
          // Configured per source: the news page is diffed on its link set, the
          // release-notes page on extracted text. See html-diff.ts.
          return htmlDiffAdapters[source.id] ?? defaultHtmlDiffAdapter;
        case 'github_api':
          // Enrichment only, never a watch mechanism — SOURCE-INTELLIGENCE.md §1b.
          // It has no place in the polling loop and is driven from Phase 5 scoring.
          throw new NoAdapterError(source.platform);
        case 'x_api':
          // SOURCE-INTELLIGENCE.md §0: X is a publishing and measurement surface,
          // never an ingestion one. Reaching here means a source was seeded wrong.
          throw new NoAdapterError(source.platform);
      }
    },
  };
}

export type AdapterRegistry = ReturnType<typeof createAdapterRegistry>;
