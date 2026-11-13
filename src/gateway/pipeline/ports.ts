import type { Call, PauseScope, RuleRef, Surface } from "../../core/call.ts";
import type { CompiledHideEntry, StateCheck } from "../../core/rules/compile.ts";
import type { DenyReason, StandingApprovals } from "../../core/rules/evaluate.ts";
import type { HeelDb, HeelTx } from "../../store/db.ts";
import type { AccountRecord } from "../../store/directory.ts";
import type { ApprovalOrigin } from "../../store/schema.ts";
import type { AuthenticatedAgent } from "../agent-tokens.ts";

/**
 * The seams of the decision pipeline. Surfaces (D5 MCP, D6 code mode, D7
 * HTTP, D8 CLI) hand it a `CallRequest`; provider definitions (D9, D11, D12
 * and the passthroughs) normalize, check state, execute and hide; D4b backs
 * the pause and approval stores. Store ports take the caller's query handle
 * so their reads and writes join the decision transaction.
 */

export type HeelQuery = HeelDb | HeelTx;

// ── surfaces ────────────────────────────────────────────────────────────────

/** One call as a surface received it, after the agent token was checked. */
export interface CallRequest {
  /** From the heel token, never from the request body. */
  agent: AuthenticatedAgent;
  surface: Surface;
  /** The account alias the call names. */
  account: string;
  tool: string;
  args: unknown;
  /**
   * Whatever the surface's carrier held (MCP `_meta`, the `Heel-Run-Id`
   * header, the forwarded `HEEL_RUN_ID`, code mode's `run_id`), unparsed:
   * the pipeline validates it the same way for every surface.
   */
  runId?: unknown;
}

// ── provider definitions ────────────────────────────────────────────────────

/**
 * Denies a definition applies while normalizing, before any rule runs.
 * Global watch never relaxes them (spec: Rules, "Watch mode").
 */
export const HARD_DENY_REASONS = [
  /** A command that prints credentials (I-31). */
  "credential_exposure",
  /** The call targets a hidden message (I-42). Generic on purpose: never "hidden". */
  "not_available",
  /** A batch heel can't expand into its parts or items. */
  "batch_unexpandable",
  /** A read heel needed to normalize the call (recipients, items, a hide verdict) failed. */
  "lookup_unavailable",
  /** The definition has no such tool, or the call uses something it refuses (a CLI alias). */
  "unsupported",
] as const;
export type HardDenyReason = (typeof HARD_DENY_REASONS)[number];

export type Normalized = { ok: true; call: Call } | { ok: false; reason: HardDenyReason };

export interface NormalizeContext {
  signal: AbortSignal;
  /** The account's hide entries, for refusing calls aimed at a hidden message. */
  hide: readonly CompiledHideEntry[];
}

/**
 * An upstream answered with an error. The definition builds it from the
 * provider's response with every credential value already scrubbed; the
 * pipeline passes it to the agent as is.
 */
export class UpstreamError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`upstream answered ${status}`);
    this.name = "UpstreamError";
    this.status = status;
    this.body = body;
  }
}

/** The definition knows the response shape but couldn't parse this one (spec: Fail-closed). */
export class ResponseUnparseableError extends Error {
  constructor(message = "response does not have the shape heel knows") {
    super(message);
    this.name = "ResponseUnparseableError";
  }
}

export interface Definition {
  /**
   * Fills in what the provider definition derives (action, kind,
   * recipients, items, targets, …) and may rewrite `args` to what will
   * actually run. Identity fields (org, agent, owner, run id, surface,
   * account, provider) must come back unchanged. A failed provider read is
   * `{ ok: false, reason: "lookup_unavailable" }`, never a guess.
   */
  normalize(base: Call, ctx: NormalizeContext): Promise<Normalized>;
  /**
   * Reads the provider state a rule's check needs, with heel's own
   * credential. A throw or a timeout makes the check unavailable, which
   * denies the call. Absent when the provider has no state checks.
   */
  stateCheck?(check: StateCheck, call: Call, signal: AbortSignal): Promise<"pass" | "fail">;
  /**
   * Runs the call upstream, attaching the credential. Throws `UpstreamError`
   * for an upstream error response; any other throw means heel doesn't know
   * whether the call took effect.
   */
  execute(call: Call, signal: AbortSignal): Promise<unknown>;
  /**
   * Removes hidden items from an allowed call's result (I-40). Absent when
   * heel doesn't know the response shape (I-46). Throws
   * `ResponseUnparseableError` when the response can't be parsed.
   */
  hide?(call: Call, result: unknown, entries: readonly CompiledHideEntry[]): Promise<unknown>;
}

