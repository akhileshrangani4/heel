/**
 * Loads the committed `looks_like` weights for `classifyLooksLike`
 * (`src/core/lookslike`). Kept out of `src/core` because it reads a file.
 *
 * A failure is returned, not thrown: heel must keep serving when the weights
 * are missing or stale, and an unavailable model makes every category the
 * patterns didn't match `uncertain`, which hides the message (I-44). The
 * caller decides how to surface `error` (log it, count it in a metric).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type LooksLikeModel, parseLooksLikeModel } from "../core/lookslike/model.ts";

/** Written by `pnpm gen:looks-like`; regenerate it rather than editing it. */
export const LOOKS_LIKE_WEIGHTS_PATH = join(import.meta.dirname, "weights.json");

export type LoadLooksLikeResult =
  | { status: "loaded"; model: LooksLikeModel }
  | { status: "unavailable"; path: string; error: string };

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function loadLooksLikeModel(path: string = LOOKS_LIKE_WEIGHTS_PATH): LoadLooksLikeResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return { status: "unavailable", path, error: describe(error) };
  }
  try {
    return { status: "loaded", model: parseLooksLikeModel(JSON.parse(raw)) };
  } catch (error) {
    return { status: "unavailable", path, error: describe(error) };
  }
}
