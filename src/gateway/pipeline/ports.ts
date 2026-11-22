import type { Tool } from "@modelcontextprotocol/server";
import type { AdapterDenyReason } from "../../core/adapters.ts";
import type { Call, PauseScope, RuleRef, Surface } from "../../core/call.ts";
import type { Hiding } from "../../core/hide.ts";
import type { StateCheck } from "../../core/rules/compile.ts";
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
  /**
   * Why the agent says it's making the call, in its own words (MCP's
   * `heel_reason` argument). Shown to the approver beside heel's own summary.
   * Never part of the arguments, the call hash or any rule (spec: The approval
   * page): it's what the agent claims, not what the call does.
   */
  reason?: string;
  /**
   * The code-mode script a call came from, and the calls it made before
   * this one (code mode round 2, C3). Shown to the approver as the agent's
   * own code; never part of the arguments, the call hash or any rule.
   */
  script?: ApprovalScript;
  /** heel's id for the code-mode script the call came from (Call.scriptId). */
  scriptId?: string;
  /**
   * Aborts when the surface's request ends early (the client hung up). It
   * stops a call already executing, so a `heel run` command or a script
   * doesn't keep running, and holding a sandbox slot, for nobody.
   */
  signal?: AbortSignal;
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
  /**
   * An address that decides delivery can't be read plainly: a quoted local
   * part, a display name holding `<`, `>` or `@`, a draft header heel would
   * read differently from the provider. Same name as the rules' own deny.
   */
  "address_unparseable",
  /** A send names a `from` the mailbox can't send as (spec: Email, `send`). */
  "sender_not_allowed",
  /** The definition has no such tool, or the call uses something it refuses (a CLI alias). */
  "unsupported",
  /** A `heel run` directory outside the agent's work roots (D8b). */
  "workdir_not_allowed",
  /**
   * The account would put its credential in a sandboxed program's
   * environment, and its operator never chose that (spec: CLI runner,
   * "Credential delivery").
   */
  "credential_delivery",
] as const;
export type HardDenyReason = (typeof HARD_DENY_REASONS)[number];

export type Normalized =
  | { ok: true; call: Call }
  | {
      ok: false;
      reason: HardDenyReason;
      /** What the agent is told beside the reason, e.g. what the operator can do about it. Never secret. */
      detail?: string;
    };

export interface NormalizeContext {
  signal: AbortSignal;
  /** The account's hiding, for refusing calls aimed at a hidden message. */
  hide: Hiding;
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

/**
 * The service turned down the account's key itself (wrong, expired or
 * revoked): nothing ran, so it's an answer, not an unknown outcome. The
 * agent and the log say so, so the owner knows to replace the key rather
 * than guess at heel.
 */
export class CredentialRejectedError extends UpstreamError {
  readonly service: string;

