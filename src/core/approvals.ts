/**
 * The pure rules of approval requests and standing approvals (spec:
 * Approvals, standing approvals and pause). The store applies them; nothing
 * here reads a clock or a database.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export interface ApprovalTtls {
  /** A pending request expires this long after it was created (Q-A4: 24 h). */
  pendingMs: number;
  /** An approval the agent hasn't used expires this long after the decision (Q-A4: 1 h). */
  approvedMs: number;
}

export const DEFAULT_APPROVAL_TTLS: ApprovalTtls = Object.freeze({
  pendingMs: 24 * HOUR_MS,
  approvedMs: HOUR_MS,
});

/** What a request row says about itself. `expires_at` is the deadline for its current state. */
export interface StoredApprovalState {
  status: "pending" | "approved" | "denied" | "expired" | "executed";
  expiresAt: Date;
}

/** Where a request stands for check-back and the approval page. */
export type ApprovalStatusView = StoredApprovalState["status"];

/**
 * Pure: a request's status at `now`. Expiry is lazy: a pending or approved
 * request past its deadline is expired whether or not a row update has
 * caught up yet (I-55). A denied request keeps reading `denied`; its
 * deadline only bounds how long it blocks re-sends (Q-A5).
 */
export function statusAt(row: StoredApprovalState, now: Date): ApprovalStatusView {
  if ((row.status === "pending" || row.status === "approved") && row.expiresAt <= now) {
    return "expired";
  }
  return row.status;
}

/**
 * How a stored request answers an identical call at `now` (spec: Pending,
 * joining and checking back):
 * - `govern`: it decides the call (join, execute, denied or expired);
 * - `settle_expired`: it ran out unused; report `expired` once and record it;
 * - `none`: it no longer governs, so the call is evaluated as new.
 */
export type GoverningOutcome =
  | { kind: "govern"; status: "pending" | "approved" | "denied" }
  | { kind: "settle_expired" }
  | { kind: "none" };

export function governingOutcome(row: StoredApprovalState, now: Date): GoverningOutcome {
  switch (row.status) {
    case "pending":
    case "approved":
      return row.expiresAt <= now
        ? { kind: "settle_expired" }
        : { kind: "govern", status: row.status };
    case "denied":
      // Re-sends inside the original pending TTL return `denied` with the same id (Q-A5).
      return row.expiresAt > now ? { kind: "govern", status: "denied" } : { kind: "none" };
    case "expired":
    case "executed":
      return { kind: "none" };
  }
}

// ── standing approvals ──────────────────────────────────────────────────────

/** The durations an approver may pick (Q-A6); the hard cap is 90 days. */
export const STANDING_DURATIONS = {
  "1h": HOUR_MS,
  "1d": DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
} as const;
export type StandingDuration = keyof typeof STANDING_DURATIONS;
export const STANDING_MAX_MS = 90 * DAY_MS;

export function isStandingDuration(value: unknown): value is StandingDuration {
  return typeof value === "string" && Object.hasOwn(STANDING_DURATIONS, value);
}

export interface StoredStanding {
  agentId: string;
  scope: "exact_call" | "rule";
  callHash: string | null;
  ruleHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export type StandingState = "active" | "expired" | "revoked" | "lapsed";

/**
 * Pure: whether a standing approval still stands. It lapses the moment its
 * parent rule's content hash is no longer in force: an edit of any kind or a
 * deletion (I-16). Moving a rule keeps its hash, so the approval moves with it.
 */
export function standingState(
  row: Pick<StoredStanding, "ruleHash" | "expiresAt" | "revokedAt">,
  liveRuleHashes: ReadonlySet<string>,
  now: Date,
): StandingState {
  if (row.revokedAt !== null) return "revoked";
  if (row.expiresAt <= now) return "expired";
  if (!liveRuleHashes.has(row.ruleHash)) return "lapsed";
  return "active";
}

/**
 * Pure: whether a live standing approval covers a call that matched its
 * parent rule and would ask. It is scoped to one agent; `exact_call` also
 * needs the same account, tool and arguments (Q-A6).
 */
export function standingCovers(
  row: Pick<StoredStanding, "agentId" | "scope" | "callHash" | "ruleHash">,
  call: { agentId: string; ruleHash: string; callHash: () => string },
): boolean {
  if (row.agentId !== call.agentId || row.ruleHash !== call.ruleHash) return false;
  return row.scope === "rule" || row.callHash === call.callHash();
}

// ── deciding ────────────────────────────────────────────────────────────────

export type DecisionIntent = "approve" | "deny";

/** Why a person's decision on a request is refused. */
export type DecisionRefusal =
  /** It was already decided, executed or expired. */
  | "not_pending"
  /** I-61: a pause covers the request; approving would only queue a call that can't run. */
  | "paused"
  /** Only the account's approvers decide its requests; org asks go to admins. */
  | "not_approver"
  /** Q-A7: an org ask is approved once and never stands. */
  | "org_ask_cannot_stand";

export interface DecisionInput {
  intent: DecisionIntent;
  standing: boolean;
  status: ApprovalStatusView;
  origin: "org" | "owner";
  paused: boolean;
  isApprover: boolean;
}

/**
 * Pure: why this decision can't be made, or null when it can. Denying is
 * allowed while paused, since it can only stop a call.
 */
export function decisionRefusal(input: DecisionInput): DecisionRefusal | null {
  if (!input.isApprover) return "not_approver";
  if (input.status !== "pending") return "not_pending";
  if (input.intent === "deny") return null;
  if (input.standing && input.origin === "org") return "org_ask_cannot_stand";
  if (input.paused) return "paused";
  return null;
}
