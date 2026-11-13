/**
 * Training for the `looks_like` linear heads. Pure: messages in, weights and
 * thresholds out; the gen script does the I/O.
 *
 * Each head is class-balanced logistic regression over the runtime's own
 * hashed features, fitted with AdaGrad and L2. Thresholds come from grouped
 * cross-validation over the training units only (template sources, heel
 * families, Enron mailbox owners), so every out-of-fold score is what the
 * model gives a source it never saw. The held-out split is never read here.
 */
import {
  extractFeatures,
  type HashedFeatures,
  hashFeatures,
} from "../../../src/core/lookslike/features.ts";
import { scoreHead } from "../../../src/core/lookslike/model.ts";
import { matchLooksLikePatterns } from "../../../src/core/lookslike/patterns.ts";
import { prepareMessage } from "../../../src/core/lookslike/text.ts";
import type { LooksLikeCategory, LooksLikeMessage } from "../../../src/core/lookslike/types.ts";
import { unitHash } from "./hashing.ts";
import { makeRng } from "./synthetic/context.ts";

export interface LabeledMessage {
  id: string;
  /** The cross-validation group: a template source, a heel family or an Enron mailbox owner. */
  group: string;
  labels: readonly LooksLikeCategory[];
  /** Ordinary mail from the public corpus: what the false-positive gate is measured on. */
  ordinary: boolean;
  message: LooksLikeMessage;
}

export interface EncodedMessage {
  id: string;
  group: string;
  labels: readonly LooksLikeCategory[];
  ordinary: boolean;
  x: HashedFeatures;
  /** Categories a pattern already hides: the classifier is never asked about these. */
  patternHits: ReadonlySet<LooksLikeCategory>;
  unreadable: boolean;
}

/** Runs each message through the runtime's preparation, patterns and feature hashing once. */
export function encodeMessages(
  messages: readonly LabeledMessage[],
  dims: number,
): EncodedMessage[] {
  return messages.map((m) => {
    const prepared = prepareMessage(m.message);
    const hits = matchLooksLikePatterns(prepared);
    return {
      id: m.id,
      group: m.group,
      labels: m.labels,
      ordinary: m.ordinary,
      x: hashFeatures(extractFeatures(prepared), dims),
      patternHits: new Set(Object.keys(hits) as LooksLikeCategory[]),
      unreadable: prepared.unreadable !== undefined,
    };
  });
}

export interface Example {
  x: HashedFeatures;
  y: 0 | 1;
}

/**
 * One head's examples: its category's positives against mail with no label.
 * Positives of the other category are left out, so the reset head is never
 * taught that a login code is ordinary mail (and vice versa); hiding one
 * kind of credential mail under the other's entry is the cheap mistake.
 */
export function headExamples(
  encoded: readonly EncodedMessage[],
  category: LooksLikeCategory,
): Example[] {
  const out: Example[] = [];
  for (const m of encoded) {
    if (m.labels.includes(category)) out.push({ x: m.x, y: 1 });
    else if (m.labels.length === 0) out.push({ x: m.x, y: 0 });
  }
  return out;
}

export interface TrainOptions {
  dims: number;
  epochs: number;
  learningRate: number;
  l2: number;
  seed: string;
}

export interface LinearHead {
  bias: number;
  weights: Float32Array;
}

/** Class-balanced logistic regression, AdaGrad, L2 applied to the touched coordinates. */
export function trainHead(examples: readonly Example[], options: TrainOptions): LinearHead {
  const positives = examples.filter((e) => e.y === 1).length;
  const negatives = examples.length - positives;
  if (positives === 0 || negatives === 0)
    throw new Error("a head needs both positives and negatives");
  const classWeight = {
    1: examples.length / (2 * positives),
    0: examples.length / (2 * negatives),
  };
  const w = new Float64Array(options.dims);
  const g2 = new Float64Array(options.dims);
  let bias = 0;
  let biasG2 = 0;
  const rng = makeRng(options.seed);
  const order = examples.map((_, i) => i);
  for (let epoch = 0; epoch < options.epochs; epoch += 1) {
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng.next() * (i + 1));
      [order[i], order[j]] = [order[j] as number, order[i] as number];
    }
    for (const index of order) {
      const { x, y } = examples[index] as Example;
      let logit = bias;
      for (let k = 0; k < x.indices.length; k += 1)
        logit += (w[x.indices[k] as number] as number) * (x.values[k] as number);
      const p = 1 / (1 + Math.exp(-logit));
      const g = (p - y) * classWeight[y];
      for (let k = 0; k < x.indices.length; k += 1) {
        const at = x.indices[k] as number;
        const grad = g * (x.values[k] as number) + options.l2 * (w[at] as number);
        g2[at] = (g2[at] as number) + grad * grad;
        w[at] =
          (w[at] as number) - (options.learningRate * grad) / (Math.sqrt(g2[at] as number) + 1e-8);
      }
      biasG2 += g * g;
      bias -= (options.learningRate * g) / (Math.sqrt(biasG2) + 1e-8);
    }
  }
  return { bias, weights: Float32Array.from(w) };
}

/** The fold a group falls in. Groups, not messages, so a source is never in two folds. */
export function foldOf(group: string, seed: string, folds: number): number {
  return Math.min(folds - 1, Math.floor(unitHash(seed, `fold:${group}`) * folds));
}