  constructor(service: string) {
    super(401, { error: `${service} rejected the account's key` });
    this.name = "CredentialRejectedError";
    this.service = service;
  }
}

/** Pure: what the agent and the log are told when a service rejects an account's key. */
export function keyRejectedMessage(service: string, account: string): string {
  return (
    `${service} rejected the key heel holds for ${account} (wrong, expired or revoked), so nothing ran. ` +
    "Your owner can replace it on heel's Connections page."
  );
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
  /**
   * The tools an agent sees for this account, under their own names. A
   * built-in definition lists a fixed table; a passthrough lists what its
   * server lists now. Absent on surfaces with no tool list (HTTP, CLI).
   */
  tools?(signal: AbortSignal): Promise<Tool[]>;
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
   * How long `execute` may take, when not the pipeline's upstream deadline:
   * a `heel run` command has the sandbox's own wall-time limit (D8b).
   */
  executeTimeoutMs?: number;
  /**
   * Removes hidden items from an allowed call's result (I-40). Absent when
   * heel doesn't know the response shape (I-46). Throws
   * `ResponseUnparseableError` when the response can't be parsed.
   */
  hide?(call: Call, result: unknown, hiding: Hiding): Promise<unknown>;
}

export interface DefinitionRegistry {
  /** The definition for an account's provider, or null when heel has none. */
  forAccount(account: AccountRecord): Definition | null;
}

// ── pause (D4b) ─────────────────────────────────────────────────────────────

export interface PauseTarget {
  orgId: string;
  agentId: string;
  /** The agent's owner: an `owner` pause covers every agent they own. */
  ownerId: string;
  account: string;
  provider: string;
}

export interface PauseStore {
  /** The scope of a pause covering this call (global, owner, agent, account or provider), or null. */
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
  /** The agent's own reason (CallRequest.reason), or null when it gave none. */
  reason: string | null;
  /** The agent's MCP client, self-reported (AuthenticatedAgent.clientName), or null. */
  client: string | null;
  /** The script the call came from (CallRequest.script), or null. */
  script: ApprovalScript | null;
}

/** A code-mode script as the approval page shows it: its code, and what it already called. */
export interface ApprovalScript {
  /** The script's code, cut at `MAX_SCRIPT_CHARS`. */
  code: string;
  /** Whether `code` was cut. */
  truncated: boolean;
  /** The calls it made before this one, in order. */
  before: { account: string; tool: string; decision: string }[];
}

/** The most of a script heel keeps with an approval. */
export const MAX_SCRIPT_CHARS = 20_000;

/** Pure: a script as an approval keeps it, cut to `MAX_SCRIPT_CHARS`. */
export function approvalScript(
  code: string,
  before: readonly { account: string; tool: string; decision: string }[],
): ApprovalScript {
  return {
    code: code.slice(0, MAX_SCRIPT_CHARS),
    truncated: code.length > MAX_SCRIPT_CHARS,
    before: before.map(({ account, tool, decision }) => ({ account, tool, decision })),
  };
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
  /** This agent's live standing approvals for the call, whose hash the pipeline already holds. */
  standing(db: HeelQuery, call: Call, callHash: string, now: Date): StandingApprovals;
}

// ── decision adapters ───────────────────────────────────────────────────────

/**
 * What a decision adapter is told about a call. The rules have already
 * decided it would run, or would wait for a person: an adapter is never
 * consulted on a call the rules deny, so no call data leaves heel for it.
 */
export interface AdapterInput {
  /** The normalized call, exactly as it will run. */
  call: Call;
  callHash: string;
  /**
   * What heel would do without the adapters: `allow` (a rule, a standing
   * approval or global watch lets it run) or `ask` (it needs a person).
   */
  tentative: "allow" | "ask";
  /** The rule behind `tentative`; null when global watch lets a default deny run. */
  rule: RuleRef | null;
}

/**
 * A check that runs beside the rules: a security service, OpenFGA, a model,
 * anything. It can only tighten (see core/adapters.ts): it answers
 * `{ decision: "pass" }` or `{ decision: "deny", reason }`. Anything else, a
 * throw, or no answer before the deadline denies the call.
 */
export interface DecisionAdapter {
  /** Matches `ADAPTER_NAME`; goes in the audit row of a call it denies. */
  readonly name: string;
  /** Log what it would deny without deciding, like a `watch: true` rule. */
  readonly watch?: boolean;
  check(input: AdapterInput, signal: AbortSignal): Promise<unknown>;
}

/**
 * A check on what an allowed call returned, after hiding: it never sees a
 * hidden item. It answers `{ decision: "pass" }` or `{ decision: "withhold",
 * reason }`; anything else, a throw or no answer withholds the result.
 */
export interface ResponseAdapter {
  readonly name: string;
  check(call: Call, result: unknown, signal: AbortSignal): Promise<unknown>;
}

/** What an approval adapter is told about a request that is now pending. */
export interface ApprovalHintInput {
  approvalId: string;
  /** The normalized call, exactly as it will run if approved. */
  call: Call;
  agentName: string;
  /** The agent's calls before this one, newest first (from the audit log). */
  recentCalls: readonly { account: string; tool: string; action: string | null; outcome: string }[];
}

/**
 * Advice for the person deciding a pending request (core/hints.ts). It runs
 * after the request committed and its answer is only shown on the approval
 * page, so it can't change any verdict: there is nothing for it to return
 * but hints. It answers an array of `{ tone, text }`; anything else, a
 * throw or no answer in time shows "hints unavailable".
 */
export interface ApprovalAdapter {
  readonly name: string;
  hints(input: ApprovalHintInput, signal: AbortSignal): Promise<unknown>;
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
  | "response_unparseable"
  /** A decision adapter denied the call, or couldn't answer. */
  | AdapterDenyReason
  /** The call ran, and a response adapter kept its result from the agent. */
  | "response_withheld";

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
      /** The adapter that denied the call or withheld its result. */
      adapter?: string;
      /** The call ran upstream; only its result was withheld (hiding or a response adapter). */
      executed?: true;
      /** A definition's explanation of a hard deny, passed to the agent as is. */
      detail?: string;
    }
  | { status: "paused"; scope: PauseScope }
  | { status: "expired"; approvalId: string }
  /**
   * The upstream answered with an error; the call ran and stays counted.
   * `message`, when set, is what to tell the agent (a rejected key).
   */
  | { status: "upstream_error"; upstreamStatus: number; body: unknown; message?: string }
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
  /** Decision adapters, outside the transaction; only when some are configured. */
  | "adapters"
  | "execute"
  | "hide"
  /** Response adapters; only when some are configured. */
  | "respond";
