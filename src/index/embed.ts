/**
 * Local sentence embeddings via Transformers.js.
 *
 * all-MiniLM-L6-v2: 384 dimensions, ~23MB quantised, runs on CPU with no API
 * key. The model is fetched once, by `npm run index`, into MODEL_DIR; the
 * server only ever loads it from there and never touches the network. Without
 * a cached model, search simply runs on its lexical arms.
 *
 * MODEL_DIR is pinned deliberately: Transformers.js otherwise caches inside
 * node_modules, which every `npm ci` wipes, so the next query would silently
 * go back to the network for it.
 */
import path from "node:path";
import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

export const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIMS = 384;

/** `<package root>/data/models`; src/index and dist/index are both two levels down. */
export const MODEL_DIR = process.env.ARMA_MCP_MODEL_DIR
  ? path.resolve(process.env.ARMA_MCP_MODEL_DIR)
  : path.resolve(import.meta.dirname, "..", "..", "data", "models");

env.cacheDir = MODEL_DIR;
env.localModelPath = MODEL_DIR;
// Off by default; only the index build opts in.
env.allowRemoteModels = false;

/** Let this process download the model if it is not cached yet. Build-time only. */
export function allowModelDownload(): void {
  env.allowRemoteModels = true;
}

let extractor: Promise<FeatureExtractionPipeline> | undefined;

export function getEmbedder(): Promise<FeatureExtractionPipeline> {
  extractor ??= pipeline("feature-extraction", MODEL_ID, { dtype: "q8" }).catch((error: unknown) => {
    // Let a later call retry (e.g. after `npm run index` fetched the model).
    extractor = undefined;
    throw error;
  });
  return extractor;
}

/**
 * Embed a batch of texts, mean-pooled and L2-normalised.
 *
 * Normalising here means cosine similarity reduces to a dot product, which is
 * what sqlite-vec's L2 distance ranks equivalently for unit vectors.
 */
export async function embed(texts: string[]): Promise<Float32Array[]> {
  const model = await getEmbedder();
  const output = await model(texts, { pooling: "mean", normalize: true });
  const data = output.data as Float32Array;
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i++) {
    out.push(new Float32Array(data.slice(i * EMBEDDING_DIMS, (i + 1) * EMBEDDING_DIMS)));
  }
  return out;
}

/** sqlite-vec takes vectors as raw little-endian float32 blobs. */
export function toBlob(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}
