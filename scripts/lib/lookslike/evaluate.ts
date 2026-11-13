/**
 * Pure: measures the `looks_like` detector on a labelled set and applies the
 * release gate (spec: Hiding, `looks_like`; D10 row). Shared by
 * `pnpm gen:looks-like` (training summary) and `pnpm eval:looks-like` (gate).
 *
 * "Hidden" means any verdict other than `no_match`: `match` and `uncertain`
 * both hide (I-44). Recall classifies each positive against its own category
 * only, so the other head can't rescue a miss. The false-positive rate
 * classifies against both categories, as `looks_like: [password_reset,
 * login_code]` will in a hide entry.
 */
import { classifyLooksLike } from "../../../src/core/lookslike/classify.ts";
import type { LooksLikeModel } from "../../../src/core/lookslike/model.ts";
import {
  LOOKS_LIKE_CATEGORIES,
  type LooksLikeCategory,
  type LooksLikeResult,
} from "../../../src/core/lookslike/types.ts";
import type { LabeledMessage } from "./train.ts";

export interface Rate {
  hidden: number;
  total: number;
  rate: number;
}

export interface GateSettings {
  minRecall: number;
  maxOrdinaryFpr: number;
  minPositivesPerCategory: number;
  minOrdinary: number;
}

export interface EvalReport {
  recall: Record<LooksLikeCategory, Rate>;
  /** The gated false-positive rate: ordinary mail from the public corpus. */
  ordinaryFpr: Rate;
  /** Synthetic transactional and account-notice mail: reported, not gated. */
  hardNegativeFpr: Rate;
  /** Recall per category per group (template source), weakest first. */
  recallByGroup: Array<{ category: LooksLikeCategory; group: string } & Rate>;
  /** Why ordinary mail was hidden, e.g. `pattern:reset_url` or `classifier:uncertain`. */
  ordinaryHiddenBy: Record<string, number>;
  /** Ids of positives that were not hidden. Synthetic ids only: no text. */
  missed: Array<{ id: string; category: LooksLikeCategory }>;
  failures: string[];
  pass: boolean;
}

const rate = (hidden: number, total: number): Rate => ({
  hidden,
  total,
  rate: total === 0 ? 0 : hidden / total,
});

/** The first reason that hid the message: a pattern, unreadable mail, then the classifier. */
export function hiddenBy(result: LooksLikeResult): string {
  const reasons = Object.values(result.categories).filter(
    (c) => c !== undefined && c.verdict !== "no_match",
  );
  for (const kind of [
    "pattern",
    "unreadable",
    "classifier",
    "model_unavailable",
    "timeout",
    "error",
  ] as const) {
    const found = reasons.find((c) => c?.reason.kind === kind);
    if (!found) continue;
    const reason = found.reason;
    if (reason.kind === "pattern") return `pattern:${reason.pattern}`;
    if (reason.kind === "unreadable") return `unreadable:${reason.detail}`;
    if (reason.kind === "classifier") return `classifier:${found.verdict}`;
    return reason.kind;
  }
  return "unknown";
}

