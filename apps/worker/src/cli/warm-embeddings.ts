import { OnnxEmbedder, EMBEDDING_MODEL } from '@signal-desk/adapters';
import { modelCacheDir } from '@signal-desk/shared';

/**
 * `pnpm embeddings:warm` — download and cache the embedding model, once.
 *
 * Exists so the download is a deliberate, visible act rather than something that
 * happens the first time someone runs the pipeline and wonders why it hung for a
 * minute. CI never runs this: it passes `--local-only` and degrades to stages 1 and
 * 2 if the model is absent.
 */
async function main(): Promise<number> {
  const cacheDir = modelCacheDir();
  const embedder = new OnnxEmbedder({ cacheDir });

  console.log(`\nmodel:  ${EMBEDDING_MODEL}`);
  console.log(`cache:  ${cacheDir}  (gitignored)`);
  console.log(embedder.cached ? 'status: already cached\n' : 'status: downloading (~130MB)…\n');

  const startedAt = Date.now();
  const [vector] = await embedder.embed(['warm-up']);
  const elapsed = Date.now() - startedAt;

  if (vector === undefined) {
    console.error('FAIL  the model loaded but produced no vector');
    return 1;
  }

  console.log(`OK    ready in ${String(elapsed)}ms, ${String(vector.length)} dimensions\n`);
  return 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(`\nfailed to warm the embedding model: ${String(error)}\n`);
    process.exit(1);
  });
