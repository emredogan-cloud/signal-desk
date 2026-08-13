import { describe, it, expect, beforeEach } from 'vitest';
import {
  openDatabase,
  runMigrations,
  seedAll,
  listSources,
  countRawItems,
  duplicateExternalIds,
  getSource,
  recentRawItems,
  recentFetches,
  MIGRATIONS_FOLDER,
  type DatabaseHandle,
} from '@signal-desk/db';
import { createAdapterRegistry, DEFAULT_BACKOFF } from '@signal-desk/adapters';
import { createLogger } from '@signal-desk/shared';
import { ingestOnce, ingestSource, buildAllowlist } from './ingest.js';
import { findRepoRoot } from './repo-root.js';

/**
 * ROADMAP.md Phase 3 acceptance:
 *
 *   "`DATA_MODE=MOCK` reproduces a full run from fixtures with no network access at
 *    all (verified by running with networking disabled)"
 *   "A ... run produces a plausible item count with no duplicates in `raw_items`"
 *   "Circuit breaker demonstrably opens on a source returning persistent 500s"
 *
 * The no-network claim is enforced here rather than asserted: `fetch` is replaced
 * with a function that fails the test if it is ever called.
 */

const FIXTURES = `${findRepoRoot()}/fixtures`;

function silentLogger() {
  return createLogger({
    level: 'error',
    destination: {
      write() {
        /* discarded */
      },
    },
  });
}

/**
 * A `fetch` that fails the test if called.
 *
 * This is the whole "no network access at all" criterion. Asserting it any other way
 * — checking a mode flag, trusting the registry — proves that the code *intended*
 * not to reach the network, which is not the same claim.
 */
const forbiddenFetch = (() => {
  throw new Error('MOCK mode made a network request — this must never happen');
}) as unknown as typeof fetch;

let handle: DatabaseHandle;

beforeEach(() => {
  handle = openDatabase({ url: ':memory:' });
  runMigrations(handle, MIGRATIONS_FOLDER);
  seedAll(handle.db);
});

