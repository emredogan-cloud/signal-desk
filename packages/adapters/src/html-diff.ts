import { safeFetch, FetchLimitError, USER_AGENT } from './http.js';
import { SsrfBlockedError } from './ssrf.js';
import { contentHash } from './feed-parse.js';
import { parseRobots, isAllowed, robotsUrlFor, PERMISSIVE, type RobotsRules } from './robots.js';
import type {
  AdapterContext,
  AdapterResult,
  AdapterSource,
  FetchCursor,
  RawItem,
  SourceAdapter,
} from './types.js';

/**
 * `HtmlDiffAdapter` — the answer to vendors who publish no feed.
 *
 * Anthropic is the case that forced this to exist: the operator's highest-relevance
 * vendor, and `SOURCE-INTELLIGENCE.md` §1a records that it has no RSS at all.
 *
 * Two modes, because the two Anthropic targets need different things:
 *
 * - **`links`** (default) — extract the set of article URLs matching a pattern and
 *   emit one item per URL. `anthropic.com/news` exposes a clean `/news/<slug>` list
 *   server-side, so a new slug is unambiguously a new announcement. Repeats are
 *   suppressed by the `(source_id, external_id)` uniqueness constraint, which means
 *   this mode needs no stored snapshot at all.
 *
 * - **`text`** — hash the extracted text of the whole page and emit one item whose
 *   external id *contains that hash*. An unchanged page therefore produces an id
 *   already in the table and inserts nothing; a changed page produces a new id and
 *   inserts. The release-notes page needs this, because what changes there is prose
 *   rather than a link set.
 *
 * Encoding the hash into the identity is what removes the need for a snapshot table.
 * The alternative — storing last-seen hashes and comparing — is a second source of
 * truth that can drift from `raw_items`, for no additional capability.
 */

export type HtmlDiffMode = 'links' | 'text';

export type HtmlDiffConfig = {
  readonly mode: HtmlDiffMode;
  /** `links` mode: which hrefs count. Defaults to same-origin article-shaped paths. */
  readonly linkPattern?: RegExp;
};

/** `anthropic.com/news` → `/news/<slug>`. */
const DEFAULT_LINK_PATTERN = /^\/(?:news|blog|posts|research|engineering)\/[a-z0-9][a-z0-9-]*\/?$/i;

/**
 * The ≥15-minute floor from SOURCE-INTELLIGENCE.md §1a.
 *
 * Enforced here as well as in the seed because this is the one mechanism with no
 * conditional-request story: every poll is a full page fetch, so the interval is the
 * only politeness control that exists.
 */
export const HTML_DIFF_MIN_INTERVAL_SEC = 15 * 60;

