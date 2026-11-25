/**
 * Approval hints: what an approval adapter tells the person deciding a
 * pending request ("asks for money", "looks routine for this agent"). Pure.
 *
 * Hints are advisory. They never change a verdict: an approval adapter runs
 * after the request is already pending, its output is stored beside it, and
 * the approval page shows it next to the full call. The person still decides
 * (a model may annotate the approval queue but never answers
 * for the person).
 *
 * This module holds the Jev adapter's questions and the truth table that
 * turns its answers into hints, so the wording and the thresholds are in one
 * place to read and edit. The adapter (adapters/jev.ts) only does the I/O.
 */

/** How a hint reads on the approval page. */
export type HintTone = "warn" | "note" | "ok";

export interface ApprovalHint {
  tone: HintTone;
  text: string;
}

/** One adapter's hints for one request, as stored. */
export type ApprovalHints =
  | { status: "ok"; hints: ApprovalHint[] }
  /** The adapter failed or timed out: the page says so, never "looks routine". */
  | { status: "unavailable"; detail: string };

const MAX_HINTS = 8;
const MAX_HINT_LENGTH = 200;

/** Validates what an adapter returned. Anything malformed is `unavailable`. */
export function parseHints(value: unknown): ApprovalHints {
  if (!Array.isArray(value) || value.length > MAX_HINTS) {
    return { status: "unavailable", detail: "the adapter returned something other than hints" };
  }
  const hints: ApprovalHint[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) {
      return { status: "unavailable", detail: "the adapter returned a malformed hint" };
    }
    const { tone, text } = item as Record<string, unknown>;
    if (
      (tone !== "warn" && tone !== "note" && tone !== "ok") ||
      typeof text !== "string" ||
      text.length === 0 ||
      text.length > MAX_HINT_LENGTH
    ) {
      return { status: "unavailable", detail: "the adapter returned a malformed hint" };
    }
    hints.push({ tone, text });
  }
  return { status: "ok", hints };
}

/**
 * A Noul question (the probability that the answer is yes), in TypeSafe's
 * request shape. Each asks for one judgment a person could make at a glance
 * from the state (`JevState`); code decides what the answers mean.
 */
export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria: { true: string; false: string };
}

/** What Jev is shown for one pending call. Built by the adapter from the stored call. */
export interface JevState {
  agent: string;
  account: string;
  provider: string;
  call: { tool: string; action: string | null; arguments: unknown };
  /** This agent's calls before this one, newest first. Empty for its first call. */
  recent_calls: { account: string; tool: string; action: string | null; outcome: string }[];
}

export const JEV_QUESTIONS = {
  contains_secret: {
    type: "noul",
    instructions: "Does `call.arguments` contain a password, API key, access token or private key?",
    criteria: {
      true: "A credential appears in the arguments, such as a password, an API key, a bearer token or a private key.",
      false:
        "The arguments hold no credential: ordinary text, ids, email addresses, names and links.",
    },
  },
  contains_personal_data: {
    type: "noul",
    instructions:
      "Does `call.arguments` contain a payment card number, a government ID number or a bank account number?",
    criteria: {
      true: "A card number, a passport, social security or tax number, or a bank account or routing number appears.",
      false: "No card, government ID or bank account numbers appear.",
    },
  },
  asks_for_money_or_access: {
    type: "noul",
    instructions:
      "Does `call.arguments` ask someone to send money, make a payment, or give access to an account?",
    criteria: {
      true: "The text asks the reader to pay, wire or transfer money, buy gift cards, share a password or login code, or grant access.",
      false:
        "No request for money or access, for example scheduling, status updates, questions or sharing documents.",
    },
  },
  like_recent_calls: {
    type: "noul",
    instructions: "Is `call` the same kind of action as this agent's `recent_calls`?",
    criteria: {
      true: "The same accounts and tools, used for the same kind of work as the recent calls.",
      false:
        "A different account, a different tool, or a different kind of work from the recent calls.",
    },
  },
} as const satisfies Record<string, NoulQuestion>;

export type JevQuestionId = keyof typeof JEV_QUESTIONS;

/** Above this a Noul reads as yes, below `NO` as no; between, the state doesn't settle it. */
export const YES = 0.7;
export const NO = 0.3;

const RISKS: [JevQuestionId, string][] = [
  ["contains_secret", "Contains what looks like a password, key or token."],
  ["contains_personal_data", "Contains a card, ID or bank account number."],
  ["asks_for_money_or_access", "Asks someone for money, a payment or account access."],
];

/**
 * The truth table. Each risk Jev is sure about is a warning; one it isn't
 * sure about adds nothing (no hint is better than a guess). "Looks routine"
 * needs every risk clearly absent, the call clearly like recent work, and
 * the whole of the arguments checked. With no recent calls, code says so
 * instead of asking Jev.
 */
export function hintsFromAnswers(
  answers: Partial<Record<JevQuestionId, number>>,
  { firstCall, truncated }: { firstCall: boolean; truncated: boolean },
): ApprovalHint[] {
  const hints: ApprovalHint[] = [];
  for (const [id, text] of RISKS) {
    if ((answers[id] ?? 0) > YES) hints.push({ tone: "warn", text });
  }
  const like = answers.like_recent_calls;
  if (firstCall) {
    hints.push({ tone: "note", text: "This agent's first call: nothing to compare it with." });
  } else if (like !== undefined && like < NO) {
    hints.push({ tone: "note", text: "Unlike this agent's recent calls." });
  }
  // Jev saw only part of very long arguments: what it didn't see can't be called clear.
  if (truncated) {
    hints.push({ tone: "note", text: "Long arguments: only the first part was checked." });
  }
  const risksClear = RISKS.every(([id]) => (answers[id] ?? 1) < NO);
  if (risksClear && !firstCall && !truncated && like !== undefined && like > YES) {
    hints.push({ tone: "ok", text: "Looks routine for this agent." });
  }
  return hints;
}