describe('MOCK mode ingestion', () => {
  it('runs the whole registry from fixtures without touching the network', async () => {
    const registry = createAdapterRegistry({ mode: 'MOCK', fixturesDir: FIXTURES });

    const summary = await ingestOnce({
      db: handle.db,
      registry,
      logger: silentLogger(),
      fetchImpl: forbiddenFetch,
      force: true,
    });

    expect(summary.considered).toBeGreaterThanOrEqual(60);
    expect(summary.fetched).toBe(summary.considered);
    expect(summary.itemsFound).toBeGreaterThan(0);
    expect(summary.itemsNew).toBeGreaterThan(0);
    expect(countRawItems(handle.db)).toBe(summary.itemsNew);
  });

  it('produces no duplicates in raw_items', () => {
    expect(duplicateExternalIds(handle.db)).toEqual([]);
  });

  it('is idempotent — a second pass inserts nothing new', async () => {
    // The steady state for almost every feed: the publisher re-serves its whole
    // window on every poll, and the (source_id, external_id) constraint absorbs it.
    const registry = createAdapterRegistry({ mode: 'MOCK', fixturesDir: FIXTURES });
    const options = {
      db: handle.db,
      registry,
      logger: silentLogger(),
      fetchImpl: forbiddenFetch,
      force: true,
    };

    const first = await ingestOnce(options);
    const afterFirst = countRawItems(handle.db);
    expect(first.itemsNew).toBeGreaterThan(0);

    const second = await ingestOnce(options);

    expect(second.itemsFound).toBe(first.itemsFound);
    expect(second.itemsNew).toBe(0);
    expect(countRawItems(handle.db)).toBe(afterFirst);
    expect(duplicateExternalIds(handle.db)).toEqual([]);
  });

  it('stores items with the fields downstream phases need', async () => {
    const registry = createAdapterRegistry({ mode: 'MOCK', fixturesDir: FIXTURES });
    await ingestOnce({
      db: handle.db,
      registry,
      logger: silentLogger(),
      fetchImpl: forbiddenFetch,
      force: true,
    });

    const items = recentRawItems(handle.db, 20);
    expect(items.length).toBeGreaterThan(0);

    for (const item of items) {
      expect(item.title).not.toBe('');
      expect(item.url).not.toBe('');
      expect(item.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(item.traceId).not.toBe('');
      expect(item.rawPayload).not.toBe('');
      expect(item.fetchedAt).toBeInstanceOf(Date);
    }
  });

  it('records telemetry for every fetch, successful or not', async () => {
    // THREAT-MODEL.md §T-9. A run that leaves no trace is indistinguishable from a
    // run that never happened, which is exactly the invisible failure being defended
    // against.
    const registry = createAdapterRegistry({ mode: 'MOCK', fixturesDir: FIXTURES });
    const summary = await ingestOnce({
      db: handle.db,
      registry,
      logger: silentLogger(),
      fetchImpl: forbiddenFetch,
      force: true,
    });

    const logged = recentFetches(handle.db, new Date(0), 500);
    expect(logged).toHaveLength(summary.fetched);
    for (const entry of logged) {
      expect(entry.outcome).not.toBe('');
      expect(entry.traceId).not.toBe('');
    }
  });

  it('advances the freshness timestamps that the T-9 panel reads', async () => {
    const registry = createAdapterRegistry({ mode: 'MOCK', fixturesDir: FIXTURES });
    await ingestOnce({
      db: handle.db,
      registry,
      logger: silentLogger(),
      fetchImpl: forbiddenFetch,
      force: true,
    });

    const source = getSource(handle.db, 'hn-frontpage');
    expect(source?.lastCheckedAt).toBeInstanceOf(Date);
    expect(source?.lastSuccessAt).toBeInstanceOf(Date);
    expect(source?.lastEventAt).toBeInstanceOf(Date);
  });
});

describe('scheduling', () => {
  it('skips sources that are not due', async () => {
    const registry = createAdapterRegistry({ mode: 'MOCK', fixturesDir: FIXTURES });
    const options = {
      db: handle.db,
      registry,
      logger: silentLogger(),
      fetchImpl: forbiddenFetch,
      random: () => 0.5,
    };

    // First pass with force: everything is fetched and lastCheckedAt is set.
    await ingestOnce({ ...options, force: true });

    // Second pass immediately after, without force: nothing is due yet.
    const second = await ingestOnce(options);

    expect(second.fetched).toBe(0);
    expect(second.skippedNotDue).toBe(second.considered);
  });

  it('fetches a source once its interval has elapsed', async () => {
    const registry = createAdapterRegistry({ mode: 'MOCK', fixturesDir: FIXTURES });
    const options = {
      db: handle.db,
      registry,
      logger: silentLogger(),
      fetchImpl: forbiddenFetch,
      random: () => 0.5,
    };

    const start = new Date('2026-08-13T12:00:00Z');
    await ingestOnce({ ...options, force: true, now: start });

    // Seven hours later: Priority 1 (5 min) through Priority 3 (60 min) are all due.
    const later = new Date(start.getTime() + 7 * 3600 * 1000);
    const summary = await ingestOnce({ ...options, now: later });

    expect(summary.fetched).toBeGreaterThan(0);
  });
});

describe('circuit breaker, end to end', () => {
  /** A LIVE registry whose transport always fails, to drive the breaker. */
  function failingRegistry() {
    return createAdapterRegistry({ mode: 'LIVE' });
  }

  const alwaysFive00 = (() =>
    Promise.resolve(new Response('server error', { status: 500 }))) as unknown as typeof fetch;

  it('opens after persistent 500s and then skips the source', async () => {
    const source = listSources(handle.db, { activeOnly: true }).find((s) => s.platform === 'rss');
    expect(source).toBeDefined();
    if (source === undefined) return;

    const options = {
      db: handle.db,
      registry: failingRegistry(),
      logger: silentLogger(),
      fetchImpl: alwaysFive00,
      // The registry-derived allowlist covers every seeded host, and the stub never
      // resolves DNS, so the guard must be satisfied by a resolver that says "public".
      resolver: () => Promise.resolve(['93.184.216.34']),
    };

    let current = source;
    for (let i = 0; i < DEFAULT_BACKOFF.failureThreshold; i++) {
      await ingestSource(current, options);
      const reloaded = getSource(handle.db, source.id);
      expect(reloaded).toBeDefined();
      if (reloaded === undefined) return;
      current = reloaded;
    }

    expect(current.consecutiveFailures).toBe(DEFAULT_BACKOFF.failureThreshold);
    expect(current.circuitOpenUntil).not.toBeNull();
    expect(current.lastErrorMessage).toContain('500');

    // And the next run skips it entirely rather than hammering a struggling host.
    const summary = await ingestOnce({ ...options, force: true });
    expect(summary.results.find((r) => r.source.id === source.id)?.skipped).toBe('circuit_open');
    expect(summary.skippedCircuitOpen).toBeGreaterThan(0);
  });

  it('closes the breaker again on a success', async () => {
    const source = listSources(handle.db, { activeOnly: true }).find((s) => s.platform === 'rss');
    if (source === undefined) throw new Error('no rss source seeded');

    const resolver = () => Promise.resolve(['93.184.216.34']);
    const base = { db: handle.db, registry: failingRegistry(), logger: silentLogger(), resolver };

    let current = source;
    for (let i = 0; i < DEFAULT_BACKOFF.failureThreshold; i++) {
      await ingestSource(current, { ...base, fetchImpl: alwaysFive00 });
      current = getSource(handle.db, source.id) ?? current;
    }
    expect(current.circuitOpenUntil).not.toBeNull();

    const healthy = (() =>
      Promise.resolve(
        new Response(
          `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
             <item><title>Back online</title><link>https://example.test/a</link></item>
           </channel></rss>`,
          { status: 200, headers: { 'content-type': 'application/rss+xml' } },
        ),
      )) as unknown as typeof fetch;

    await ingestSource(current, { ...base, fetchImpl: healthy });

    const recovered = getSource(handle.db, source.id);
    expect(recovered?.consecutiveFailures).toBe(0);
    expect(recovered?.circuitOpenUntil).toBeNull();
    expect(recovered?.lastErrorMessage).toBeNull();
  });

  it('does not trip the breaker on a 304', async () => {
    // 304 is the healthiest possible answer. Counting it as a failure would open the
    // breaker on precisely the sources behaving best.
    const source = listSources(handle.db, { activeOnly: true }).find((s) => s.platform === 'rss');
    if (source === undefined) throw new Error('no rss source seeded');

    const notModified = (() =>
      Promise.resolve(new Response(null, { status: 304 }))) as unknown as typeof fetch;

    await ingestSource(source, {
      db: handle.db,
      registry: failingRegistry(),
      logger: silentLogger(),
      fetchImpl: notModified,
      resolver: () => Promise.resolve(['93.184.216.34']),
    });

    const after = getSource(handle.db, source.id);
    expect(after?.consecutiveFailures).toBe(0);
    expect(after?.lastSuccessAt).toBeInstanceOf(Date);
  });
});

describe('the fetch allowlist', () => {
  it('contains every registered host and nothing else', () => {
    const allowlist = buildAllowlist(handle.db);
    const registered = new Set(listSources(handle.db).map((s) => new URL(s.url).hostname));

    expect(allowlist).toEqual(registered);
    expect(allowlist.has('anthropic.com') || allowlist.has('www.anthropic.com')).toBe(true);
    expect(allowlist.has('evil.test')).toBe(false);
  });

  it('blocks a registered source that redirects off the registry', async () => {
    // This is what the allowlist actually protects. A source row's own host is in
    // the allowlist by construction — it is where the allowlist comes from — so the
    // reachable attack is a registered feed answering 302 to somewhere else.
    //
    // (An unregistered source id cannot reach this path at all: `fetch_log` has a
    // foreign key to `sources`, which the first draft of this test discovered by
    // failing on it.)
    const source = listSources(handle.db, { activeOnly: true }).find((s) => s.platform === 'rss');
    if (source === undefined) throw new Error('no rss source seeded');

    const redirectsAway = ((url: string) =>
      Promise.resolve(
        url === source.url
          ? new Response('', {
              status: 302,
              headers: { location: 'https://not-in-registry.test/feed.xml' },
            })
          : new Response('<rss/>', { status: 200 }),
      )) as unknown as typeof fetch;

    const result = await ingestSource(source, {
      db: handle.db,
      registry: createAdapterRegistry({ mode: 'LIVE' }),
      logger: silentLogger(),
      fetchImpl: redirectsAway,
      resolver: () => Promise.resolve(['93.184.216.34']),
    });

    expect(result.result?.outcome).toBe('blocked');
    expect(result.result?.error).toContain('allowlist');
  });
});
