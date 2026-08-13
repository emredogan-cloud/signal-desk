import { randomUUID } from 'node:crypto';
import {
  listSources,
  insertRawItems,
  recordFetchAttempt,
  recordFetchLog,
  recordBreakerState,
  type Db,
  type SourceRow,
} from '@signal-desk/db';
import {
  isCircuitOpen,
  onSuccess,
  onFailure,
  isDue,
  jitteredIntervalMs,
  countsAsTransportFailure,
  isSuccess,
  assertFetchable,
  allowlistFromUrls,
  type AdapterRegistry,
  type AdapterResult,
  type DnsResolver,
} from '@signal-desk/adapters';
import { withTrace, type Logger } from '@signal-desk/shared';

/**
 * One fetch, end to end: decide → fetch → store → record.
 *
 * The order matters and is not obvious. Telemetry is written **before** the items,
 * and on every path including failure, because THREAT-MODEL.md §T-9 is about the
 * failure that leaves no trace. A run that crashes after fetching but before logging
 * looks, from the freshness panel, exactly like a run that never happened.
 */

export type IngestOptions = {
  readonly db: Db;
  readonly registry: AdapterRegistry;
  readonly logger: Logger;
  readonly now?: Date;
  /** Injected in tests. */
  readonly fetchImpl?: typeof fetch | undefined;
  readonly resolver?: DnsResolver | undefined;
  readonly githubToken?: string | undefined;
  /** Skip the due-time check and fetch everything. Used by `ingest:once`. */
  readonly force?: boolean;
  readonly random?: () => number;
};

export type SourceIngestResult = {
  readonly source: SourceRow;
  readonly result: AdapterResult | undefined;
  readonly itemsNew: number;
  readonly skipped: 'not_due' | 'circuit_open' | undefined;
};

export type IngestRunSummary = {
  readonly startedAt: Date;
  readonly durationMs: number;
  readonly considered: number;
  readonly fetched: number;
  readonly skippedNotDue: number;
  readonly skippedCircuitOpen: number;
  readonly notModified: number;
  readonly itemsFound: number;
  readonly itemsNew: number;
  readonly failures: number;
  readonly results: readonly SourceIngestResult[];
};

/**
 * The host allowlist, derived from the registry itself. THREAT-MODEL.md §T-6:
 * "an allowlist of fetchable hosts derived from the source registry".
 *
 * Rebuilt per run rather than cached, so a source added by `sources:add` becomes
 * fetchable without a restart — and, more importantly, a source *removed* stops
 * being fetchable immediately.
 */
export function buildAllowlist(db: Db): Set<string> {
  return allowlistFromUrls(listSources(db).map((s) => s.url));
}

