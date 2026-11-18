import type { LooksLikeCategory, LooksLikeMessage, LooksLikeVerdict } from "./lookslike/types.ts";
import type { CompiledHideEntry, HideField } from "./rules/compile.ts";
import type { FieldValue } from "./rules/facts.ts";
import { allOf, evalCondition, type Outcome } from "./rules/match.ts";

/**
 * Whether one message is hidden from agents (spec: Hiding). Pure: the
 * `looks_like` judge is passed in, so this module never loads a model or
 * reads a clock.
 *
 * - Keys inside one entry are ANDed; a message matching any entry is hidden.
 * - `from`, `to`, `subject` and `labels` are plain checks, as in rules.
 * - `looks_like` is judged per message. A `match` or an `uncertain` verdict
 *   both satisfy it, because hiding fails closed (I-44): an unsure, slow,
 *   missing or failing classifier hides the message.
 * - It can only ever add to what is hidden (I-43): nothing here unhides.
 * - An address heel can't parse makes the entry undecidable, which also
 *   hides the message, the same fail-closed way.
 */

/** One message as the hide path sees it. Nothing here leaves heel. */
export interface HideCandidate {
  from: string | null;
  /** To, Cc and Bcc together. */
  to: readonly string[];
  subject: string | null;
  /** Label or folder names (not ids). */
  labels: readonly string[];
  /** Needed only when an entry uses `looks_like`; see `needsBody`. */
  body?: Pick<LooksLikeMessage, "body" | "bodyFormat" | "unreadable">;
}

/** Judges one message for some `looks_like` categories. Must not throw. */
export type LooksLikeJudge = (
  message: LooksLikeMessage,
  categories: readonly LooksLikeCategory[],
) => LooksLikeVerdict;

/** Why a message is hidden, for the metric (I-44); never shown to the agent. */
export type HideReason =
  /** Its plain checks matched an entry (and any `looks_like` said match). */
  | "matched"
  /** An entry hinged on a `looks_like` that wasn't sure, so it fails closed. */
  | "uncertain"
  /** An address in the message didn't parse, so the entry couldn't be decided. */
  | "unparseable";

export type HideVerdict =
  | { hidden: false }
  | { hidden: true; reason: HideReason; entry: { file: string; line: number } };

/** Whether any entry needs the message body: only `looks_like` does. Callers skip body reads otherwise. */
export function needsBody(entries: readonly CompiledHideEntry[]): boolean {
  return entries.some((entry) => entry.looksLike.length > 0);
}

function fieldValue(candidate: HideCandidate, field: HideField): FieldValue {
  switch (field) {
    case "from":
      return candidate.from === null
        ? { kind: "absent" }
        : { kind: "single", value: candidate.from };
    case "subject":
      return candidate.subject === null
        ? { kind: "absent" }
        : { kind: "single", value: candidate.subject };
    case "to":
      return { kind: "list", values: candidate.to };
    case "labels":
      return { kind: "list", values: candidate.labels };
  }
}

function looksLikeOutcome(
  entry: CompiledHideEntry,
  candidate: HideCandidate,
  judge: LooksLikeJudge,
): { outcome: Outcome; uncertain: boolean } {
  if (entry.looksLike.length === 0) return { outcome: true, uncertain: false };
  const body = candidate.body ?? {
    body: "",
    bodyFormat: "text" as const,
    unreadable: "unparseable" as const,
  };
  const verdict = judge(
    {
      subject: candidate.subject ?? "",
      from: candidate.from ?? "",
      body: body.body,
      bodyFormat: body.bodyFormat,
      ...(body.unreadable === undefined ? {} : { unreadable: body.unreadable }),
    },
    entry.looksLike,
  );
  return { outcome: verdict !== "no_match", uncertain: verdict === "uncertain" };
}

export function hideVerdict(
  entries: readonly CompiledHideEntry[],
  candidate: HideCandidate,
  judge: LooksLikeJudge,
): HideVerdict {
  for (const entry of entries) {
    const plain = allOf(
      entry.conditions.map((condition) =>
        evalCondition(condition, fieldValue(candidate, condition.field)),
      ),
    );
    if (plain === false) continue;
    const at = { file: entry.file, line: entry.line };
    if (plain === "unparseable") return { hidden: true, reason: "unparseable", entry: at };
    const looks = looksLikeOutcome(entry, candidate, judge);
    if (looks.outcome === false) continue;
    return { hidden: true, reason: looks.uncertain ? "uncertain" : "matched", entry: at };
  }
  return { hidden: false };
}

/**
 * One call's view of hiding, built by the pipeline from the account's
 * entries, the `looks_like` judge and the metric. Definitions use it to
 * filter results and to refuse calls aimed at a hidden message; they never
 * see the judge or the counts.
 */
export interface Hiding {
  readonly entries: readonly CompiledHideEntry[];
  /** Whether candidates need a body: false means skip the body read entirely. */
  readonly needsBody: boolean;
  isHidden(candidate: HideCandidate): boolean;
}

/** A judge for when no classifier is wired in: every `looks_like` hides (I-44). */
export const UNSURE_JUDGE: LooksLikeJudge = () => "uncertain";

export function hidingFor(
  entries: readonly CompiledHideEntry[],
  judge: LooksLikeJudge,
  onHidden: (reason: HideReason) => void = () => {},
): Hiding {
  return {
    entries,
    needsBody: needsBody(entries),
    isHidden(candidate) {
      const verdict = hideVerdict(entries, candidate, judge);
      if (verdict.hidden) onHidden(verdict.reason);
      return verdict.hidden;
    },
  };
}
