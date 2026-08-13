/** Fixed-width table rendering for the CLIs. No dependency; it is thirty lines. */

export type Alignment = 'left' | 'right';

export function renderTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  align: readonly Alignment[] = [],
): string {
  const widths = headers.map((header, i) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[i] ?? ''))),
  );

  const line = (cells: readonly string[]) =>
    cells
      .map((cell, i) => pad(cell, widths[i] ?? 0, align[i] ?? 'left'))
      .join('  ')
      .trimEnd();

  return [
    line(headers),
    widths.map((w) => '─'.repeat(w)).join('  '),
    ...rows.map((row) => line(row)),
  ].join('\n');
}

/**
 * Column widths are computed in code points, not UTF-16 units, so that the status
 * glyphs the probe table uses (✓ ✗ ⚠) do not shift every column to their right.
 */
function displayWidth(value: string): number {
  return [...value].length;
}

function pad(value: string, width: number, align: Alignment): string {
  const gap = width - displayWidth(value);
  if (gap <= 0) return value;
  return align === 'right' ? ' '.repeat(gap) + value : value + ' '.repeat(gap);
}

/** Run `worker` over `items`, at most `limit` at a time, preserving input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await worker(item, index);
    }
  });

  await Promise.all(runners);
  return results;
}
