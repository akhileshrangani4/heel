/**
 * The `looks_like` linear model: one logistic-regression head per category
 * over hashed features, with two thresholds per head that carve out an
 * "unsure" band (spec: Hiding, `looks_like` step 2: low confidence hides).
 *
 * Pure: `parseLooksLikeModel` validates already-parsed JSON. Reading the
 * weights file is the caller's job (`src/lookslike/load.ts`).
 */
import { z } from "zod";
import { FEATURE_VERSION, type HashedFeatures } from "./features.ts";
import type { LooksLikeCategory } from "./types.ts";

export const LOOKS_LIKE_MODEL_FORMAT = "heel.looks-like.linear";

export interface LooksLikeHead {
  bias: number;
  weights: Float32Array;
  /** A score at or above this is a match. */
  matchAt: number;
  /** A score below this is no match. Between the two, the head is unsure. */
  noMatchBelow: number;
}

export interface LooksLikeModel {
  /** Number of hash buckets, a power of two. */
  dims: number;
  heads: Record<LooksLikeCategory, LooksLikeHead>;
}

const MIN_DIMS = 2 ** 10;
const MAX_DIMS = 2 ** 22;
const INT16_MAX = 32767;

const HeadFileSchema = z
  .object({
    bias: z.number(),
    /** Multiplier from the stored int16 weights back to floats. */
    scale: z.number().nonnegative(),
    /** Little-endian int16 weights, base64. */
    weights: z.string(),
    matchAt: z.number().gt(0).lt(1),
    noMatchBelow: z.number().gt(0).lt(1),
  })
  .strict()
  .refine((head) => head.noMatchBelow <= head.matchAt, {
    message: "noMatchBelow must not exceed matchAt",
  });

export type LooksLikeHeadFile = z.infer<typeof HeadFileSchema>;

const ModelFileSchema = z
  .object({
    format: z.literal(LOOKS_LIKE_MODEL_FORMAT),
    featureVersion: z.literal(FEATURE_VERSION),
    dims: z
      .number()
      .int()
      .min(MIN_DIMS)
      .max(MAX_DIMS)
      .refine((n) => (n & (n - 1)) === 0, { message: "dims must be a power of two" }),
    heads: z.object({ password_reset: HeadFileSchema, login_code: HeadFileSchema }).strict(),
    /** Provenance written by `pnpm gen:looks-like`; not read at runtime. */
    training: z.record(z.string(), z.unknown()),
  })
  .strict();

export type LooksLikeModelFile = z.infer<typeof ModelFileSchema>;

function decodeWeights(head: LooksLikeHeadFile, dims: number, category: string): Float32Array {
  const bytes = Buffer.from(head.weights, "base64");
  if (bytes.length !== dims * 2) {
    throw new Error(
      `looks_like model: ${category} has ${bytes.length} weight bytes, expected ${dims * 2}`,
    );
  }
  const weights = new Float32Array(dims);
  for (let i = 0; i < dims; i += 1) weights[i] = bytes.readInt16LE(i * 2) * head.scale;
  return weights;
}

/**
 * Validates a parsed weights file. Throws on any mismatch, including weights
 * trained for another FEATURE_VERSION, so a stale file is "not loaded"
 * rather than silently scoring the wrong features.
 */
export function parseLooksLikeModel(input: unknown): LooksLikeModel {
  const file = ModelFileSchema.parse(input);
  const head = (category: LooksLikeCategory): LooksLikeHead => {
    const stored = file.heads[category];
    return {
      bias: stored.bias,
      weights: decodeWeights(stored, file.dims, category),
      matchAt: stored.matchAt,
      noMatchBelow: stored.noMatchBelow,
    };
  };
  return {
    dims: file.dims,
    heads: { password_reset: head("password_reset"), login_code: head("login_code") },
  };
}

/** Quantizes float weights to the stored int16 form. Exported for the trainer. */
export function quantizeWeights(weights: Float32Array): { scale: number; weights: string } {
  let max = 0;
  for (const w of weights) max = Math.max(max, Math.abs(w));
  const scale = max === 0 ? 0 : max / INT16_MAX;
  const bytes = Buffer.alloc(weights.length * 2);
  for (let i = 0; i < weights.length; i += 1) {
    const q = scale === 0 ? 0 : Math.round((weights[i] as number) / scale);
    bytes.writeInt16LE(Math.max(-INT16_MAX, Math.min(INT16_MAX, q)), i * 2);
  }
  return { scale, weights: bytes.toString("base64") };
}

/** The head's probability that the message is in its category. */
export function scoreHead(
  head: Pick<LooksLikeHead, "bias" | "weights">,
  x: HashedFeatures,
): number {
  let logit = head.bias;
  for (let i = 0; i < x.indices.length; i += 1) {
    logit += (head.weights[x.indices[i] as number] ?? 0) * (x.values[i] as number);
  }
  return 1 / (1 + Math.exp(-logit));
}
