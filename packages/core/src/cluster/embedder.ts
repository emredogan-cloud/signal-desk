/**
 * The embedder contract, and a deterministic stand-in for tests.
 *
 * `packages/core` performs no I/O, so the interface lives here and the ONNX
 * implementation lives in `packages/adapters` (it downloads a model and reads files).
 * Clustering receives an `Embedder`; it never constructs one.
 */

export type Embedder = {
  readonly name: string;
  readonly dimensions: number;
  /** Vectors are L2-normalised, so cosine similarity is a dot product. */
  embed(texts: readonly string[]): Promise<Float32Array[]>;
};

/**
 * A deterministic hash-based embedder. **For tests and CI only.**
 *
 * Why this exists: the real embedder downloads ~130MB on first use. CI runs with no
 * credentials, and it must not depend on a model host being up. So the unit tests
 * that exercise *clustering logic* use this, and the tests that *measure* dedup
 * quality use the real one and are skipped when the model is absent.
 *
 * It is honest about what it is. It produces stable, well-spread vectors with no
 * semantic meaning at all — token overlap moves similarity, paraphrase does not. Any
 * test that would pass with this embedder and fail with the real one is a test of
 * plumbing, and is labelled as such.
 */
export class DeterministicEmbedder implements Embedder {
  readonly name = 'deterministic-test-embedder';
  readonly dimensions: number;

  constructor(dimensions = 384) {
    this.dimensions = dimensions;
  }

  embed(texts: readonly string[]): Promise<Float32Array[]> {
    return Promise.resolve(texts.map((text) => this.#embedOne(text)));
  }

  #embedOne(text: string): Float32Array {
    const vector = new Float32Array(this.dimensions);
    const tokens = text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2);

    for (const token of tokens) {
      // FNV-1a, so the same token always lands in the same buckets.
      let hash = 0x811c9dc5;
      for (let i = 0; i < token.length; i++) {
        hash ^= token.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      const index = hash % this.dimensions;
      vector[index] = (vector[index] ?? 0) + 1;
      // A second bucket per token so short texts are not near-orthogonal by accident.
      const secondary = (hash >>> 8) % this.dimensions;
      vector[secondary] = (vector[secondary] ?? 0) + 0.5;
    }

    return normalize(vector);
  }
}

export function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  if (sum === 0) return vector;

  const inverse = 1 / Math.sqrt(sum);
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = (vector[i] ?? 0) * inverse;
  return out;
}

/** Pack a vector for SQLite. sqlite-vec takes the raw little-endian float32 bytes. */
export function embeddingToBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function bufferToEmbedding(buffer: Buffer): Float32Array {
  // Copy rather than view: a Buffer from SQLite may sit in a pooled allocation that
  // is reused, and a view over it would change value under the caller's feet.
  const copy = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(copy).set(buffer);
  return new Float32Array(copy);
}
