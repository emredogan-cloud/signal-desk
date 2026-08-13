import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classifyFeed, probeSource, isProbeSuccess } from './probe.js';

/**
 * ROADMAP.md Phase 2 TESTS:
 *   "Probe result parsing against fixtures including the '200 with HTML body' case
 *    that killed three candidate feeds during research."
 *
 * Fixtures are real recordings. A classifier tested only against hand-written XML
 * passes on XML nobody actually serves.
 */

const FIXTURES = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
const fixture = (path: string): string => readFileSync(`${FIXTURES}${path}`, 'utf8');

describe('classifyFeed — real recorded feeds', () => {
  it('accepts an RSS 2.0 feed and counts its items', () => {
    const result = classifyFeed(fixture('feeds/hn-frontpage.rss.xml'));
    expect(result.outcome).toBe('ok');
    expect(result.itemCount).toBeGreaterThan(20);
    expect(result.error).toBeUndefined();
  });

  it('accepts a GitHub commits Atom feed', () => {
    const result = classifyFeed(fixture('feeds/gh-x-algorithm.commits.atom.xml'));
    expect(result.outcome).toBe('ok');
    expect(result.itemCount).toBeGreaterThan(0);
  });

  it('accepts a Statuspage RSS history feed', () => {
    const result = classifyFeed(fixture('feeds/status-anthropic.rss.xml'));
    expect(result.outcome).toBe('ok');
    expect(result.itemCount).toBeGreaterThan(0);
  });

  it('accepts the Google Cloud Atom feed, which has a different shape', () => {
    // SOURCE-INTELLIGENCE.md §1c flags this one specifically: it is Atom where the
    // other status pages are RSS, and it carried a single item at probe time. A
    // one-item feed must not be mistaken for an empty one.
    const result = classifyFeed(fixture('feeds/status-google-cloud.atom.xml'));
    expect(result.outcome).toBe('ok');
    expect(result.itemCount).toBeGreaterThanOrEqual(1);
  });

  it('reads a timestamp out of the feed', () => {
    const result = classifyFeed(fixture('feeds/status-anthropic.rss.xml'));
    expect(result.newestItemAt).toBeInstanceOf(Date);
    expect(Number.isNaN(result.newestItemAt?.getTime() ?? Number.NaN)).toBe(false);
  });
});

