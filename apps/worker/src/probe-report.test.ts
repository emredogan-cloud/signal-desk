import { describe, it, expect } from 'vitest';
import type { ProbeResult, ProbeOutcome } from '@signal-desk/adapters';
import type { SourceRow } from '@signal-desk/db';
import {
  summarise,
  renderProbeTable,
  renderFailureDetail,
  renderWarningDetail,
  type ProbeRow,
} from './probe-report.js';

/**
 * ROADMAP.md Phase 2 acceptance:
 *   "`pnpm sources:probe` produces a readable table and exits non-zero if any
 *    Priority-1 source fails"
 *
 * The exit code is asserted here rather than by running the CLI, because the
 * interesting cases — a Priority-1 feed going dark, a Priority-4 feed being flaky —
 * are ones you cannot summon on demand from the real network.
 */

function source(id: string, priority: number): SourceRow {
  const now = new Date('2026-08-13T09:00:00Z');
  return {
    id,
    name: id,
    url: `https://example.test/${id}`,
    platform: 'rss',
    category: 'OFFICIAL_SOURCE',
    entity: null,
    priority,
    isOfficial: true,
    reliability: 0.95,
    pollIntervalSec: 300,
    etag: null,
    lastModified: null,
    active: true,
    lastCheckedAt: null,
    lastSuccessAt: null,
    lastEventAt: null,
    verifiedAt: null,
    expectedValue: '',
    consecutiveFailures: 0,
    circuitOpenUntil: null,
    lastErrorMessage: null,
    createdAt: now,
    updatedAt: now,
  };
}

function result(outcome: ProbeOutcome, itemCount = 10): ProbeResult {
  return {
    sourceId: 'x',
    url: 'https://example.test/x',
    finalUrl: 'https://example.test/x',
    outcome,
    httpStatus: outcome === 'network_error' ? undefined : 200,
    contentType: 'application/rss+xml',
    itemCount: outcome === 'ok' ? itemCount : 0,
    bytes: 1024,
    elapsedMs: 120,
    redirects: 0,
    etag: undefined,
    lastModified: undefined,
    newestItemAt: undefined,
    error: outcome === 'ok' ? undefined : `simulated ${outcome}`,
    warning: undefined,
  };
}

const row = (id: string, priority: number, outcome: ProbeOutcome): ProbeRow => ({
  source: source(id, priority),
  result: result(outcome),
});

describe('summarise — the exit code', () => {
  it('exits 0 when everything is healthy', () => {
    const summary = summarise([row('a', 1, 'ok'), row('b', 2, 'ok'), row('c', 3, 'ok_page')]);
    expect(summary.exitCode).toBe(0);
    expect(summary.ok).toBe(3);
    expect(summary.failed).toBe(0);
  });

  it('exits non-zero when a Priority-1 source fails', () => {
    const summary = summarise([row('a', 1, 'http_error'), row('b', 2, 'ok')]);
    expect(summary.exitCode).toBe(1);
    expect(summary.priorityOneFailures).toHaveLength(1);
  });

  it('exits 0 when only lower-priority sources fail', () => {
    // Deliberate. A flaky Product Hunt feed must not block a probe run, or the
    // operator stops running the command that tells him a Priority-1 feed died.
    const summary = summarise([
      row('a', 1, 'ok'),
      row('b', 3, 'http_error'),
      row('c', 4, 'network_error'),
    ]);
    expect(summary.exitCode).toBe(0);
    expect(summary.failed).toBe(2);
  });

  it('treats an empty feed as a failure, not a quiet day', () => {
    // THREAT-MODEL.md §T-9 — the failure that looks like good health.
    const summary = summarise([row('a', 1, 'empty_feed')]);
    expect(summary.exitCode).toBe(1);
    expect(summary.failed).toBe(1);
  });

  it('treats a 200-with-HTML-body as a failure', () => {
    const summary = summarise([row('a', 1, 'not_a_feed')]);
    expect(summary.exitCode).toBe(1);
  });

  it('counts ok_page as healthy for html_diff targets', () => {
    const summary = summarise([row('a', 1, 'ok_page')]);
    expect(summary.exitCode).toBe(0);
    expect(summary.ok).toBe(1);
  });

  it('handles an empty run', () => {
    const summary = summarise([]);
    expect(summary.exitCode).toBe(0);
    expect(summary.total).toBe(0);
  });
});

describe('renderProbeTable', () => {
  it('renders one line per source plus a header and rule', () => {
    const table = renderProbeTable([row('openai-news', 1, 'ok'), row('lobsters', 3, 'ok')]);
    const lines = table.split('\n');

    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('SOURCE');
    expect(table).toContain('openai-news');
    expect(table).toContain('P1');
  });

  it('keeps columns aligned when a status glyph is present', () => {
    // Glyphs are multi-byte. Measuring width in UTF-16 units instead of code points
    // shifts every column right of them by one and makes the table unreadable.
    const table = renderProbeTable([row('a', 1, 'ok'), row('bbbbbbbbbb', 2, 'http_error')]);
    const [header, , first, second] = table.split('\n');

    expect(header).toBeDefined();
    expect([...(first ?? '')].indexOf('P')).toBe([...(second ?? '')].indexOf('P'));
  });

  it('names the outcome for a failing source and leaves it blank for a healthy one', () => {
    const table = renderProbeTable([row('good', 1, 'ok'), row('bad', 1, 'empty_feed')]);
    expect(table).toContain('empty_feed');
    expect(table.split('\n').find((l) => l.includes('good'))).not.toContain('ok_');
  });
});

describe('warnings are reported without failing the run', () => {
  const broken: ProbeRow = {
    source: source('hamel-husain', 3),
    result: {
      ...result('ok'),
      warning: 'malformed XML at line 5536: Extra text at the end',
    },
  };

  it('counts a warned source as healthy', () => {
    // Recorded from a real feed that serves two concatenated documents and still
    // carries 20 usable items. Failing the run over a publisher's build bug would
    // train the operator to ignore a command that also reports dead Priority-1 feeds.
    const summary = summarise([broken]);
    expect(summary.exitCode).toBe(0);
    expect(summary.ok).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.warnings).toHaveLength(1);
  });

  it('marks it in the table so it is not invisible', () => {
    expect(renderProbeTable([broken])).toContain('⚠');
  });

  it('says what is wrong and that the source still works', () => {
    const detail = renderWarningDetail([broken]);
    expect(detail).toContain('hamel-husain');
    expect(detail).toContain('still usable');
    expect(detail).toContain('line 5536');
  });

  it('renders nothing when no source is warned', () => {
    expect(renderWarningDetail([])).toBe('');
    expect(summarise([row('a', 1, 'ok')]).warnings).toHaveLength(0);
  });
});

describe('renderFailureDetail', () => {
  it('is empty when nothing failed', () => {
    expect(renderFailureDetail([])).toBe('');
  });

  it('explains what the outcome means rather than just naming it', () => {
    // An operator reading "empty_feed" at 7am should not have to look it up.
    const detail = renderFailureDetail([row('dead-feed', 1, 'empty_feed')]);
    expect(detail).toContain('dead-feed');
    expect(detail).toContain('https://example.test/dead-feed');
    expect(detail).toContain('zero items');
  });

  it('shows the redirect destination when the URL moved', () => {
    const moved: ProbeRow = {
      source: source('moved', 2),
      result: { ...result('http_error'), finalUrl: 'https://elsewhere.test/feed' },
    };
    expect(renderFailureDetail([moved])).toContain('redirected to https://elsewhere.test/feed');
  });
});
