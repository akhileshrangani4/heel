/**
 * Decision adapters: pluggable checks that run beside the rules engine.
 * Pure: the gateway
 * runs the adapters and this module decides what their answers mean.
 *
 * An adapter can only tighten. It answers `pass` or `deny`, never `allow`,
 * so the chain can stop a call the rules would allow or ask about, but it
 * can never let through a call the rules deny. `pass` is not an allow: a
 * call still needs an affirmative allow from the rules (I-10), whatever
 * the adapters say. An adapter that throws, times out or answers with
 * anything else is `unavailable`, which denies the call (fail closed).
 *
 * Response adapters run after hiding, on what would reach the agent. They
 * answer `pass` or `withhold`; they can't rewrite a result.
 */

/** What a decision adapter answered for one call. */
export type AdapterVerdict = { decision: "pass" } | { decision: "deny"; reason: string };

/** What a response adapter answered for one result. */
export type ResponseVerdict = { decision: "pass" } | { decision: "withhold"; reason: string };

/** One adapter's answer for a call, as the gateway gathered it. */
export interface AdapterOutcome {
  /** The adapter's configured name; it goes in the audit row. */
  adapter: string;
  /** A watching adapter's deny is logged as "would deny" and never decides. */
  watch: boolean;
  verdict: AdapterVerdict | { decision: "unavailable" };
}

export type AdapterDenyReason = "adapter_denied" | "adapter_unavailable";

export interface AdapterDeny {
  adapter: string;
  reason: AdapterDenyReason;
  /** The adapter's own explanation, when it gave one. Never shown to the agent. */
  detail: string | null;
}

export interface ChainResult {
  /** The first deny from an adapter that isn't watching, in chain order; null when all passed. */
  deny: AdapterDeny | null;
  /** Denies from watching adapters, in chain order: each becomes a "would deny" row. */
  wouldDeny: readonly AdapterDeny[];
}

/** The longest adapter explanation heel keeps; the rest is cut. */
export const MAX_ADAPTER_DETAIL = 200;

/** Adapter names: what config and audit rows use to identify one. */
export const ADAPTER_NAME = /^[a-z][a-z0-9_-]{0,39}$/;

function detailOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.slice(0, MAX_ADAPTER_DETAIL);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads what a decision adapter returned. Only `pass` and `deny` mean
 * anything; an `allow`, a missing decision or any other shape is
 * unavailable, so a buggy or hostile adapter can't loosen a call.
 */
export function parseAdapterVerdict(value: unknown): AdapterOutcome["verdict"] {
  if (!isRecord(value)) return { decision: "unavailable" };
  if (value["decision"] === "pass") return { decision: "pass" };
  if (value["decision"] === "deny") {
    return { decision: "deny", reason: detailOf(value["reason"]) ?? "" };
  }
  return { decision: "unavailable" };
}

/**
 * Reads what a response adapter returned. Only `pass` lets the result
 * through; anything else withholds it.
 */
export function parseResponseVerdict(value: unknown): ResponseVerdict {
  if (isRecord(value) && value["decision"] === "pass") return { decision: "pass" };
  const reason = isRecord(value) ? detailOf(value["reason"]) : null;
  return { decision: "withhold", reason: reason ?? "" };
}

function denyOf(outcome: AdapterOutcome): AdapterDeny | null {
  const { verdict } = outcome;
  switch (verdict.decision) {
    case "pass":
      return null;
    case "deny":
      return {
        adapter: outcome.adapter,
        reason: "adapter_denied",
        detail: verdict.reason === "" ? null : verdict.reason,
      };
    case "unavailable":
      return { adapter: outcome.adapter, reason: "adapter_unavailable", detail: null };
  }
}

/**
 * Combines the chain's answers, most restrictive first: any deny from an
 * adapter that isn't watching denies the call. A watching adapter's deny
 * is recorded and never decides.
 */
export function combineAdapters(outcomes: readonly AdapterOutcome[]): ChainResult {
  let deny: AdapterDeny | null = null;
  const wouldDeny: AdapterDeny[] = [];
  for (const outcome of outcomes) {
    const denied = denyOf(outcome);
    if (denied === null) continue;
    if (outcome.watch) wouldDeny.push(denied);
    else deny ??= denied;
  }
  return { deny, wouldDeny };
}
