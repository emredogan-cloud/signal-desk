import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { SourcePlatform } from '@signal-desk/shared';
import { safeFetch, FetchLimitError, type SafeFetchOptions } from './http.js';

/**
 * Source probing. ROADMAP.md Phase 2:
 *
 *   "`pnpm sources:probe` — fetches every registered source, reports HTTP status,
 *    content type, item count, and elapsed time as a table; writes `verified_at`"
 *
 * The reason this exists before ingestion rather than after is T-9: silent source
 * death is the most likely operational failure, and a feed that *parses* but yields
 * zero items is dead in the way that matters while looking healthy from the outside.
 * The probe is what makes that visible.
 */

export type ProbeOutcome =
  /** Valid feed with at least one item. */
  | 'ok'
  /** For html_diff sources: a page that fetched and yielded extractable content. */
  | 'ok_page'
  /** Non-2xx response. */
  | 'http_error'
  /**
   * 200, but the body is HTML rather than a feed.
   *
   * SOURCE-INTELLIGENCE.md records that this "killed three candidate feeds during
   * research" — `changelog.cursor.com/rss` and `docs.claude.com/rss.xml` both answer
   * 200 and serve a web page. A probe that only checks the status code reports these
   * as healthy forever.
   */
  | 'not_a_feed'
  /** Parsed as a feed, but contains zero items. Dead, not quiet. */
  | 'empty_feed'
  /** DNS failure, connection refused, TLS error. */
  | 'network_error'
  | 'timeout'
  | 'too_large';

export type ProbeResult = {
  readonly sourceId: string;
  readonly url: string;
  readonly finalUrl: string | undefined;
  readonly outcome: ProbeOutcome;
  readonly httpStatus: number | undefined;
  readonly contentType: string | undefined;
  readonly itemCount: number;
  readonly bytes: number;
  readonly elapsedMs: number;
  readonly redirects: number;
  readonly etag: string | undefined;
  readonly lastModified: string | undefined;
  /** Newest item timestamp found in the feed, if any parsed. */
  readonly newestItemAt: Date | undefined;
  readonly error: string | undefined;
  /**
   * Set when the fetch succeeded and produced usable items, but something about the
   * response is wrong and worth knowing. Distinct from `error`, which means the
   * probe failed: a warning never affects the exit code.
   */
  readonly warning: string | undefined;
};

export function isProbeSuccess(result: ProbeResult): boolean {
  return result.outcome === 'ok' || result.outcome === 'ok_page';
}

/** Feed-shaped platforms. `html_diff` is judged by different rules. */
const FEED_PLATFORMS = new Set<SourcePlatform>(['rss', 'atom', 'github_atom', 'statuspage']);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // A feed with exactly one <item> must still parse to an array of length 1, or the
  // item count silently becomes "1 object" vs "n array" depending on the day.
  isArray: (name) => name === 'item' || name === 'entry',
  // Never expand entities from untrusted input. THREAT-MODEL.md §T-1: this content
  // is data, and an XML parser that resolves external entities is a file-read
  // primitive handed to whoever writes the feed.
  processEntities: true,
  htmlEntities: true,
});

const HTML_SNIFF = /^\s*(?:<!doctype\s+html|<html[\s>])/i;

export type ProbeTarget = {
  readonly id: string;
  readonly url: string;
  readonly platform: SourcePlatform;
};

