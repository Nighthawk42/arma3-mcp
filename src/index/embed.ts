/**
 * Local sentence embeddings via Transformers.js.
 *
 * all-MiniLM-L6-v2: 384 dimensions, ~23MB quantised, runs on CPU with no API
 * key and no network at query time once the model is cached. The model is
 * downloaded on first use and stored under the HF cache directory.
 */
import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

export const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIMS = 384;

let extractor: FeatureExtractionPipeline | undefined;

export async function getEmbedder(): Promise<FeatureExtractionPipeline> {
  extractor ??= await pipeline("feature-extraction", MODEL_ID, { dtype: "q8" });
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