export function evaluateLooksLike(
  messages: readonly LabeledMessage[],
  model: LooksLikeModel,
  gate: GateSettings,
): EvalReport {
  const options = { model };
  const hides = (result: LooksLikeResult) => result.verdict !== "no_match";

  const recall = {} as Record<LooksLikeCategory, Rate>;
  const recallByGroup: EvalReport["recallByGroup"] = [];
  const missed: EvalReport["missed"] = [];
  for (const category of LOOKS_LIKE_CATEGORIES) {
    const groups = new Map<string, { hidden: number; total: number }>();
    let hidden = 0;
    let total = 0;
    for (const m of messages) {
      if (!m.labels.includes(category)) continue;
      const hit = hides(classifyLooksLike(m.message, [category], options));
      total += 1;
      if (hit) hidden += 1;
      else missed.push({ id: m.id, category });
      const group = groups.get(m.group) ?? { hidden: 0, total: 0 };
      group.total += 1;
      if (hit) group.hidden += 1;
      groups.set(m.group, group);
    }
    recall[category] = rate(hidden, total);
    for (const [group, g] of groups)
      recallByGroup.push({ category, group, ...rate(g.hidden, g.total) });
  }
  recallByGroup.sort((a, b) => a.rate - b.rate || a.group.localeCompare(b.group));

  const ordinaryHiddenBy: Record<string, number> = {};
  let ordinaryHidden = 0;
  let ordinaryTotal = 0;
  let hardHidden = 0;
  let hardTotal = 0;
  for (const m of messages) {
    if (m.labels.length > 0) continue;
    const result = classifyLooksLike(m.message, LOOKS_LIKE_CATEGORIES, options);
    const hit = hides(result);
    if (m.ordinary) {
      ordinaryTotal += 1;
      if (hit) {
        ordinaryHidden += 1;
        const why = hiddenBy(result);
        ordinaryHiddenBy[why] = (ordinaryHiddenBy[why] ?? 0) + 1;
      }
    } else {
      hardTotal += 1;
      if (hit) hardHidden += 1;
    }
  }

  const ordinaryFpr = rate(ordinaryHidden, ordinaryTotal);
  const failures: string[] = [];
  for (const category of LOOKS_LIKE_CATEGORIES) {
    const r = recall[category];
    if (r.total < gate.minPositivesPerCategory) {
      failures.push(
        `${category}: ${r.total} held-out positives, need at least ${gate.minPositivesPerCategory}`,
      );
    } else if (r.rate < gate.minRecall) {
      failures.push(`${category}: recall ${r.rate.toFixed(4)} is below ${gate.minRecall}`);
    }
  }
  if (ordinaryFpr.total < gate.minOrdinary) {
    failures.push(
      `ordinary mail: ${ordinaryFpr.total} held-out messages, need at least ${gate.minOrdinary}`,
    );
  } else if (ordinaryFpr.rate > gate.maxOrdinaryFpr) {
    failures.push(
      `ordinary mail: false-positive rate ${ordinaryFpr.rate.toFixed(4)} is above ${gate.maxOrdinaryFpr}`,
    );
  }

  return {
    recall,
    ordinaryFpr,
    hardNegativeFpr: rate(hardHidden, hardTotal),
    recallByGroup,
    ordinaryHiddenBy,
    missed,
    failures,
    pass: failures.length === 0,
  };
}

/** Human-readable report lines for the console and the CI log. */
export function formatEvalReport(report: EvalReport, title: string): string {
  const pct = (r: Rate) => `${(r.rate * 100).toFixed(2)}% (${r.hidden}/${r.total})`;
  const lines = [
    title,
    ...LOOKS_LIKE_CATEGORIES.map((c) => `  recall ${c}: ${pct(report.recall[c])}`),
    `  false-positive rate, ordinary mail (gated): ${pct(report.ordinaryFpr)}`,
    `  false-positive rate, synthetic hard negatives (diagnostic): ${pct(report.hardNegativeFpr)}`,
    `  ordinary mail hidden by: ${
      Object.entries(report.ordinaryHiddenBy)
        .sort((a, b) => b[1] - a[1])
        .map(([why, n]) => `${why}=${n}`)
        .join(", ") || "nothing"
    }`,
    "  weakest groups:",
    ...report.recallByGroup.slice(0, 5).map((g) => `    ${g.category} ${g.group}: ${pct(g)}`),
  ];
  if (report.missed.length > 0) {
    lines.push(
      `  missed positives: ${report.missed.map((m) => `${m.category}:${m.id}`).join(", ")}`,
    );
  }
  lines.push(
    report.pass
      ? "  gate: PASS"
      : `  gate: FAIL\n${report.failures.map((f) => `    - ${f}`).join("\n")}`,
  );
  return `${lines.join("\n")}\n`;
}