export async function ingestSource(
  source: SourceRow,
  options: IngestOptions,
): Promise<SourceIngestResult> {
  const now = options.now ?? new Date();
  const traceId = randomUUID();
  const logger = withTrace(options.logger, traceId);
  const startedAt = Date.now();

  const allowedHosts = buildAllowlist(options.db);
  const adapter = options.registry.for(source);

  const result = await adapter.fetch(
    { id: source.id, url: source.url, platform: source.platform },
    { etag: source.etag ?? undefined, lastModified: source.lastModified ?? undefined },
    {
      now,
      traceId,
      guard: (url) => assertFetchable(url, { allowedHosts, resolver: options.resolver }),
      fetchImpl: options.fetchImpl,
      githubToken: options.githubToken,
    },
  );

  const durationMs = Date.now() - startedAt;
  let itemsNew = 0;

  if (result.outcome === 'ok' && result.items.length > 0) {
    const insertion = insertRawItems(options.db, result.items, {
      fetchedAt: now,
      traceId,
      httpStatus: result.httpStatus,
    });
    itemsNew = insertion.inserted;
  }

  recordFetchLog(options.db, {
    sourceId: source.id,
    startedAt: now,
    durationMs,
    outcome: result.outcome,
    httpStatus: result.httpStatus ?? null,
    itemsFound: result.items.length,
    itemsNew,
    bytes: result.bytes,
    notModified: result.notModified,
    error: result.error ?? null,
    traceId,
  });

  recordFetchAttempt(
    options.db,
    source.id,
    {
      succeeded: isSuccess(result.outcome),
      itemCount: itemsNew,
      etag: result.etag,
      lastModified: result.lastModified,
    },
    now,
  );

  // A 304 is a success: the source answered, and it answered efficiently. Treating
  // it as a failure would trip the breaker on the healthiest sources in the registry.
  const breakerBefore = {
    consecutiveFailures: source.consecutiveFailures,
    circuitOpenUntil: source.circuitOpenUntil,
  };
  const breakerAfter = countsAsTransportFailure(result.outcome)
    ? onFailure(breakerBefore, now)
    : onSuccess();

  recordBreakerState(options.db, source.id, breakerAfter, result.error ?? null, now);

  if (result.outcome === 'ok') {
    logger.info(
      {
        source_id: source.id,
        items_found: result.items.length,
        items_new: itemsNew,
        bytes: result.bytes,
        duration_ms: durationMs,
      },
      'ingested',
    );
  } else if (result.outcome === 'not_modified') {
    logger.debug({ source_id: source.id, duration_ms: durationMs }, 'not modified (304)');
  } else {
    // Never silent. §36 of the working brief, and the reason T-9 is rated HIGH
    // likelihood: a source that fails quietly is one the operator believes is working.
    logger.warn(
      {
        source_id: source.id,
        priority: source.priority,
        outcome: result.outcome,
        http_status: result.httpStatus,
        consecutive_failures: breakerAfter.consecutiveFailures,
        circuit_open_until: breakerAfter.circuitOpenUntil?.toISOString() ?? null,
      },
      `fetch failed: ${result.error ?? result.outcome}`,
    );
  }

  if (result.warning !== undefined) {
    logger.warn({ source_id: source.id }, `source works but is malformed: ${result.warning}`);
  }

  return { source, result, itemsNew, skipped: undefined };
}

/** One pass over every active source that is due. */
export async function ingestOnce(options: IngestOptions): Promise<IngestRunSummary> {
  const now = options.now ?? new Date();
  const random = options.random ?? Math.random;
  const startedAt = now;
  const runStart = Date.now();

  const sources = listSources(options.db, { activeOnly: true });
  const results: SourceIngestResult[] = [];

  for (const source of sources) {
    if (
      isCircuitOpen(
        {
          consecutiveFailures: source.consecutiveFailures,
          circuitOpenUntil: source.circuitOpenUntil,
        },
        now,
      )
    ) {
      options.logger.debug(
        { source_id: source.id, until: source.circuitOpenUntil?.toISOString() },
        'skipped: circuit open',
      );
      results.push({ source, result: undefined, itemsNew: 0, skipped: 'circuit_open' });
      continue;
    }

    if (options.force !== true) {
      const jitter =
        jitteredIntervalMs(source.pollIntervalSec, random) - source.pollIntervalSec * 1000;
      if (!isDue(source, now, jitter)) {
        results.push({ source, result: undefined, itemsNew: 0, skipped: 'not_due' });
        continue;
      }
    }

    results.push(await ingestSource(source, { ...options, now }));
  }

  const fetched = results.filter((r) => r.skipped === undefined);

  return {
    startedAt,
    durationMs: Date.now() - runStart,
    considered: sources.length,
    fetched: fetched.length,
    skippedNotDue: results.filter((r) => r.skipped === 'not_due').length,
    skippedCircuitOpen: results.filter((r) => r.skipped === 'circuit_open').length,
    notModified: fetched.filter((r) => r.result?.notModified === true).length,
    itemsFound: fetched.reduce((sum, r) => sum + (r.result?.items.length ?? 0), 0),
    itemsNew: fetched.reduce((sum, r) => sum + r.itemsNew, 0),
    failures: fetched.filter((r) => r.result !== undefined && !isSuccess(r.result.outcome)).length,
    results,
  };
}