function fail(outcome: AdapterResult['outcome'], elapsedMs: number, error: string): AdapterResult {
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

/**
 * Strip markup to readable text.
 *
 * `<script>` and `<style>` contents are removed rather than un-tagged: the
 * release-notes page is 64% script bundle, and including it would make the content
 * hash change on every deploy of the docs site — turning a change detector into a
 * deploy detector.
 */
export function extractText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Absolute URLs for every href matching the pattern, deduplicated, in page order. */
export function extractLinks(html: string, pageUrl: string, pattern: RegExp): string[] {
  const found = new Set<string>();
  const hrefPattern = /<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;

  for (const match of html.matchAll(hrefPattern)) {
    const href = match[1];
    if (href === undefined) continue;

    let absolute: URL;
    try {
      absolute = new URL(href, pageUrl);
    } catch {
      continue;
    }

    // Same origin only. A diff target that started emitting third-party links would
    // otherwise turn into an open ingestion channel for whoever controls them.
    if (absolute.origin !== new URL(pageUrl).origin) continue;
    if (!pattern.test(absolute.pathname)) continue;

    absolute.hash = '';
    absolute.search = '';
    found.add(absolute.toString());
  }

  return [...found];
}

/** Extract a readable title from a slug: `/news/claude-opus-5` → "claude opus 5". */
function titleFromUrl(url: string): string {
  const segments = new URL(url).pathname.split('/').filter((s) => s !== '');
  const slug = segments[segments.length - 1] ?? url;
  return slug.replace(/[-_]+/g, ' ').trim();
}

export type RobotsFetcher = (robotsUrl: string) => Promise<RobotsRules>;

/** Fetch and parse robots.txt. A missing or unreadable file is permissive, which is
 *  the documented default — absence of a file is not a prohibition. */
export async function fetchRobots(
  robotsUrl: string,
  context: AdapterContext,
): Promise<RobotsRules> {
  try {
    const response = await safeFetch(robotsUrl, {
      guard: context.guard,
      ...(context.fetchImpl !== undefined ? { fetchImpl: context.fetchImpl } : {}),
      timeoutMs: 10_000,
      maxBytes: 512 * 1024,
    });
    if (response.status !== 200) return PERMISSIVE;
    return parseRobots(response.body, USER_AGENT);
  } catch {
    return PERMISSIVE;
  }
}

export function makeHtmlDiffAdapter(
  config: HtmlDiffConfig,
  robotsFetcher: RobotsFetcher = fetchRobots as unknown as RobotsFetcher,
): SourceAdapter {
  return {
    platform: 'html_diff',
    async fetch(
      source: AdapterSource,
      cursor: FetchCursor,
      context: AdapterContext,
    ): Promise<AdapterResult> {
      const startedAt = Date.now();

      // robots.txt first, every run. Caching it across runs would mean honouring a
      // policy the publisher has since changed.
      const rules = await robotsFetcher(robotsUrlFor(source.url));
      if (!isAllowed(rules, new URL(source.url).pathname)) {
        return fail(
          'skipped_robots',
          Date.now() - startedAt,
          `robots.txt disallows ${new URL(source.url).pathname} for this user-agent`,
        );
      }

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
        if (error instanceof SsrfBlockedError) return fail('blocked', elapsedMs, error.message);
        if (error instanceof FetchLimitError) {
          return fail(
            error.kind === 'timeout'
              ? 'timeout'
              : error.kind === 'too_large'
                ? 'too_large'
                : 'network_error',
            elapsedMs,
            error.message,
          );
        }
        return fail(
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
        warning: undefined,
      };

      if (response.notModified) {
        return { ...base, outcome: 'not_modified', items: [], notModified: true, error: undefined };
      }
      if (response.status < 200 || response.status >= 300) {
        return {
          ...base,
          outcome: 'http_error',
          items: [],
          notModified: false,
          error: `HTTP ${String(response.status)}`,
        };
      }
      if (response.body.trim() === '') {
        return {
          ...base,
          outcome: 'not_a_feed',
          items: [],
          notModified: false,
          error: '200 with an empty body',
        };
      }

      const items =
        config.mode === 'links'
          ? linkItems(source, response.body, config.linkPattern ?? DEFAULT_LINK_PATTERN)
          : textItems(source, response.body);

      if (items.length === 0) {
        return {
          ...base,
          outcome: 'empty_feed',
          items: [],
          notModified: false,
          error:
            config.mode === 'links'
              ? 'page fetched but no links matched the pattern — the layout may have changed'
              : 'page fetched but yielded no extractable text',
        };
      }

      return { ...base, outcome: 'ok', items, notModified: false, error: undefined };
    },
  };
}

function linkItems(source: AdapterSource, html: string, pattern: RegExp): RawItem[] {
  return extractLinks(html, source.url, pattern).map((url) => {
    const title = titleFromUrl(url);
    return {
      sourceId: source.id,
      // The URL is the identity. A slug that has been seen is already in the table.
      externalId: url,
      url,
      title,
      // The link set carries no body. Phase 3's job is detection; fetching each
      // article would mean following URLs found inside content, which is exactly
      // what §T-6's allowlist exists to prevent doing casually.
      body: '',
      author: undefined,
      publishedAt: undefined,
      contentHash: contentHash({ title, url, body: '' }),
      rawPayload: JSON.stringify({ discoveredVia: source.url, url }),
    };
  });
}

function textItems(source: AdapterSource, html: string): RawItem[] {
  const body = extractText(html);
  if (body === '') return [];

  const hash = contentHash({ title: source.id, url: source.url, body });

  return [
    {
      sourceId: source.id,
      // The hash IS the identity: an unchanged page produces an id already stored
      // and inserts nothing, a changed page produces a new id and inserts.
      externalId: `page:${hash}`,
      url: source.url,
      title: `${source.id} changed`,
      body,
      author: undefined,
      publishedAt: undefined,
      contentHash: hash,
      rawPayload: JSON.stringify({ mode: 'text', length: body.length }),
    },
  ];
}

/** The two registered diff targets, configured as SOURCE-INTELLIGENCE.md §1a requires. */
export const htmlDiffAdapters: Record<string, SourceAdapter> = {
  'anthropic-news-diff': makeHtmlDiffAdapter({ mode: 'links' }),
  'anthropic-release-notes-diff': makeHtmlDiffAdapter({ mode: 'text' }),
};

/** Fallback for a diff source with no specific configuration. */
export const defaultHtmlDiffAdapter = makeHtmlDiffAdapter({ mode: 'links' });