describe('classifyFeed — the failure shapes', () => {
  it('rejects a 200 that serves an HTML page', () => {
    // The case the source document says "killed three candidate feeds during
    // research". Recorded from changelog.cursor.com/rss, which still answers 200
    // with a web page (re-verified 2026-08-13). A probe that checks only the status
    // code reports this as healthy forever.
    const result = classifyFeed(fixture('probe/two-hundred-with-html-body.html'));
    expect(result.outcome).toBe('not_a_feed');
    expect(result.itemCount).toBe(0);
    expect(result.error).toContain('HTML');
  });

  it('reports a feed that parses but has zero items as dead, not healthy', () => {
    // THREAT-MODEL.md §T-9: "a feed that parses but yields zero items is a failure,
    // not an empty day."
    const result = classifyFeed(fixture('probe/empty-feed.rss.xml'));
    expect(result.outcome).toBe('empty_feed');
    expect(result.itemCount).toBe(0);
  });

  it('rejects malformed XML that yields no items', () => {
    // Truncated mid-element. The lenient parser recovers a tree with zero items, so
    // without the validator this would be diagnosed as `empty_feed` — pointing the
    // operator at the publisher when the problem is the transfer.
    const result = classifyFeed(fixture('probe/malformed.xml'));
    expect(result.outcome).toBe('not_a_feed');
    expect(result.error).toContain('malformed XML');
  });

  it('accepts a malformed feed that still yields real items, and warns', () => {
    // Recorded from hamel.dev/index.xml, which serves a complete document, a stray
    // `em>`, and then a SECOND concatenated document from a staging domain. Strictly
    // invalid, and it still carries real items. Rejecting it would discard a working
    // source over a publisher's build bug; accepting it silently would hide the bug.
    const result = classifyFeed(fixture('probe/valid-items-trailing-garbage.xml'));
    expect(result.outcome).toBe('ok');
    expect(result.itemCount).toBeGreaterThan(0);
    expect(result.warning).toContain('malformed XML');
    expect(result.error).toBeUndefined();
  });

  it('leaves the warning unset for a clean feed', () => {
    expect(classifyFeed(fixture('feeds/hn-frontpage.rss.xml')).warning).toBeUndefined();
  });

  it('rejects JSON served where a feed was expected', () => {
    const result = classifyFeed(fixture('probe/not-a-feed.json'));
    expect(result.outcome).toBe('not_a_feed');
  });

  it('rejects an empty body', () => {
    expect(classifyFeed('').outcome).toBe('not_a_feed');
  });

  it('detects HTML regardless of leading whitespace or doctype casing', () => {
    expect(classifyFeed('\n\n  <!DOCTYPE HTML><html><body>hi</body></html>').outcome).toBe(
      'not_a_feed',
    );
    expect(classifyFeed('<html lang="en"><body>hi</body></html>').outcome).toBe('not_a_feed');
  });

  it('rejects well-formed XML that is not a feed at all', () => {
    const result = classifyFeed('<?xml version="1.0"?><sitemapindex><sitemap/></sitemapindex>');
    expect(result.outcome).toBe('not_a_feed');
    expect(result.error).toContain('neither');
  });

  it('counts a single-item feed as one item, not as an object', () => {
    // fast-xml-parser collapses a lone repeated element to a scalar unless told
    // otherwise. Without the isArray hint, a one-item feed silently counts as zero.
    const single = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
      <item><title>only item</title><pubDate>Mon, 11 Aug 2026 09:00:00 GMT</pubDate></item>
      </channel></rss>`;
    const result = classifyFeed(single);
    expect(result.outcome).toBe('ok');
    expect(result.itemCount).toBe(1);
  });
});

describe('probeSource — outcomes without a network', () => {
  const okFeed = fixture('feeds/hn-frontpage.rss.xml');

  function stubFetch(
    status: number,
    body: string,
    headers: Record<string, string> = {},
  ): typeof fetch {
    return () =>
      Promise.resolve(
        new Response(status === 304 ? null : body, {
          status,
          headers: { 'content-type': 'application/rss+xml', ...headers },
        }),
      );
  }

  const target = { id: 'test', url: 'https://example.test/feed.xml', platform: 'rss' } as const;

  it('reports a healthy feed', async () => {
    const result = await probeSource(target, { fetchImpl: stubFetch(200, okFeed) });
    expect(result.outcome).toBe('ok');
    expect(isProbeSuccess(result)).toBe(true);
    expect(result.itemCount).toBeGreaterThan(0);
    expect(result.httpStatus).toBe(200);
  });

  it('reports a non-2xx response as an http error', async () => {
    const result = await probeSource(target, { fetchImpl: stubFetch(404, '<html>gone</html>') });
    expect(result.outcome).toBe('http_error');
    expect(isProbeSuccess(result)).toBe(false);
    expect(result.error).toContain('404');
  });

  it('reports a rate limit as an http error rather than silence', async () => {
    const result = await probeSource(target, { fetchImpl: stubFetch(429, '') });
    expect(result.outcome).toBe('http_error');
  });

  it('captures conditional-request cache keys for the scheduler to reuse', async () => {
    const result = await probeSource(target, {
      fetchImpl: stubFetch(200, okFeed, {
        etag: 'W/"abc123"',
        'last-modified': 'Mon, 11 Aug 2026 09:00:00 GMT',
      }),
    });
    expect(result.etag).toBe('W/"abc123"');
    expect(result.lastModified).toBe('Mon, 11 Aug 2026 09:00:00 GMT');
  });

  it('never throws — a probe failure is a result, not an exception', async () => {
    const exploding = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    const result = await probeSource(target, { fetchImpl: exploding });
    expect(result.outcome).toBe('network_error');
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('treats an html_diff target as healthy when it returns a page', async () => {
    const result = await probeSource(
      { id: 'anthropic-news-diff', url: 'https://example.test/news', platform: 'html_diff' },
      { fetchImpl: stubFetch(200, '<!doctype html><html><body>news</body></html>') },
    );
    expect(result.outcome).toBe('ok_page');
    expect(isProbeSuccess(result)).toBe(true);
  });

  it('treats an empty body behind a 200 as a failure even for html_diff', async () => {
    const result = await probeSource(
      { id: 'anthropic-news-diff', url: 'https://example.test/news', platform: 'html_diff' },
      { fetchImpl: stubFetch(200, '   ') },
    );
    expect(result.outcome).toBe('not_a_feed');
  });
});
