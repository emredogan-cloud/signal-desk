import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseFeed, NotAFeedError, EmptyFeedError, contentHash } from './feed-parse.js';
import type {
  AdapterContext,
  AdapterResult,
  AdapterSource,
  FetchCursor,
  RawItem,
  SourceAdapter,
} from './types.js';

/**
 * MOCK twins. WORKING-DISCIPLINE.md, "When credentials are missing":
 *
 *   "Every adapter ships with its mock twin in the same PR"
 *   "Never stub something that pretends to be live."
 *
 * These read `fixtures/` — **recorded real payloads** — and perform no network I/O
 * whatsoever. That is what makes ROADMAP.md Phase 3's acceptance criterion testable:
 * "`DATA_MODE=MOCK` reproduces a full run from fixtures with no network access at
 * all (verified by running with networking disabled)."
 *
 * The twin is not a simplification of the real adapter. It runs the *same parser*
 * over the same bytes; only the transport is replaced. A mock with its own parsing
 * would prove nothing about the one that runs in production.
 */

export type MockOptions = {
  readonly fixturesDir: string;
  /**
   * Sources with no fixture yield an empty result rather than an error.
   *
   * Deliberate: the fixture corpus covers one file per distinct *shape*, not one per
   * source, and 60 near-identical recordings would be repository weight rather than
   * coverage. A missing fixture is reported as `empty_feed` so it shows up as a gap
   * instead of silently passing as healthy.
   */
  readonly strict?: boolean;
};

/** Map a source to its fixture, by id first and then by platform shape. */
export function findFixture(
  fixturesDir: string,
  source: AdapterSource,
): { path: string; body: string } | undefined {
  const feedsDir = join(fixturesDir, 'feeds');
  if (!existsSync(feedsDir)) return undefined;

  const files = readdirSync(feedsDir);

  const byId = files.find((f) => f.startsWith(`${source.id}.`));
  if (byId !== undefined) {
    return { path: join(feedsDir, byId), body: readFileSync(join(feedsDir, byId), 'utf8') };
  }

  // Fall back to any recording of the same shape, so a new source of a known type
  // still exercises the full pipeline in MOCK mode.
  const shapeMatch = SHAPE_FIXTURES[source.platform];
  if (shapeMatch !== undefined && files.includes(shapeMatch)) {
    return {
      path: join(feedsDir, shapeMatch),
      body: readFileSync(join(feedsDir, shapeMatch), 'utf8'),
    };
  }

  return undefined;
}

const SHAPE_FIXTURES: Partial<Record<string, string>> = {
  rss: 'hn-frontpage.rss.xml',
  atom: 'status-google-cloud.atom.xml',
  github_atom: 'gh-x-algorithm.commits.atom.xml',
  statuspage: 'status-anthropic.rss.xml',
};

function result(partial: Partial<AdapterResult> & Pick<AdapterResult, 'outcome'>): AdapterResult {
  return {
    items: [],
    httpStatus: 200,
    etag: undefined,
    lastModified: undefined,
    bytes: 0,
    elapsedMs: 0,
    notModified: false,
    error: undefined,
    warning: undefined,
    ...partial,
  };
}

/** MOCK twin for every feed-shaped adapter. */
export function makeMockFeedAdapter(options: MockOptions): SourceAdapter {
  return {
    platform: 'rss',
    fetch(source: AdapterSource, _cursor: FetchCursor, _context: AdapterContext) {
      const fixture = findFixture(options.fixturesDir, source);

      if (fixture === undefined) {
        const message = `no fixture for ${source.id} (${source.platform}) under ${options.fixturesDir}`;
        if (options.strict === true) return Promise.reject(new Error(message));
        return Promise.resolve(result({ outcome: 'empty_feed', error: message }));
      }

      try {
        const parsed = parseFeed(source.id, fixture.body);
        return Promise.resolve(
          result({
            outcome: 'ok',
            items: parsed.items,
            bytes: Buffer.byteLength(fixture.body),
            warning: parsed.warning,
          }),
        );
      } catch (error) {
        return Promise.resolve(
          result({
            outcome: error instanceof EmptyFeedError ? 'empty_feed' : 'not_a_feed',
            error: error instanceof Error ? error.message : String(error),
            bytes: Buffer.byteLength(fixture.body),
          }),
        );
      }
    },
  };
}

/**
 * MOCK twin for the HTML diff adapter.
 *
 * Emits deterministic items derived from the source id, so a MOCK run produces a
 * stable, non-empty result for the two Anthropic diff targets without pretending to
 * have fetched anything. Determinism matters: ROADMAP.md Phase 4 requires "full
 * pipeline replay ... is deterministic — same input, same clusters".
 */
export function makeMockHtmlDiffAdapter(): SourceAdapter {
  return {
    platform: 'html_diff',
    fetch(source: AdapterSource) {
      const items: RawItem[] = [1, 2].map((n) => {
        const url = `${source.url.replace(/\/$/, '')}/mock-item-${String(n)}`;
        const title = `mock ${source.id} item ${String(n)}`;
        return {
          sourceId: source.id,
          externalId: url,
          url,
          title,
          body: `Deterministic MOCK content for ${source.id}. No network request was made.`,
          author: undefined,
          publishedAt: undefined,
          contentHash: contentHash({ title, url, body: '' }),
          rawPayload: JSON.stringify({ mock: true, source: source.id, n }),
        };
      });

      return Promise.resolve(result({ outcome: 'ok', items, bytes: 0 }));
    },
  };
}

export { NotAFeedError, EmptyFeedError };
