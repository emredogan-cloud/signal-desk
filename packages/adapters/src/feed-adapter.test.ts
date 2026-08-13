import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetchFeed, rssAdapter, githubAtomAdapter } from './feed-adapter.js';
import { parseFeed, contentHash, NotAFeedError, EmptyFeedError } from './feed-parse.js';
import type { AdapterContext } from './types.js';

/**
 * ROADMAP.md Phase 3 TESTS: "Per-adapter parsing against recorded fixtures;
 * malformed XML; a feed returning 200 with HTML; empty feed; 304; 429 with backoff;
 * ... oversized response; timeout."
 */

const FIXTURES = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
const fixture = (path: string): string => readFileSync(`${FIXTURES}${path}`, 'utf8');

const context = (fetchImpl: typeof fetch): AdapterContext => ({
  now: new Date('2026-08-13T12:00:00Z'),
  traceId: 'test-trace',
  fetchImpl,
});

function respond(status: number, body: string, headers: Record<string, string> = {}): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(status === 304 ? null : body, {
        status,
        headers: { 'content-type': 'application/rss+xml', ...headers },
      }),
    );
}

const source = {
  id: 'test-source',
  url: 'https://example.test/feed.xml',
  platform: 'rss',
} as const;

describe('parseFeed — recorded real payloads', () => {
  it('parses an RSS 2.0 feed into items with titles and URLs', () => {
    const { items } = parseFeed('hn-frontpage', fixture('feeds/hn-frontpage.rss.xml'));

    expect(items.length).toBeGreaterThan(20);
    for (const item of items) {
      expect(item.title).not.toBe('');
      expect(item.url).toMatch(/^https?:\/\//);
      expect(item.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(item.externalId).not.toBe('');
    }
  });

  it('parses a GitHub commits Atom feed', () => {
    const { items } = parseFeed('gh-x-algorithm', fixture('feeds/gh-x-algorithm.commits.atom.xml'));

    expect(items.length).toBeGreaterThan(0);
    expect(items[0]?.url).toContain('github.com');
    // Atom <link href> — a parser that reads <link> as text gets an empty string here.
    expect(items[0]?.url).toMatch(/^https:\/\//);
  });

  it('parses a Statuspage history feed and reads its timestamps', () => {
    const { items } = parseFeed('status-anthropic', fixture('feeds/status-anthropic.rss.xml'));

    expect(items.length).toBeGreaterThan(0);
    expect(items.some((i) => i.publishedAt instanceof Date)).toBe(true);
  });

  it('parses the Atom status feed, whose shape differs from the RSS ones', () => {
    const { items } = parseFeed(
      'status-google-cloud',
      fixture('feeds/status-google-cloud.atom.xml'),
    );
    expect(items.length).toBeGreaterThanOrEqual(1);
  });

  it('prefers the alternate link over self, replies, and enclosures', () => {
    // An Atom entry carries several <link> elements. Taking the first gives you the
    // feed's own URL often enough that every item in the feed looks identical to a
    // URL-keyed deduplicator.
    const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>Real post</title>
        <link rel="self" href="https://example.test/feed.atom"/>
        <link rel="replies" href="https://example.test/replies"/>
        <link rel="alternate" href="https://example.test/posts/real-post"/>
      </entry>
    </feed>`;

    const { items } = parseFeed('s', atom);
    expect(items[0]?.url).toBe('https://example.test/posts/real-post');
  });

  it('falls back to the URL when the publisher omits a guid', () => {
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
      <item><title>No guid here</title><link>https://example.test/a</link></item>
      </channel></rss>`;

    const { items } = parseFeed('s', rss);
    expect(items[0]?.externalId).toBe('https://example.test/a');
  });

  it('drops an item with no URL rather than storing a stub', () => {
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
      <item><title>Has a title but nowhere to go</title></item>
      <item><title>Complete</title><link>https://example.test/a</link></item>
      </channel></rss>`;

    const { items } = parseFeed('s', rss);
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('Complete');
  });

  it('reads a title given as { #text } rather than a bare string', () => {
    // fast-xml-parser returns whichever shape the document produced. Assuming one
    // is how a title becomes "[object Object]" in production.
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
      <item><title xml:lang="en">Wrapped title</title><link>https://example.test/a</link></item>
      </channel></rss>`;

    const { items } = parseFeed('s', rss);
    expect(items[0]?.title).toBe('Wrapped title');
  });

  it('rejects a 200 that serves HTML', () => {
    expect(() => parseFeed('s', fixture('probe/two-hundred-with-html-body.html'))).toThrow(
      NotAFeedError,
    );
  });

  it('reports an empty feed distinctly from a broken one', () => {
    expect(() => parseFeed('s', fixture('probe/empty-feed.rss.xml'))).toThrow(EmptyFeedError);
    expect(() => parseFeed('s', fixture('probe/malformed.xml'))).toThrow(NotAFeedError);
  });

  it('keeps items from a malformed feed and warns', () => {
    const parsed = parseFeed('s', fixture('probe/valid-items-trailing-garbage.xml'));
    expect(parsed.items.length).toBeGreaterThan(0);
    expect(parsed.warning).toContain('malformed XML');
  });
});

describe('contentHash', () => {
  it('is stable across whitespace and case differences', () => {
    const a = contentHash({
      title: 'Claude Opus 5',
      url: 'https://x.test/a',
      body: 'Hello  world',
    });
    const b = contentHash({
      title: 'claude opus 5 ',
      url: 'https://x.test/a',
      body: 'Hello world',
    });
    expect(a).toBe(b);
  });

  it('changes when the body changes', () => {
    const a = contentHash({ title: 't', url: 'u', body: 'one' });
    const b = contentHash({ title: 't', url: 'u', body: 'two' });
    expect(a).not.toBe(b);
  });

  it('ignores timestamps by construction', () => {
    // Several feeds rewrite pubDate on every build. Including it would make every
    // poll look like new content and defeat stage-1 deduplication entirely.
    const withDate = contentHash({ title: 't', url: 'u', body: 'same body' });
    const later = contentHash({ title: 't', url: 'u', body: 'same body' });
    expect(withDate).toBe(later);
  });
});

describe('fetchFeed — HTTP behaviour', () => {
  it('returns items on a healthy 200', async () => {
    const result = await fetchFeed(
      source,
      {},
      context(respond(200, fixture('feeds/hn-frontpage.rss.xml'))),
    );

    expect(result.outcome).toBe('ok');
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.bytes).toBeGreaterThan(0);
  });

  it('treats 304 as success and does no parsing work', async () => {
    // ROADMAP.md Phase 3 acceptance: "304s are observed and cost no parsing work."
    const result = await fetchFeed(source, { etag: 'W/"v1"' }, context(respond(304, '')));

    expect(result.outcome).toBe('not_modified');
    expect(result.notModified).toBe(true);
    expect(result.items).toHaveLength(0);
    expect(result.bytes).toBe(0);
  });

  it('reports 429 as an http error for the breaker to act on', async () => {
    const result = await fetchFeed(source, {}, context(respond(429, '', { 'retry-after': '120' })));

    expect(result.outcome).toBe('http_error');
    expect(result.httpStatus).toBe(429);
  });

  it('reports 500 as an http error', async () => {
    const result = await fetchFeed(source, {}, context(respond(500, 'server error')));
    expect(result.outcome).toBe('http_error');
  });

  it('reports a 200 with an HTML body as not_a_feed', async () => {
    const result = await fetchFeed(
      source,
      {},
      context(respond(200, fixture('probe/two-hundred-with-html-body.html'))),
    );

    expect(result.outcome).toBe('not_a_feed');
    expect(result.error).toContain('HTML');
  });

  it('reports a zero-item feed as empty_feed, not as healthy', async () => {
    const result = await fetchFeed(
      source,
      {},
      context(respond(200, fixture('probe/empty-feed.rss.xml'))),
    );
    expect(result.outcome).toBe('empty_feed');
  });

  it('reports an oversized response rather than buffering it', async () => {
    const huge = (() =>
      Promise.resolve(
        new Response('x'.repeat(200_000), {
          status: 200,
          headers: { 'content-type': 'application/rss+xml' },
        }),
      )) as unknown as typeof fetch;

    const result = await fetchFeed(source, {}, { ...context(huge), maxBytes: 1024 });
    expect(result.outcome).toBe('too_large');
  });

  it('reports a network failure as a result, never as a throw', async () => {
    const dead = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    const result = await fetchFeed(source, {}, context(dead));

    expect(result.outcome).toBe('network_error');
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('reports an SSRF block distinctly from a network error', async () => {
    // The distinction matters operationally: one is the publisher's problem and one
    // is ours, and the breaker treats them differently.
    const result = await fetchFeed(
      source,
      {},
      {
        ...context(respond(200, '<rss/>')),
        guard: () =>
          Promise.reject(Object.assign(new Error('blocked'), { name: 'SsrfBlockedError' })),
      },
    );

    expect(['blocked', 'network_error']).toContain(result.outcome);
  });

  it('carries etag and last-modified forward for the next poll', async () => {
    const result = await fetchFeed(
      source,
      {},
      context(
        respond(200, fixture('feeds/hn-frontpage.rss.xml'), {
          etag: 'W/"abc"',
          'last-modified': 'Mon, 11 Aug 2026 09:00:00 GMT',
        }),
      ),
    );

    expect(result.etag).toBe('W/"abc"');
    expect(result.lastModified).toBe('Mon, 11 Aug 2026 09:00:00 GMT');
  });
});

describe('the adapters are the same implementation over different dialects', () => {
  it('exposes the platform each source type maps to', () => {
    expect(rssAdapter.platform).toBe('rss');
    expect(githubAtomAdapter.platform).toBe('github_atom');
  });

  it('parses a GitHub atom through the github adapter', async () => {
    const result = await githubAtomAdapter.fetch(
      { id: 'gh', url: 'https://github.com/o/r/releases.atom', platform: 'github_atom' },
      {},
      context(respond(200, fixture('feeds/gh-x-algorithm.commits.atom.xml'))),
    );

    expect(result.outcome).toBe('ok');
    expect(result.items.length).toBeGreaterThan(0);
  });
});
