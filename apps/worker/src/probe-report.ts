import type { ProbeResult, ProbeOutcome } from '@signal-desk/adapters';
import type { SourceRow } from '@signal-desk/db';
import { renderTable } from './table.js';

/**
 * Turning probe results into something a human reads in ten seconds, and into an
 * exit code.
 *
 * Separated from the CLI so it can be tested without a network or a process exit.
 */

const GLYPH: Record<ProbeOutcome, string> = {
  ok: '✓',
  ok_page: '✓',
  http_error: '✗',
  not_a_feed: '✗',
  empty_feed: '⚠',
  network_error: '✗',
  timeout: '✗',
  too_large: '⚠',
};

/** Human-readable one-liner per outcome, for the failure list under the table. */
const EXPLANATION: Record<ProbeOutcome, string> = {
  ok: 'valid feed',
  ok_page: 'page fetched (html_diff target)',
  http_error: 'non-2xx response',
  not_a_feed: 'served something that is not a feed',
  empty_feed: 'parsed but contains zero items — dead in the way that matters (T-9)',
  network_error: 'could not connect',
  timeout: 'timed out',
  too_large: 'response exceeded the size cap',
};

export type ProbeRow = { readonly source: SourceRow; readonly result: ProbeResult };

/** A healthy result that still carries something worth knowing. */
export function hasWarning(row: ProbeRow): boolean {
  return row.result.warning !== undefined && isHealthy(row.result.outcome);
}

function isHealthy(outcome: ProbeOutcome): boolean {
  return outcome === 'ok' || outcome === 'ok_page';
}

export function renderProbeTable(rows: readonly ProbeRow[]): string {
  const body = rows.map(({ source, result }) => [
    result.warning !== undefined && isHealthy(result.outcome) ? '⚠' : GLYPH[result.outcome],
    source.id,
    `P${String(source.priority)}`,
    source.platform,
    result.httpStatus === undefined ? '—' : String(result.httpStatus),
    shortContentType(result.contentType),
    result.itemCount === 0 ? '—' : String(result.itemCount),
    `${String(result.elapsedMs)}ms`,
    formatBytes(result.bytes),
    result.outcome === 'ok' || result.outcome === 'ok_page' ? '' : result.outcome,
  ]);

  return renderTable(
    ['', 'SOURCE', 'PRI', 'PLATFORM', 'HTTP', 'CONTENT-TYPE', 'ITEMS', 'TIME', 'SIZE', 'OUTCOME'],
    body,
    ['left', 'left', 'left', 'left', 'right', 'left', 'right', 'right', 'right', 'left'],
  );
}

export type ProbeSummary = {
  readonly total: number;
  readonly ok: number;
  readonly failed: number;
  readonly failures: readonly ProbeRow[];
  /** Healthy sources with something worth knowing. Never affects the exit code. */
  readonly warnings: readonly ProbeRow[];
  /** Priority-1 failures. These alone decide the exit code. */
  readonly priorityOneFailures: readonly ProbeRow[];
  readonly exitCode: number;
};

export function summarise(rows: readonly ProbeRow[]): ProbeSummary {
  const failures = rows.filter(
    ({ result }) => result.outcome !== 'ok' && result.outcome !== 'ok_page',
  );
  const priorityOneFailures = failures.filter(({ source }) => source.priority === 1);

  return {
    total: rows.length,
    ok: rows.length - failures.length,
    failed: failures.length,
    failures,
    warnings: rows.filter(hasWarning),
    priorityOneFailures,
    // ROADMAP.md Phase 2 acceptance: "exits non-zero if any Priority-1 source fails".
    // Lower-priority failures are reported loudly but do not fail the command — a
    // flaky Product Hunt feed must not block a probe run, or the operator stops
    // running it.
    exitCode: priorityOneFailures.length > 0 ? 1 : 0,
  };
}

export function renderFailureDetail(rows: readonly ProbeRow[]): string {
  if (rows.length === 0) return '';

  const lines: string[] = [];
  for (const { source, result } of rows) {
    lines.push(`  ${GLYPH[result.outcome]} ${source.id}  (P${String(source.priority)})`);
    lines.push(`      ${source.url}`);
    lines.push(`      ${EXPLANATION[result.outcome]}`);
    if (result.error !== undefined) lines.push(`      ${result.error}`);
    if (result.finalUrl !== undefined && result.finalUrl !== source.url) {
      lines.push(`      redirected to ${result.finalUrl}`);
    }
  }
  return lines.join('\n');
}

/**
 * Warnings, rendered separately from failures.
 *
 * Kept distinct on purpose: a source that works but has a broken publisher build is
 * a different thing from a source that is down, and merging them either fails runs
 * that should pass or hides faults that matter.
 */
export function renderWarningDetail(rows: readonly ProbeRow[]): string {
  if (rows.length === 0) return '';

  return rows
    .flatMap(({ source, result }) => [
      `  ⚠ ${source.id}  (P${String(source.priority)}, ${String(result.itemCount)} items still usable)`,
      `      ${source.url}`,
      `      ${result.warning ?? ''}`,
    ])
    .join('\n');
}

function shortContentType(contentType: string | undefined): string {
  if (contentType === undefined) return '—';
  return contentType.split(';')[0]?.trim() ?? '—';
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '—';
  if (bytes < 1024) return `${String(bytes)}B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}
