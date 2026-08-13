import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Embedder } from '@signal-desk/core';

/**
 * Local ONNX embeddings. ARCHITECTURE.md §2:
 *
 *   "Local ONNX (`bge-small-en-v1.5`)… Free, offline, no second AI vendor. Anthropic
 *    has no embeddings endpoint; adding Voyage or OpenAI purely for embeddings would
 *    violate the one-vendor rule for no benefit at this scale."
 *
 * Lives in `adapters` rather than `core` because it downloads a model on first use
 * and reads it from disk — I/O, which `core` does not do. The `Embedder` interface it
 * satisfies is defined in `core`.
 *
 * **Measured 2026-08-13** on the operator's machine:
 *   first load (including download)  ~50s
 *   3 texts, warm                    16ms
 *   dimensions                       384
 *   cosine, same event two ways      0.8798
 *   cosine, unrelated vendors        0.5435
 */

export const EMBEDDING_MODEL = 'Xenova/bge-small-en-v1.5';
export const EMBEDDING_DIMENSIONS = 384;

/** Gitignored. Nothing here belongs in the repository. */
export const DEFAULT_MODEL_CACHE_DIR = '.models';

export type OnnxEmbedderOptions = {
  readonly cacheDir?: string;
  /**
   * Refuse to download; use only what is already cached.
   *
   * CI sets this. A test suite that downloads 130MB from a third party is a test
   * suite that fails when that third party is down, and this project's CI runs with
   * no credentials and no assumptions about the outside world.
   */
  readonly localOnly?: boolean;
  /** Texts per forward pass. */
  readonly batchSize?: number;
};

export class ModelUnavailableError extends Error {
  constructor(cacheDir: string, cause?: unknown) {
    super(
      `the embedding model is not available locally (cache: ${cacheDir}). ` +
        `Run \`pnpm embeddings:warm\` once with network access, or use ` +
        `DeterministicEmbedder for logic tests.`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'ModelUnavailableError';
  }
}

type FeatureExtractionPipeline = (
  texts: readonly string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

/**
 * `bge-small-en-v1.5` via transformers.js.
 *
 * The model is loaded lazily on first `embed()` and then held: loading costs seconds
 * and embedding costs milliseconds, so a per-call load would dominate the pipeline
 * by three orders of magnitude.
 */
export class OnnxEmbedder implements Embedder {
  readonly name = EMBEDDING_MODEL;
  readonly dimensions = EMBEDDING_DIMENSIONS;

  readonly #cacheDir: string;
  readonly #localOnly: boolean;
  readonly #batchSize: number;
  #pipeline: FeatureExtractionPipeline | undefined;
  #loading: Promise<FeatureExtractionPipeline> | undefined;

  constructor(options: OnnxEmbedderOptions = {}) {
    this.#cacheDir = resolve(options.cacheDir ?? DEFAULT_MODEL_CACHE_DIR);
    this.#localOnly = options.localOnly ?? false;
    this.#batchSize = options.batchSize ?? 32;
  }

  /** True when the model is already on disk — no download would be needed. */
  get cached(): boolean {
    return existsSync(resolve(this.#cacheDir, EMBEDDING_MODEL));
  }

  async #load(): Promise<FeatureExtractionPipeline> {
    if (this.#pipeline !== undefined) return this.#pipeline;
    if (this.#loading !== undefined) return this.#loading;

    this.#loading = (async () => {
      // Imported dynamically so that merely importing this module — which the
      // adapters barrel does — never pulls the ONNX runtime into a process that will
      // not embed anything. It is the heaviest dependency in the tree.
      const transformers = await import('@huggingface/transformers');
      const { pipeline, env } = transformers;

      env.cacheDir = this.#cacheDir;
      env.allowLocalModels = true;
      if (this.#localOnly) {
        env.allowRemoteModels = false;
      }

      try {
        const extractor = await pipeline('feature-extraction', EMBEDDING_MODEL, { dtype: 'fp32' });
        return extractor as unknown as FeatureExtractionPipeline;
      } catch (error) {
        throw new ModelUnavailableError(this.#cacheDir, error);
      }
    })();

    this.#pipeline = await this.#loading;
    return this.#pipeline;
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    const extractor = await this.#load();
    const out: Float32Array[] = [];

    for (let i = 0; i < texts.length; i += this.#batchSize) {
      const batch = texts.slice(i, i + this.#batchSize).map((text) =>
        // An empty string produces a degenerate vector that is similar to everything.
        // A single space is the smallest input that does not.
        text.trim() === '' ? ' ' : text,
      );

      const tensor = await extractor(batch, { pooling: 'mean', normalize: true });
      for (const row of tensor.tolist()) {
        out.push(Float32Array.from(row));
      }
    }

    return out;
  }
}

/**
 * The embedder to use, given the environment.
 *
 * Returns `undefined` rather than throwing when the model is absent and downloading
 * is not permitted. The caller then runs stages 1 and 2 only — degraded, and
 * **visibly** so, rather than failing the whole pipeline over an optional stage.
 */
export function createEmbedder(options: OnnxEmbedderOptions = {}): OnnxEmbedder | undefined {
  const embedder = new OnnxEmbedder(options);
  if (options.localOnly === true && !embedder.cached) return undefined;
  return embedder;
}
