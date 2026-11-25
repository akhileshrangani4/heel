import { performance } from "node:perf_hooks";
import type { HideReason, LooksLikeJudge } from "../core/hide.ts";
import { classifyLooksLike, LOOKS_LIKE_BUDGET_MS } from "../core/lookslike/classify.ts";
import type { LooksLikeModel } from "../core/lookslike/model.ts";
import { loadLooksLikeModel } from "./load.ts";

/**
 * The `looks_like` judge the hide path uses: patterns, then the
 * committed classifier, under the 200 ms budget. The model loads once; if it
 * can't, every message an entry's `looks_like` covers is `uncertain`, which
 * hides it (I-44).
 */
export function looksLikeJudge(model: LooksLikeModel | undefined): LooksLikeJudge {
  return (message, categories) =>
    classifyLooksLike(message, categories, {
      model,
      now: () => performance.now(),
      budgetMs: LOOKS_LIKE_BUDGET_MS,
    }).verdict;
}

/** Loads the committed weights and returns the judge, reporting a model that didn't load. */
export function defaultLooksLikeJudge(onUnavailable: (error: string) => void): LooksLikeJudge {
  const loaded = loadLooksLikeModel();
  if (loaded.status !== "loaded") {
    onUnavailable(loaded.error);
    return looksLikeJudge(undefined);
  }
  return looksLikeJudge(loaded.model);
}

/**
 * Counts of hidden messages by reason (I-44). `uncertain` is the number to watch: a rising count means
 * the classifier is unsure, slow or missing, and mail is hidden to be safe.
 */
export class HideCounts {
  readonly counts: Record<HideReason, number> = { matched: 0, uncertain: 0, unparseable: 0 };

  record(reason: HideReason): void {
    this.counts[reason] += 1;
  }

  snapshot(): Readonly<Record<HideReason, number>> {
    return { ...this.counts };
  }
}
