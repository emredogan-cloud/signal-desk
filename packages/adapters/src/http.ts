/**
 * The one place this system makes an outbound request.
 *
 * Phase 2 lands the resource limits — timeout, response size cap, redirect cap —
 * because the probe needs them and because a fetch without them is how one
 * misbehaving feed hangs the worker. THREAT-MODEL.md §T-6's SSRF controls (host
 * allowlist, private-range blocking, per-hop re-checking) land in Phase 3, when the
 * system starts following URLs discovered *inside* content. Everything fetched here
 * comes from the source registry, which §2 places on the TRUSTED side of the
 * boundary.
 */

/** Identifies the project and links the repository, per THREAT-MODEL.md §T-8. */
export const USER_AGENT =
  'signal-desk/0.1 (+https://github.com/emredogan-cloud/signal-desk) personal intelligence tool';

export const DEFAULT_TIMEOUT_MS = 20_000;
/** Large enough for arXiv's 344-item feed and Anthropic's 1.6MB docs page. */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
/** THREAT-MODEL.md §T-6. */
export const MAX_REDIRECTS = 3;

export class FetchLimitError extends Error {
  readonly kind: 'timeout' | 'too_large' | 'too_many_redirects' | 'bad_scheme';
  constructor(kind: FetchLimitError['kind'], message: string) {
    super(message);
    this.name = 'FetchLimitError';
    this.kind = kind;
  }
}

export type SafeFetchOptions = {
  /**
   * SSRF guard, applied to the initial URL and to every redirect target.
   * THREAT-MODEL.md §T-6: "re-checked on every redirect hop". Omitting it is only
   * correct where the URL comes from the registry and cannot be attacker-chosen.
   */
  readonly guard?: ((url: string) => Promise<void>) | undefined;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  /** Conditional-request cache keys. A 304 costs no parsing work. */
  readonly etag?: string | undefined;
  readonly lastModified?: string | undefined;
  readonly signal?: AbortSignal;
  /** Merged over the defaults. Used for GitHub's API version and authorization. */
  readonly extraHeaders?: Record<string, string> | undefined;
  /** Injected in tests. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
};

export type SafeFetchResult = {
  readonly status: number;
  readonly finalUrl: string;
  readonly contentType: string | undefined;
  readonly etag: string | undefined;
  readonly lastModified: string | undefined;
  /** Empty for 304 and for HEAD-like responses. */
  readonly body: string;
  readonly bytes: number;
  readonly elapsedMs: number;
  readonly redirects: number;
  /** True when the server answered 304 and there is nothing new to parse. */
  readonly notModified: boolean;
  /**
   * `x-ratelimit-*`, when the server sends them. Surfaced rather than swallowed
   * because GitHub's 60/hour unauthenticated ceiling is a budget the caller has to
   * track, and discovering it by receiving a 403 wastes the request that found out.
   */
  readonly rateLimitHeaders: Record<string, string | undefined> | undefined;
};

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/**
 * Fetch with hard limits, following redirects manually so each hop can be counted
 * — and, from Phase 3, re-checked against the SSRF rules. `redirect: 'follow'` hides
 * the hop chain, which is exactly what an SSRF payload wants.
 */
export async function safeFetch(
  url: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const doFetch = options.fetchImpl ?? fetch;

  const startedAt = Date.now();
  let currentUrl = url;
  let redirects = 0;

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new FetchLimitError('timeout', `timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  if (options.signal !== undefined) {
    options.signal.addEventListener('abort', () => {
      controller.abort();
    });
  }

  try {
    for (;;) {
      const parsed = parseUrlOrThrow(currentUrl);
      if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
        throw new FetchLimitError('bad_scheme', `refusing to fetch scheme "${parsed.protocol}"`);
      }

      // Inside the loop, so it runs again for every redirect target. A 302 into the
      // cloud metadata service is the whole reason redirects are followed manually.
      if (options.guard !== undefined) {
        await options.guard(currentUrl);
      }

      const headers: Record<string, string> = {
        'user-agent': USER_AGENT,
        accept:
          'application/atom+xml, application/rss+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5',
        'accept-encoding': 'gzip, deflate',
      };
      if (redirects === 0 && options.etag !== undefined) headers['if-none-match'] = options.etag;
      if (redirects === 0 && options.lastModified !== undefined) {
        headers['if-modified-since'] = options.lastModified;
      }
      if (options.extraHeaders !== undefined) {
        Object.assign(headers, options.extraHeaders);
      }

      const response = await doFetch(currentUrl, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });

      if (isRedirect(response.status)) {
        const location = response.headers.get('location');
        if (location === null || location === '') {
          // A redirect with nowhere to go is a broken response, not a redirect loop.
          return finish(response, currentUrl, '', 0, startedAt, redirects, false);
        }
        redirects += 1;
        if (redirects > maxRedirects) {
          throw new FetchLimitError(
            'too_many_redirects',
            `exceeded ${maxRedirects} redirects, last hop ${location}`,
          );
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      if (response.status === 304) {
        return finish(response, currentUrl, '', 0, startedAt, redirects, true);
      }

      const { text, bytes } = await readCapped(response, maxBytes);
      return finish(response, currentUrl, text, bytes, startedAt, redirects, false);
    }
  } finally {
    clearTimeout(timer);
  }
}

function parseUrlOrThrow(url: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new FetchLimitError('bad_scheme', `not a valid absolute URL: ${url}`);
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function finish(
  response: Response,
  finalUrl: string,
  body: string,
  bytes: number,
  startedAt: number,
  redirects: number,
  notModified: boolean,
): SafeFetchResult {
  return {
    status: response.status,
    finalUrl,
    contentType: response.headers.get('content-type') ?? undefined,
    etag: response.headers.get('etag') ?? undefined,
    lastModified: response.headers.get('last-modified') ?? undefined,
    body,
    bytes,
    elapsedMs: Date.now() - startedAt,
    redirects,
    notModified,
    rateLimitHeaders: rateLimitHeaders(response),
  };
}

const RATE_LIMIT_HEADERS = [
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-ratelimit-used',
  'retry-after',
] as const;

function rateLimitHeaders(response: Response): Record<string, string | undefined> | undefined {
  const found: Record<string, string | undefined> = {};
  let any = false;
  for (const name of RATE_LIMIT_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) {
      found[name] = value;
      any = true;
    }
  }
  return any ? found : undefined;
}

/**
 * Read the body, aborting past `maxBytes`.
 *
 * Streamed rather than `await response.text()` because the point is to *not* buffer
 * an unbounded response. Checking `content-length` alone is insufficient: it is a
 * claim by the server, and a hostile or broken one can omit it or lie.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; bytes: number }> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const claimed = Number.parseInt(declared, 10);
    if (Number.isFinite(claimed) && claimed > maxBytes) {
      throw new FetchLimitError('too_large', `content-length ${claimed} exceeds cap ${maxBytes}`);
    }
  }

  if (response.body === null) return { text: '', bytes: 0 };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;

  try {
    for (;;) {
      // Annotated rather than inferred: the stream element type reaches us as `any`
      // through undici's Response, and an unchecked `any` here would silently accept
      // whatever the transport hands over — in the one function whose job is to
      // bound untrusted input.
      const { done, value } = (await reader.read()) as {
        done: boolean;
        value?: Uint8Array;
      };
      if (done) break;
      if (value === undefined) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        throw new FetchLimitError('too_large', `response exceeded cap ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { text: new TextDecoder('utf-8').decode(merged), bytes };
}