/** Scores every example of one head with a model that never saw its group. */
export function outOfFoldScores(
  encoded: readonly EncodedMessage[],
  category: LooksLikeCategory,
  options: TrainOptions,
  folds: number,
): Map<string, number> {
  const scores = new Map<string, number>();
  const included = encoded.filter((m) => m.labels.includes(category) || m.labels.length === 0);
  for (let fold = 0; fold < folds; fold += 1) {
    const inFold = (m: EncodedMessage) => foldOf(m.group, options.seed, folds) === fold;
    const held = included.filter(inFold);
    if (held.length === 0) continue;
    const head = trainHead(
      headExamples(
        included.filter((m) => !inFold(m)),
        category,
      ),
      {
        ...options,
        seed: `${options.seed}:fold${fold}`,
      },
    );
    for (const m of held) scores.set(m.id, scoreHead(head, m.x));
  }
  return scores;
}

export interface ThresholdPolicy {
  /** Out-of-fold recall the threshold must keep; pattern hits and unreadable mail count as hidden. */
  targetRecall: number;
  /**
   * Out-of-fold share of ordinary mail this head may hide on its own. Spent
   * on recall margin: the threshold drops as far as this budget allows.
   */
  ordinaryFprBudget: number;
}

export interface ThresholdChoice {
  noMatchBelow: number;
  matchAt: number;
  /** Which constraint set `noMatchBelow`: the FPR budget, the recall target, or the 0.5 ceiling. */
  boundBy: "fpr_budget" | "recall_target" | "ceiling";
  /** Out-of-fold recall at `noMatchBelow`. */
  recall: number;
  /** Out-of-fold share of ordinary mail this head alone hides at `noMatchBelow`. */
  ordinaryFpr: number;
  /** The same for the synthetic hard negatives: a diagnostic, not a gate. */
  hardNegativeFpr: number;
  positives: number;
  ordinary: number;
  hardNegatives: number;
}

const MIN_THRESHOLD = 1e-6;
/** `matchAt` never goes below this: under it a head is at best unsure. */
const MATCH_AT = 0.5;

/**
 * Picks `noMatchBelow` from out-of-fold scores. Two candidates:
 * - the recall pivot: the highest threshold that keeps `targetRecall`;
 * - the budget floor: the lowest threshold that hides at most
 *   `ordinaryFprBudget` of ordinary mail.
 * The lower of the two wins (recall is never traded for the budget), capped
 * at `matchAt`. Messages a pattern catches, or that are unreadable, are
 * hidden whatever the score, so they constrain neither.
 */
export function chooseThresholds(
  encoded: readonly EncodedMessage[],
  category: LooksLikeCategory,
  scores: ReadonlyMap<string, number>,
  policy: ThresholdPolicy,
): ThresholdChoice {
  const caught = (m: EncodedMessage) => m.patternHits.has(category) || m.unreadable;
  const scoreOf = (m: EncodedMessage) => {
    const s = scores.get(m.id);
    if (s === undefined) throw new Error(`no out-of-fold score for ${m.id}`);
    return s;
  };
  const positives = encoded.filter((m) => m.labels.includes(category));
  const unlabelled = encoded.filter((m) => m.labels.length === 0);
  const ordinary = unlabelled.filter((m) => m.ordinary);
  const hardNegatives = unlabelled.filter((m) => !m.ordinary);

  const uncaughtPositives = positives
    .filter((m) => !caught(m))
    .map(scoreOf)
    .sort((a, b) => a - b);
  const recallPivot =
    uncaughtPositives[Math.floor((1 - policy.targetRecall) * positives.length)] ?? 1;

  const ordinaryDesc = ordinary
    .filter((m) => !caught(m))
    .map(scoreOf)
    .sort((a, b) => b - a);
  const allowed = Math.floor(policy.ordinaryFprBudget * ordinary.length);
  // Midway between the last score the budget lets through and the first it doesn't.
  const budgetFloor =
    allowed >= ordinaryDesc.length
      ? 0
      : ((ordinaryDesc[allowed] as number) + (ordinaryDesc[allowed - 1] ?? 1)) / 2;

  const lower = Math.min(recallPivot, budgetFloor);
  const noMatchBelow = Math.max(MIN_THRESHOLD, Math.min(MATCH_AT, lower));
  const boundBy =
    lower >= MATCH_AT ? "ceiling" : recallPivot < budgetFloor ? "recall_target" : "fpr_budget";
  const hidden = (m: EncodedMessage) => caught(m) || scoreOf(m) >= noMatchBelow;
  const share = (set: readonly EncodedMessage[]) =>
    set.length === 0
      ? 0
      : set.filter((m) => !caught(m) && scoreOf(m) >= noMatchBelow).length / set.length;
  return {
    noMatchBelow,
    matchAt: Math.max(MATCH_AT, noMatchBelow),
    boundBy,
    recall: positives.length === 0 ? 1 : positives.filter(hidden).length / positives.length,
    ordinaryFpr: share(ordinary),
    hardNegativeFpr: share(hardNegatives),
    positives: positives.length,
    ordinary: ordinary.length,
    hardNegatives: hardNegatives.length,
  };
}