export interface DefinitionRegistry {
  /** The definition for an account's provider, or null when heel has none. */
  forAccount(account: AccountRecord): Definition | null;
}

// ── pause (D4b) ─────────────────────────────────────────────────────────────

export interface PauseTarget {
  orgId: string;
  agentId: string;
  account: string;
  provider: string;
}

export interface PauseStore {
  /** The scope of a pause covering this call (global, agent, account or provider), or null. */
  find(db: HeelQuery, target: PauseTarget): PauseScope | null;
}

// ── approvals (D4b) ─────────────────────────────────────────────────────────

/** Where the request for a call hash stands. `executed` requests never govern. */
export type GoverningStatus = "pending" | "approved" | "denied" | "expired";

export interface GoverningApproval {
  id: string;
  status: GoverningStatus;
  /** Content hash of the rule that asked; an approval satisfies an ask from that rule only. */
  ruleHash: string;
}

export interface ApprovalRequest {
  /** The normalized call, exactly as it will run if approved. */
  call: Call;
  callHash: string;
  rule: RuleRef;
  ruleHash: string;
  origin: ApprovalOrigin;
}

export interface ApprovalStore {
  /**
   * The request that governs this call hash now, or null when none does:
   * a pending one (repeats join it, I-51), an approved one not yet used, a
   * denied one inside its TTL (Q-A5), or an expired one (I-55). The store
   * owns the TTLs and decides when an expired or denied request stops
   * governing, so a later identical call creates a new request.
   */
  governing(db: HeelQuery, orgId: string, callHash: string, now: Date): GoverningApproval | null;
  /** Creates a pending request and returns its id. Called only when none governs. */
  request(db: HeelQuery, input: ApprovalRequest, now: Date): string;
  /**
   * Moves an approved request to executed (I-54). Throws when it is no
   * longer approved; the decision then fails closed.
   */
  consume(db: HeelQuery, approvalId: string, now: Date): void;
  /** This agent's live standing approvals, for the evaluator. */
  standing(db: HeelQuery, call: Call, now: Date): StandingApprovals;
}

// ── results ─────────────────────────────────────────────────────────────────

/** Why the pipeline denied a call, beyond the evaluator's reasons. */
export type PipelineDenyReason =
  | DenyReason
  | HardDenyReason
  /** Anything that went wrong between receiving the call and executing it. */
  | "internal"
  /** The account doesn't exist, or the agent's owner may not use it. */
  | "account_unavailable"
  /** The account's OAuth grant needs reconnecting. */
  | "reconnect_required"
  /** heel has no definition for the account's provider. */
  | "provider_unavailable"
  /** A person denied this exact call and its TTL hasn't run out (Q-A5). */
  | "approval_denied"
  /** The upstream response couldn't be parsed on a surface whose shape heel knows. */
  | "response_unparseable";

/** How an executed call got through. */
export type AllowedVia =
  | { kind: "rule"; rule: RuleRef; standingApprovalId: string | null }
  | { kind: "approval"; rule: RuleRef; approvalId: string }
  /** Global watch let a would-be deny or ask run (I-71). */
  | { kind: "watch"; rule: RuleRef | null };

export type PipelineResult =
  | { status: "allowed"; result: unknown; via: AllowedVia }
  | { status: "pending"; approvalId: string; rule: RuleRef }
  | {
      status: "denied";
      reason: PipelineDenyReason;
      rule: RuleRef | null;
      approvalId?: string;
    }
  | { status: "paused"; scope: PauseScope }
  | { status: "expired"; approvalId: string }
  /** The upstream answered with an error; the call ran and stays counted. */
  | { status: "upstream_error"; upstreamStatus: number; body: unknown }
  /** The request may have reached the upstream; heel never retries a write by itself. */
  | { status: "upstream_outcome_unknown" };

/** The stages in the order a call meets them, for tracing and the order test. */
export type PipelineStage =
  | "account"
  | "pause"
  | "normalize"
  | "approval"
  | "state"
  | "counts"
  | "decide"
  | "execute"
  | "hide";
