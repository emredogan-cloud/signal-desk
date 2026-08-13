import {
  openDatabase,
  runMigrations,
  seedAll,
  MIGRATIONS_FOLDER,
  loadEntityRegistryRows,
} from '@signal-desk/db';
import { createEmbedder } from '@signal-desk/adapters';
import {
  EntityRegistry,
  measureClustering,
  sweepThreshold,
  LABELLED_CLUSTERS,
} from '@signal-desk/core';
import { bootstrap } from '../bootstrap.js';
import { findRepoRoot } from '../repo-root.js';
import { renderTable } from '../table.js';

/**
 * `pnpm measure:dedup` — the Phase 4 acceptance measurement.
 *
 * Produces the precision and recall figures that ROADMAP.md requires be written into
 * ARCHITECTURE.md §5, replacing the 0.86 starting guess. Sweeps thresholds so the
 * chosen value is a measurement rather than a preference.
 */
async function main(): Promise<number> {
  const boot = bootstrap({ loggerName: 'measure' });
  const handle = openDatabase({ url: boot.config.DATABASE_URL });

  try {
    runMigrations(handle, MIGRATIONS_FOLDER);
    seedAll(handle.db);
    const rows = loadEntityRegistryRows(handle.db);
    const registry = new EntityRegistry(rows.entities, rows.aliases);

    const embedder = createEmbedder({ cacheDir: `${findRepoRoot()}/.models` });
    const real = LABELLED_CLUSTERS.filter((c) => c.provenance === 'real');
    const synthetic = LABELLED_CLUSTERS.filter((c) => c.provenance === 'synthetic');

    console.log('');
    console.log(
      `labelled set: ${String(LABELLED_CLUSTERS.length)} clusters ` +
        `(${String(real.length)} real, ${String(synthetic.length)} synthetic), ` +
        `${String(LABELLED_CLUSTERS.reduce((n, c) => n + c.items.length, 0))} items`,
    );
    console.log(
      `embedder:     ${embedder === undefined ? 'NONE (stages 1+2 only)' : embedder.name}`,
    );
    console.log('');

    const sweep = await sweepThreshold({ registry, embedder });
    console.log('THRESHOLD SWEEP');
    console.log(
      renderTable(
        ['THRESHOLD', 'PRECISION', 'RECALL', 'F1', 'WRONG MERGES', 'MISSED'],
        sweep.map(({ threshold, result }) => [
          threshold.toFixed(2),
          result.precision.toFixed(4),
          result.recall.toFixed(4),
          result.f1.toFixed(4),
          String(result.falsePositives),
          String(result.falseNegatives),
        ]),
        ['right', 'right', 'right', 'right', 'right', 'right'],
      ),
    );
    console.log('');

    for (const [name, clusters] of [
      ['ALL', LABELLED_CLUSTERS],
      ['REAL only', real],
      ['SYNTHETIC only', synthetic],
    ] as const) {
      const result = await measureClustering({ registry, embedder, clusters });
      console.log(
        `${name.padEnd(16)} precision ${result.precision.toFixed(4)}  ` +
          `recall ${result.recall.toFixed(4)}  f1 ${result.f1.toFixed(4)}  ` +
          `(${String(result.itemsEvaluated)} items, ${String(result.pairsEvaluated)} pairs)`,
      );

      if (result.wrongMerges.length > 0) {
        for (const merge of result.wrongMerges) {
          console.log(
            `    WRONG MERGE  ${merge.a} + ${merge.b}  stage ${String(merge.stage)}` +
              `${merge.similarity === undefined ? '' : ` (${merge.similarity.toFixed(4)})`}`,
          );
        }
      }
      for (const missed of result.missedMerges) {
        console.log(`    MISSED       ${missed.a} + ${missed.b}`);
      }
    }
    console.log('');

    const final = await measureClustering({ registry, embedder });
    const pass = final.precision >= 0.95 && final.recall >= 0.85;
    console.log(
      pass
        ? `PASS  precision ${final.precision.toFixed(4)} ≥ 0.95 and recall ${final.recall.toFixed(4)} ≥ 0.85`
        : `FAIL  precision ${final.precision.toFixed(4)} (need ≥0.95), recall ${final.recall.toFixed(4)} (need ≥0.85)`,
    );
    console.log('');

    return pass ? 0 : 1;
  } finally {
    handle.close();
  }
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(`\nmeasurement failed: ${String(error)}\n`);
    process.exit(1);
  });
