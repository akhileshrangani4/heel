/**
 * `classifyLooksLike`: the `looks_like` detector's one entry point (spec:
 * Hiding, `looks_like`). D10b calls it from the hide path; it changes no
 * rules and reads no files.
 *
 * Order, per requested category:
 * 1. Patterns, tuned for recall. A hit is `match`.
 * 2. An unreadable body (encrypted, image-only, unparseable) is `uncertain`.
 * 3. The linear classifier. No model loaded is `uncertain`; a score in the
 *    head's unsure band is `uncertain`; past the time budget is `uncertain`.
 * 4. Any thrown error makes every requested category `uncertain`.
 *
 * Only `no_match` lets a message through, and it comes only from a loaded
 * model scoring a readable message below its threshold in time (I-44).
 */
import { extractFeatures, hashFeatures } from "./features.ts";
import type { LooksLikeHead, LooksLikeModel } from "./model.ts";
import { scoreHead } from "./model.ts";
import { matchLooksLikePatterns } from "./patterns.ts";
import { type PreparedMessage, prepareMessage } from "./text.ts";
import {
  combineVerdicts,
  type LooksLikeCategory,
  type LooksLikeCategoryResult,
  type LooksLikeMessage,
  type LooksLikeReason,
  type LooksLikeResult,
} from "./types.ts";

/** Spec: a classifier that takes longer than 200 ms hides the message. */
export const LOOKS_LIKE_BUDGET_MS = 200;

export interface ClassifyLooksLikeOptions {
  /** The loaded model. `undefined` means not loaded: every unmatched category is `uncertain`. */
  model: LooksLikeModel | undefined;
  /**
   * A monotonic clock in milliseconds, e.g. `() => performance.now()`. When
   * given, a classification that runs past `budgetMs` is `uncertain`. Kept
   * injectable so this module stays pure and the budget is testable.
   */
  now?: () => number;
  budgetMs?: number;
}

/** The verdict a head gives a score: `match`, `no_match`, or `uncertain` in between. */
export function headVerdict(head: Pick<LooksLikeHead, "matchAt" | "noMatchBelow">, score: number) {
  if (!Number.isFinite(score)) return "uncertain" as const;
  if (score >= head.matchAt) return "match" as const;
  if (score < head.noMatchBelow) return "no_match" as const;
  return "uncertain" as const;
}

function result(
  categories: Partial<Record<LooksLikeCategory, LooksLikeCategoryResult>>,
): LooksLikeResult {
  const verdicts = Object.values(categories).map((c) => c.verdict);
  return { verdict: combineVerdicts(verdicts), categories };
}

function allUncertain(
  categories: readonly LooksLikeCategory[],
  reason: LooksLikeReason,
): LooksLikeResult {
  const out: Partial<Record<LooksLikeCategory, LooksLikeCategoryResult>> = {};
  for (const category of categories) out[category] = { verdict: "uncertain", reason };
  return result(out);
}

function classifyPrepared(
  prepared: PreparedMessage,
  categories: readonly LooksLikeCategory[],
  options: ClassifyLooksLikeOptions,
  startedAt: number | undefined,
): LooksLikeResult {
  const hits = matchLooksLikePatterns(prepared);
  const out: Partial<Record<LooksLikeCategory, LooksLikeCategoryResult>> = {};
  let features: ReturnType<typeof hashFeatures> | undefined;

  for (const category of categories) {
    const pattern = hits[category];
    if (pattern !== undefined) {
      out[category] = { verdict: "match", reason: { kind: "pattern", pattern } };
      continue;
    }
    if (prepared.unreadable !== undefined) {
      out[category] = {
        verdict: "uncertain",
        reason: { kind: "unreadable", detail: prepared.unreadable },
      };
      continue;
    }
    const model = options.model;
    if (model === undefined) {
      out[category] = { verdict: "uncertain", reason: { kind: "model_unavailable" } };
      continue;
    }
    features ??= hashFeatures(extractFeatures(prepared), model.dims);
    const head = model.heads[category];
    const score = scoreHead(head, features);
    const verdict = headVerdict(head, score);
    out[category] = Number.isFinite(score)
      ? { verdict, reason: { kind: "classifier", score } }
      : { verdict, reason: { kind: "error", error: "non-finite score" } };
  }

  // Checked once at the end: the work is synchronous and bounded by the input
  // caps, so a run that overshot can only be caught after the fact. Pattern
  // matches stand; anything the classifier let through becomes uncertain.
  if (startedAt !== undefined && options.now !== undefined) {
    const elapsedMs = options.now() - startedAt;
    if (elapsedMs > (options.budgetMs ?? LOOKS_LIKE_BUDGET_MS)) {
      for (const category of categories) {
        const current = out[category];
        if (current?.verdict !== "match")
          out[category] = { verdict: "uncertain", reason: { kind: "timeout", elapsedMs } };
      }
    }
  }
  return result(out);
}

/**
 * Classifies one message for the requested categories. Never throws: an
 * error becomes `uncertain` for every category, with the error's name (never
 * its message, which could quote content) as the reason.
 */
export function classifyLooksLike(
  message: LooksLikeMessage,
  categories: readonly LooksLikeCategory[],
  options: ClassifyLooksLikeOptions,
): LooksLikeResult {
  const startedAt = options.now?.();
  try {
    return classifyPrepared(prepareMessage(message), categories, options, startedAt);
  } catch (error) {
    // Not swallowed: the failure is the result. I-44 turns it into "hide".
    const name = error instanceof Error ? error.name : typeof error;
    return allUncertain(categories, { kind: "error", error: name });
  }
}
