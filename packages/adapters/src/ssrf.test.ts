import { describe, it, expect } from 'vitest';
import {
  assertFetchable,
  isBlockedAddress,
  allowlistFromUrls,
  SsrfBlockedError,
  type DnsResolver,
} from './ssrf.js';
import { safeFetch, FetchLimitError } from './http.js';

/**
 * THREAT-MODEL.md §5 test 3 — SSRF:
 *
 *   "URLs pointing at 127.0.0.1, 169.254.169.254, private ranges, and a redirect
 *    chain that ends at one — all rejected, including post-redirect."
 *
 * The redirect case is the one that matters. Checking only the URL you were given
 * catches the naive attempt and misses every real one, because an attacker who
 * controls a feed also controls a public hostname that can 302 wherever it likes.
 */

const resolvesTo =
  (map: Record<string, string[]>): DnsResolver =>
  (hostname) => {
    const addresses = map[hostname];
    return addresses === undefined
      ? Promise.reject(new Error(`ENOTFOUND ${hostname}`))
      : Promise.resolve(addresses);
  };

describe('isBlockedAddress', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'loopback range'],
    ['0.0.0.0', 'this network'],
    ['10.0.0.1', 'RFC1918'],
    ['172.16.5.4', 'RFC1918'],
    ['172.31.255.255', 'RFC1918 upper bound'],
    ['192.168.1.1', 'RFC1918'],
    ['169.254.169.254', 'cloud metadata endpoint'],
    ['169.254.0.1', 'link-local'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
  ])('blocks %s (%s)', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    ['1.1.1.1'],
    ['8.8.8.8'],
    ['140.82.121.4'], // github.com at time of writing
    ['172.15.255.255'], // just below the RFC1918 block
    ['172.32.0.0'], // just above it
    ['192.167.255.255'], // just below 192.168/16
  ])('allows the public address %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it.each([
    ['::1', 'IPv6 loopback'],
    ['::', 'unspecified'],
    ['fe80::1', 'link-local'],
    ['fc00::1', 'unique-local'],
    ['fd12:3456::1', 'unique-local'],
    ['ff02::1', 'multicast'],
  ])('blocks IPv6 %s (%s)', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it('unwraps IPv4-mapped IPv6 before judging it', () => {
    // ::ffff:127.0.0.1 is loopback wearing a different hat. A checker that only
    // pattern-matches IPv6 prefixes lets every private range through this door.
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedAddress('::ffff:169.254.169.254')).toBe(true);
    expect(isBlockedAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isBlockedAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('refuses anything that is not an IP address at all', () => {
    expect(isBlockedAddress('not-an-address')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });
});

describe('assertFetchable', () => {
  const resolver = resolvesTo({
    'example.test': ['93.184.216.34'],
    'evil.test': ['127.0.0.1'],
    'rebind.test': ['93.184.216.34', '169.254.169.254'],
    'metadata.test': ['169.254.169.254'],
  });

  it('allows a public host', async () => {
    await expect(
      assertFetchable('https://example.test/feed', { resolver }),
    ).resolves.toBeUndefined();
  });

  it('rejects a literal loopback address', async () => {
    await expect(assertFetchable('http://127.0.0.1:8080/admin', { resolver })).rejects.toThrow(
      SsrfBlockedError,
    );
  });

  it('rejects the cloud metadata endpoint', async () => {
    await expect(
      assertFetchable('http://169.254.169.254/latest/meta-data/', { resolver }),
    ).rejects.toThrow(/blocked range/);
  });

  it('rejects a public hostname that resolves to a private address', async () => {
    await expect(assertFetchable('https://evil.test/feed', { resolver })).rejects.toThrow(
      /resolves to 127\.0\.0\.1/,
    );
  });

  it('rejects a host where ANY resolved address is private', async () => {
    // DNS rebinding: one public answer and one private one. Which the socket picks
    // is not ours to predict, so both must be safe or neither is used.
    await expect(assertFetchable('https://rebind.test/feed', { resolver })).rejects.toThrow(
      /169\.254\.169\.254/,
    );
  });

  it.each(['file:///etc/passwd', 'gopher://example.test/', 'ftp://example.test/x'])(
    'rejects the scheme in %s',
    async (url) => {
      await expect(assertFetchable(url, { resolver })).rejects.toThrow(/scheme/);
    },
  );

  it('rejects a host outside the allowlist even when it is public', async () => {
    const allowedHosts = new Set(['example.test']);
    await expect(
      assertFetchable('https://somewhere-else.test/feed', { resolver, allowedHosts }),
    ).rejects.toThrow(/allowlist/);
  });

  it('allows an allowlisted host', async () => {
    const allowedHosts = new Set(['example.test']);
    await expect(
      assertFetchable('https://example.test/feed', { resolver, allowedHosts }),
    ).resolves.toBeUndefined();
  });

  it('rejects when DNS fails rather than proceeding', async () => {
    await expect(assertFetchable('https://nonexistent.test/', { resolver })).rejects.toThrow(
      /DNS resolution failed/,
    );
  });

  it('rejects a malformed URL', async () => {
    await expect(assertFetchable('not a url', { resolver })).rejects.toThrow(SsrfBlockedError);
  });
});

describe('the guard runs on every redirect hop', () => {
  it('rejects a redirect chain that ends at a private address', async () => {
    // The case THREAT-MODEL.md §5 test 3 names explicitly. The first URL is entirely
    // legitimate; the third hop is the metadata service.
    const resolver = resolvesTo({
      'public.test': ['93.184.216.34'],
      'still-public.test': ['93.184.216.34'],
      'metadata.test': ['169.254.169.254'],
    });

    const responses: Record<string, { status: number; headers?: Record<string, string> }> = {
      'https://public.test/feed': {
        status: 302,
        headers: { location: 'https://still-public.test/feed' },
      },
      'https://still-public.test/feed': {
        status: 302,
        headers: { location: 'https://metadata.test/latest/meta-data/' },
      },
      'https://metadata.test/latest/meta-data/': { status: 200 },
    };

    const reached: string[] = [];
    const fetchImpl = ((url: string) => {
      reached.push(url);
      const spec = responses[url];
      if (spec === undefined) return Promise.reject(new Error(`unexpected ${url}`));
      return Promise.resolve(
        new Response(spec.status === 200 ? 'secrets' : '', {
          status: spec.status,
          headers: spec.headers ?? {},
        }),
      );
    }) as unknown as typeof fetch;

    await expect(
      safeFetch('https://public.test/feed', {
        fetchImpl,
        guard: (url) => assertFetchable(url, { resolver }),
      }),
    ).rejects.toThrow(SsrfBlockedError);

    // Blocked before the request was made, not after reading the response.
    expect(reached).not.toContain('https://metadata.test/latest/meta-data/');
  });

  it('allows a redirect chain that stays public', async () => {
    const resolver = resolvesTo({
      'a.test': ['93.184.216.34'],
      'b.test': ['93.184.216.35'],
    });

    const fetchImpl = ((url: string) =>
      Promise.resolve(
        url === 'https://a.test/feed'
          ? new Response('', { status: 301, headers: { location: 'https://b.test/feed' } })
          : new Response('<rss/>', { status: 200 }),
      )) as unknown as typeof fetch;

    const result = await safeFetch('https://a.test/feed', {
      fetchImpl,
      guard: (url) => assertFetchable(url, { resolver }),
    });

    expect(result.finalUrl).toBe('https://b.test/feed');
  });

  it('still enforces the redirect cap alongside the guard', async () => {
    const resolver = resolvesTo({ 'loop.test': ['93.184.216.34'] });
    const fetchImpl = (() =>
      Promise.resolve(
        new Response('', { status: 302, headers: { location: 'https://loop.test/next' } }),
      )) as unknown as typeof fetch;

    await expect(
      safeFetch('https://loop.test/start', {
        fetchImpl,
        guard: (url) => assertFetchable(url, { resolver }),
      }),
    ).rejects.toThrow(FetchLimitError);
  });
});

describe('allowlistFromUrls', () => {
  it('extracts hostnames from registry URLs', () => {
    const hosts = allowlistFromUrls([
      'https://openai.com/news/rss.xml',
      'https://github.com/vercel/next.js/releases.atom',
      'https://openai.com/other',
    ]);
    expect(hosts).toEqual(new Set(['openai.com', 'github.com']));
  });

  it('skips a malformed URL instead of throwing', () => {
    // A bad registry URL is a seed-integrity problem with its own test. Throwing
    // here would take ingestion down for all 59 other sources.
    expect(allowlistFromUrls(['not a url', 'https://good.test/feed'])).toEqual(
      new Set(['good.test']),
    );
  });

  it('is empty for no input', () => {
    expect(allowlistFromUrls([])).toEqual(new Set());
  });
});