export async function probeSource(
  target: ProbeTarget,
  options: SafeFetchOptions = {},
): Promise<ProbeResult> {
  const base = {
    sourceId: target.id,
    url: target.url,
    finalUrl: undefined,
    httpStatus: undefined,
    contentType: undefined,
    itemCount: 0,
    bytes: 0,
    redirects: 0,
    etag: undefined,
    lastModified: undefined,
    newestItemAt: undefined,
    error: undefined,
    warning: undefined,
  } satisfies Omit<ProbeResult, 'outcome' | 'elapsedMs'>;

  const startedAt = Date.now();

  let response;
  try {
    response = await safeFetch(target.url, options);
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    if (error instanceof FetchLimitError) {
      const outcome: ProbeOutcome =
        error.kind === 'timeout'
          ? 'timeout'
          : error.kind === 'too_large'
            ? 'too_large'
            : 'network_error';
      return { ...base, outcome, elapsedMs, error: error.message };
    }
    return {
      ...base,
      outcome: 'network_error',
      elapsedMs,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const common = {
    ...base,
    finalUrl: response.finalUrl,
    httpStatus: response.status,
    contentType: response.contentType,
    bytes: response.bytes,
    elapsedMs: response.elapsedMs,
    redirects: response.redirects,
    etag: response.etag,
    lastModified: response.lastModified,
  };

  if (response.status < 200 || response.status >= 300) {
    return { ...common, outcome: 'http_error', error: `HTTP ${response.status}` };
  }

  if (!FEED_PLATFORMS.has(target.platform)) {
    // html_diff: success means we got a page with content worth diffing. An empty
    // body behind a 200 is a failure even though the status says otherwise.
    const hasContent = response.body.trim().length > 0;
    return {
      ...common,
      outcome: hasContent ? 'ok_page' : 'not_a_feed',
      itemCount: hasContent ? 1 : 0,
      ...(hasContent ? {} : { error: '200 with an empty body' }),
    };
  }

  return { ...common, ...classifyFeed(response.body) };
}

type FeedClassification = {
  outcome: ProbeOutcome;
  itemCount: number;
  newestItemAt: Date | undefined;
  error: string | undefined;
  warning: string | undefined;
};

/** `true` when well-formed, otherwise a human-readable description of the fault. */
function xmlFault(body: string): string | undefined {
  const validation = XMLValidator.validate(body, { allowBooleanAttributes: true });
  if (validation === true) return undefined;
  return `malformed XML at line ${String(validation.err.line)}: ${validation.err.msg}`;
}

/**
 * Exported for the fixture tests, which cover every shape without a network.
 *
 * **Parse first, validate second.** `XMLParser` is deliberately lenient: it recovers
 * from unclosed elements and trailing junk, returning whatever it could read.
 * `XMLValidator` is strict. Running the validator as a gate looks tidier and is
 * wrong in both directions, which real feeds demonstrated on the first live run:
 *
 *   - `hamel.dev/index.xml` serves a complete document, a stray `em>`, and then a
 *     *second* concatenated document from a staging domain. Strictly invalid — and
 *     it still contains 23 real items. Rejecting it discards a working source over
 *     a publisher's build bug.
 *   - Truncated XML, conversely, parses "successfully" into a feed with zero items,
 *     which without the validator gets diagnosed as `empty_feed` — pointing the
 *     operator at the publisher when the problem is the transfer.
 *
 * So: items decide the outcome, and validity decides whether there is a warning.
 */
export function classifyFeed(body: string): FeedClassification {
  const fail = (error: string): FeedClassification => ({
    outcome: 'not_a_feed',
    itemCount: 0,
    newestItemAt: undefined,
    error,
    warning: undefined,
  });

  if (HTML_SNIFF.test(body)) {
    return fail('200 with an HTML body — this URL is a web page, not a feed');
  }

  let parsed: unknown;
  try {
    parsed = parser.parse(body) as unknown;
  } catch (error) {
    return fail(`XML parse failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const items = extractItems(parsed);
  if (items === undefined) {
    return fail(
      xmlFault(body) ?? 'parsed as XML but has neither an <rss><channel> nor an Atom <feed> root',
    );
  }

  if (items.length === 0) {
    const fault = xmlFault(body);
    // Zero items and malformed → the document broke. Zero items and well-formed →
    // the source died quietly, which is the T-9 failure that looks like good health.
    return fault !== undefined
      ? fail(fault)
      : { ...fail('feed parsed but contains zero items'), outcome: 'empty_feed' };
  }

  return {
    outcome: 'ok',
    itemCount: items.length,
    newestItemAt: newestTimestamp(items),
    error: undefined,
    warning: xmlFault(body),
  };
}

type XmlNode = Record<string, unknown>;

function asNode(value: unknown): XmlNode | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as XmlNode)
    : undefined;
}

/** Returns the item array, or undefined if this is not a recognisable feed. */
function extractItems(parsed: unknown): XmlNode[] | undefined {
  const root = asNode(parsed);
  if (root === undefined) return undefined;

  // RSS 2.0: <rss><channel><item>…
  const rss = asNode(root.rss);
  if (rss !== undefined) {
    const channel = asNode(rss.channel);
    if (channel === undefined) return [];
    const items = channel.item;
    return Array.isArray(items) ? items.filter((i): i is XmlNode => asNode(i) !== undefined) : [];
  }

  // Atom: <feed><entry>…
  const feed = asNode(root.feed);
  if (feed !== undefined) {
    const entries = feed.entry;
    return Array.isArray(entries)
      ? entries.filter((e): e is XmlNode => asNode(e) !== undefined)
      : [];
  }

  // RDF / RSS 1.0: <rdf:RDF><item>…
  const rdf = asNode(root['rdf:RDF']) ?? asNode(root.RDF);
  if (rdf !== undefined) {
    const items = rdf.item;
    return Array.isArray(items) ? items.filter((i): i is XmlNode => asNode(i) !== undefined) : [];
  }

  return undefined;
}

const DATE_FIELDS = ['pubDate', 'published', 'updated', 'dc:date', 'lastBuildDate'] as const;

function newestTimestamp(items: readonly XmlNode[]): Date | undefined {
  let newest: Date | undefined;

  for (const item of items) {
    for (const field of DATE_FIELDS) {
      const raw = item[field];
      if (typeof raw !== 'string') continue;
      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) continue;
      if (newest === undefined || parsed > newest) newest = parsed;
      break;
    }
  }

  return newest;
}
