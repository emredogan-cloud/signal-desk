import type { SourcePlatform } from '@signal-desk/shared';
import { safeFetch, FetchLimitError } from './http.js';
import { SsrfBlockedError } from './ssrf.js';
import { parseFeed, NotAFeedError, EmptyFeedError } from './feed-parse.js';
import type {
  AdapterContext,
  AdapterResult,
  AdapterSource,
  FetchCursor,
  FetchOutcome,
  RawItem,
  SourceAdapter,
} from './types.js';

/**
 * The feed adapters: RSS, Atom, GitHub `.atom`, and Statuspage.
 *
 * ROADMAP.md names these as four adapters and they are exported as four, but they
 * share one implementation because they differ only in which XML dialect the
 * publisher happened to choose — a distinction the parser already handles. Writing
 * them out four times would produce four places to fix the same bug.
 *
 * What genuinely differs between source *types* — enrichment, robots.txt, diffing —
 * lives in `github-api.ts` and `html-diff.ts`, which are separate for that reason.
 */

function emptyResult(outcome: FetchOutcome, elapsedMs: number, error?: string): AdapterResult {
  return {
    outcome,
    items: [],
    httpStatus: undefined,
    etag: undefined,
    lastModified: undefined,
    bytes: 0,
    elapsedMs,
    notModified: false,
    error,
    warning: undefined,
  };
}

export async function fetchFeed(
  source: AdapterSource,
  cursor: FetchCursor,
  context: AdapterContext,
): Promise<AdapterResult> {
  const startedAt = Date.now();

  let response;
  try {
    response = await safeFetch(source.url, {
      etag: cursor.etag,
      lastModified: cursor.lastModified,
      guard: context.guard,
      ...(context.fetchImpl !== undefined ? { fetchImpl: context.fetchImpl } : {}),
      ...(context.timeoutMs !== undefined ? { timeoutMs: context.timeoutMs } : {}),
      ...(context.maxBytes !== undefined ? { maxBytes: context.maxBytes } : {}),
    });
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;

    if (error instanceof SsrfBlockedError) {
      return emptyResult('blocked', elapsedMs, error.message);
    }
    if (error instanceof FetchLimitError) {
      const outcome: FetchOutcome =
        error.kind === 'timeout'
          ? 'timeout'
          : error.kind === 'too_large'
            ? 'too_large'
            : error.kind === 'bad_scheme'
              ? 'blocked'
              : 'network_error';
      return emptyResult(outcome, elapsedMs, error.message);
    }
    return emptyResult(
      'network_error',
      elapsedMs,
      error instanceof Error ? error.message : String(error),
    );
  }

  const base = {
    httpStatus: response.status,
    etag: response.etag,
    lastModified: response.lastModified,
    bytes: response.bytes,
    elapsedMs: response.elapsedMs,
  };

  // A 304 is the point of sending conditional headers: no body, no parse, no work.
  if (response.notModified) {
    return {
      ...base,
      outcome: 'not_modified',
      items: [],
      notModified: true,
      error: undefined,
      warning: undefined,
    };
  }

  if (response.status < 200 || response.status >= 300) {
    return {
      ...base,
      outcome: 'http_error',
      items: [],
      notModified: false,
      error: `HTTP ${String(response.status)}`,
      warning: undefined,
    };
  }

  try {
    const parsed = parseFeed(source.id, response.body);
    return {
      ...base,
      outcome: 'ok',
      items: parsed.items,
      notModified: false,
      error: undefined,
      warning: parsed.warning,
    };
  } catch (error) {
    const outcome: FetchOutcome =
      error instanceof EmptyFeedError
        ? 'empty_feed'
        : error instanceof NotAFeedError
          ? 'not_a_feed'
          : 'not_a_feed';
    return {
      ...base,
      outcome,
      items: [],
      notModified: false,
      error: error instanceof Error ? error.message : String(error),
      warning: undefined,
    };
  }
}

function feedAdapter(platform: SourcePlatform): SourceAdapter {
  return { platform, fetch: fetchFeed };
}

/** RSS 2.0 and RDF/RSS 1.0. */
export const rssAdapter = feedAdapter('rss');

/** Atom 1.0. */
export const atomAdapter = feedAdapter('atom');

/**
 * GitHub `releases.atom` and `commits/{branch}.atom`.
 *
 * SOURCE-INTELLIGENCE.md §1b: these work unauthenticated with no visible quota, and
 * they are the *watch* mechanism. The REST API is enrichment only, and its 60/hour
 * unauthenticated ceiling is why the distinction matters.
 */
export const githubAtomAdapter = feedAdapter('github_atom');

/**
 * Statuspage `/history.rss` and Google Cloud's `/feed.atom`.
 *
 * Parsing is identical to RSS; the adapter exists as its own platform because
 * downstream scoring treats an outage differently from a blog post, and that
 * decision needs a field it can read.
 */
export const statusPageAdapter = feedAdapter('statuspage');

export type { RawItem };
