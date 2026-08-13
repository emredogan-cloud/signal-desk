import type { SourcePlatform } from '@signal-desk/shared';

/**
 * The adapter contract. ROADMAP.md Phase 3: `fetch(source, cursor) → RawItem[]`.
 *
 * Every adapter returns the same shape regardless of what it talked to, which is
 * what lets the scheduler, the fetch log, and the `raw_items` writer stay ignorant
 * of source types — and what lets a mock twin be a drop-in replacement.
 */

/** What an adapter needs to know about a source. Deliberately not the whole row. */
export type AdapterSource = {
  readonly id: string;
  readonly url: string;
  readonly platform: SourcePlatform;
};

/** Conditional-request state carried between polls. A 304 costs no parsing work. */
export type FetchCursor = {
  readonly etag?: string | undefined;
  readonly lastModified?: string | undefined;
};

/**
 * One fetched item, before sanitisation.
 *
 * `body` and `title` are **untrusted** and stored verbatim. Sanitisation happens in
 * Phase 4, downstream of storage, so that `raw_items` keeps what actually arrived
 * and a sanitiser bug can be fixed retroactively (ARCHITECTURE.md §7).
 */
export type RawItem = {
  readonly sourceId: string;
  /** The publisher's own id — `<guid>`, `<id>`. Falls back to the URL. */
  readonly externalId: string;
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly author: string | undefined;
  readonly publishedAt: Date | undefined;
  readonly contentHash: string;
  /** The original serialised item, kept for replay after a parser fix. */
  readonly rawPayload: string;
};

export type FetchOutcome =
  | 'ok'
  | 'not_modified'
  | 'http_error'
  | 'not_a_feed'
  | 'empty_feed'
  | 'network_error'
  | 'timeout'
  | 'too_large'
  | 'blocked'
  | 'skipped_circuit_open'
  | 'skipped_robots';

export type AdapterResult = {
  readonly outcome: FetchOutcome;
  readonly items: readonly RawItem[];
  readonly httpStatus: number | undefined;
  readonly etag: string | undefined;
  readonly lastModified: string | undefined;
  readonly bytes: number;
  readonly elapsedMs: number;
  readonly notModified: boolean;
  readonly error: string | undefined;
  readonly warning: string | undefined;
};

export type AdapterContext = {
  readonly now: Date;
  readonly traceId: string;
  /** Applied to the initial URL and every redirect hop. */
  readonly guard?: ((url: string) => Promise<void>) | undefined;
  /** Injected in tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxBytes?: number | undefined;
  /** Optional. Raises the GitHub REST limit from 60/hour to 5000/hour. */
  readonly githubToken?: string | undefined;
};

export type SourceAdapter = {
  readonly platform: SourcePlatform;
  fetch(
    source: AdapterSource,
    cursor: FetchCursor,
    context: AdapterContext,
  ): Promise<AdapterResult>;
};

export function isSuccess(outcome: FetchOutcome): boolean {
  return outcome === 'ok' || outcome === 'not_modified';
}

/**
 * Failures that should count against the circuit breaker.
 *
 * `not_a_feed` and `empty_feed` are deliberately excluded: they mean the source is
 * *reachable* and its content is wrong, which is a registry problem for a human to
 * look at, not a reason to stop asking. Backing off there would hide the fault
 * behind an open breaker instead of surfacing it on the freshness panel.
 */
export function countsAsTransportFailure(outcome: FetchOutcome): boolean {
  return (
    outcome === 'http_error' ||
    outcome === 'network_error' ||
    outcome === 'timeout' ||
    outcome === 'too_large'
  );
}
