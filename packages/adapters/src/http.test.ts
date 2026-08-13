import { describe, it, expect } from 'vitest';
import { safeFetch, FetchLimitError, USER_AGENT } from './http.js';

/**
 * The resource limits. THREAT-MODEL.md §T-6's SSRF controls land in Phase 3; these
 * are the limits without which one misbehaving feed hangs or exhausts the worker.
 */

function respondWith(
  responses: Record<string, { status: number; headers?: Record<string, string>; body?: string }>,
): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = ((url: string, init?: RequestInit) => {
    calls.push(url);
    const spec = responses[url];
    if (spec === undefined) return Promise.reject(new Error(`unexpected fetch: ${url}`));
    void init;
    return Promise.resolve(
      new Response(spec.status === 304 ? null : (spec.body ?? ''), {
        status: spec.status,
        headers: spec.headers ?? {},
      }),
    );
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

describe('safeFetch — identity and headers', () => {
  it('sends a User-Agent that names the project and links the repository', () => {
    // THREAT-MODEL.md §T-8: a descriptive User-Agent is part of not getting blocked,
    // and part of being a good citizen of feeds nobody is paid to serve.
    expect(USER_AGENT).toContain('signal-desk');
    expect(USER_AGENT).toContain('https://github.com/');
  });

  it('sends conditional-request headers when cache keys are known', async () => {
    let seen: Headers | undefined;
    const fetchImpl = ((_url: string, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      // 304 is a null-body status; constructing a Response with any body — even an
      // empty string — throws.
      return Promise.resolve(new Response(null, { status: 304 }));
    }) as unknown as typeof fetch;

    await safeFetch('https://example.test/feed', {
      fetchImpl,
      etag: 'W/"v1"',
      lastModified: 'Mon, 11 Aug 2026 09:00:00 GMT',
    });

    expect(seen?.get('if-none-match')).toBe('W/"v1"');
    expect(seen?.get('if-modified-since')).toBe('Mon, 11 Aug 2026 09:00:00 GMT');
  });

  it('reports 304 as notModified with no body to parse', async () => {
    const { fetchImpl } = respondWith({ 'https://example.test/feed': { status: 304 } });
    const result = await safeFetch('https://example.test/feed', { fetchImpl });

    expect(result.notModified).toBe(true);
    expect(result.body).toBe('');
    expect(result.bytes).toBe(0);
  });
});

describe('safeFetch — redirects', () => {
  it('follows a redirect and reports the final URL', async () => {
    const { fetchImpl, calls } = respondWith({
      'https://example.test/a': { status: 301, headers: { location: 'https://example.test/b' } },
      'https://example.test/b': { status: 200, body: 'landed' },
    });

    const result = await safeFetch('https://example.test/a', { fetchImpl });

    expect(result.body).toBe('landed');
    expect(result.finalUrl).toBe('https://example.test/b');
    expect(result.redirects).toBe(1);
    expect(calls).toEqual(['https://example.test/a', 'https://example.test/b']);
  });

  it('resolves a relative Location header', async () => {
    const { fetchImpl } = respondWith({
      'https://example.test/a': { status: 302, headers: { location: '/b' } },
      'https://example.test/b': { status: 200, body: 'landed' },
    });

    const result = await safeFetch('https://example.test/a', { fetchImpl });
    expect(result.finalUrl).toBe('https://example.test/b');
  });

  it('refuses to follow more than the redirect cap', async () => {
    // THREAT-MODEL.md §T-6 caps redirects at 3. An unbounded chain is both a hang
    // and, once Phase 3 follows content URLs, an SSRF laundering technique.
    const { fetchImpl } = respondWith({
      'https://example.test/1': { status: 302, headers: { location: 'https://example.test/2' } },
      'https://example.test/2': { status: 302, headers: { location: 'https://example.test/3' } },
      'https://example.test/3': { status: 302, headers: { location: 'https://example.test/4' } },
      'https://example.test/4': { status: 302, headers: { location: 'https://example.test/5' } },
      'https://example.test/5': { status: 200, body: 'too far' },
    });

    await expect(safeFetch('https://example.test/1', { fetchImpl })).rejects.toThrow(
      FetchLimitError,
    );
  });

  it('does not loop forever on a self-redirect', async () => {
    const { fetchImpl } = respondWith({
      'https://example.test/loop': {
        status: 302,
        headers: { location: 'https://example.test/loop' },
      },
    });

    await expect(safeFetch('https://example.test/loop', { fetchImpl })).rejects.toThrow(
      /redirects/,
    );
  });

  it('treats a redirect with no Location as a response, not a crash', async () => {
    const { fetchImpl } = respondWith({ 'https://example.test/x': { status: 302 } });
    const result = await safeFetch('https://example.test/x', { fetchImpl });
    expect(result.status).toBe(302);
  });
});

describe('safeFetch — resource limits', () => {
  it('refuses a response whose declared content-length exceeds the cap', async () => {
    const { fetchImpl } = respondWith({
      'https://example.test/big': {
        status: 200,
        headers: { 'content-length': '99999999' },
        body: 'x',
      },
    });

    await expect(
      safeFetch('https://example.test/big', { fetchImpl, maxBytes: 1024 }),
    ).rejects.toThrow(/exceeds cap/);
  });

  it('refuses a response that exceeds the cap while streaming, with no content-length', async () => {
    // content-length is a claim by the server. A hostile or broken one can omit it
    // or lie, so the cap is enforced against bytes actually read.
    const { fetchImpl } = respondWith({
      'https://example.test/big': { status: 200, body: 'x'.repeat(5000) },
    });

    await expect(
      safeFetch('https://example.test/big', { fetchImpl, maxBytes: 1024 }),
    ).rejects.toThrow(/exceeded cap/);
  });

  it('accepts a response just under the cap', async () => {
    const { fetchImpl } = respondWith({
      'https://example.test/ok': { status: 200, body: 'x'.repeat(500) },
    });

    const result = await safeFetch('https://example.test/ok', { fetchImpl, maxBytes: 1024 });
    expect(result.bytes).toBe(500);
  });

  it('rejects a non-HTTP scheme', async () => {
    const { fetchImpl } = respondWith({});
    await expect(safeFetch('file:///etc/passwd', { fetchImpl })).rejects.toThrow(/scheme/);
    await expect(safeFetch('gopher://example.test/', { fetchImpl })).rejects.toThrow(/scheme/);
  });

  it('rejects a URL that is not absolute', async () => {
    const { fetchImpl } = respondWith({});
    await expect(safeFetch('/relative/path', { fetchImpl })).rejects.toThrow(FetchLimitError);
  });

  it('aborts a request that exceeds the timeout', async () => {
    // The stub honours init.signal, as a real fetch does. A stub that ignores it
    // would make this test pass on the harness timeout instead of on the abort,
    // which proves nothing about safeFetch.
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('should have been aborted first'));
        }, 30_000);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      })) as unknown as typeof fetch;

    const startedAt = Date.now();
    await expect(
      safeFetch('https://example.test/slow', { fetchImpl: hang, timeoutMs: 50 }),
    ).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });
});
