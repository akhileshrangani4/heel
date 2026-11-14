import type { Logger } from "pino";
import type { AuditEvent } from "../../core/audit.ts";
import type { Call } from "../../core/call.ts";
import { callHash, UNREPRESENTABLE_ARGS, UNREPRESENTABLE_CALL_HASH } from "../../core/call-hash.ts";
import { type CountEvent, storedFacts, sumMatching } from "../../core/counts.ts";
import { isItemCount, SINGLE_ITEM } from "../../core/items.ts";
import type { CompiledHideEntry, CompiledRule, StateCheck } from "../../core/rules/compile.ts";
import {
  type EvalContext,
  type Evaluation,
  evaluate,
  hideEntriesFor,
  type RuleSet,
  type StateOutcome,
  type WatchedRule,
} from "../../core/rules/evaluate.ts";
import { factsOf, type RuleFacts } from "../../core/rules/facts.ts";
import { parseRunId } from "../../core/run-id.ts";
import type { AdminAlerts } from "../../notify/admin-alerts.ts";
import { appendAudit } from "../../store/audit.ts";
import { readCountWindow, reserveCount } from "../../store/counts.ts";
import { type HeelDb, type HeelTx, sqliteErrorCode } from "../../store/db.ts";
import { findAccount, userName } from "../../store/directory.ts";
import { DeadlineExceededError, withDeadline } from "../../util/deadline.ts";
import { errorShape } from "../../util/error-shape.ts";
import type {
  AllowedVia,
  ApprovalStore,
  CallRequest,
  Definition,
  DefinitionRegistry,
  GoverningApproval,
  Normalized,
  PauseStore,
  PauseTarget,
  PipelineDenyReason,
  PipelineResult,
  PipelineStage,
} from "./ports.ts";
import { ResponseUnparseableError, UpstreamError } from "./ports.ts";

/**
 * The single decision pipeline every surface calls (spec: Call model,
 * "Pipeline order"). The surface has already authenticated the agent token
 * (step 1); `run` takes it from there:
 *
 * 2. account and pause: the account must exist and be usable by the agent's
 *    owner, and no pause may cover the call;
 * 3. normalize through the provider definition (its reads may deny);
 * 4. hard denies the definition applies while normalizing;
 * 5–7. in one `BEGIN IMMEDIATE` transaction: pause again, the approval that
 *    governs this call hash, rules with counts and lazily resolved state
 *    checks, the decision, the count reservation and the audit row;
 * 8. execute, with the credential the definition attaches;
 * 9. hide, before the result reaches the agent.
 *
 * Every failure before execution denies (`internal` when nothing more
 * specific applies). A failure after the request may have reached the
 * upstream is `upstream_outcome_unknown`: the items stay counted and heel
 * never retries.
 */

export interface PipelineTimeouts {
  /** Each state lookup (`all_in_thread`, `checks`): 5 s (spec: Fail-closed). */
  stateCheckMs: number;
  /**
   * Each upstream exchange: the call itself (60 s, spec: Fail-closed), and
   * the provider reads normalizing and hiding need, which talk to the same
   * upstream.
   */
  upstreamMs: number;
}

export const DEFAULT_PIPELINE_TIMEOUTS: PipelineTimeouts = {
  stateCheckMs: 5_000,
  upstreamMs: 60_000,
};

/** Where the rules in force come from; `RulesHolder` is one. */
export interface RulesSource {
  readonly set: RuleSet | null;
}

export interface PipelineDeps {
  db: HeelDb;
  rules: RulesSource;
  definitions: DefinitionRegistry;
  pauses: PauseStore;
  approvals: ApprovalStore;
  log: Logger;
  /**
   * Where a store failure that denied a call is raised (spec: Fail-closed,
   * "SQLite read or write fails"). A throw is logged; the call stays denied.
   */
  alerts: AdminAlerts;
  /** `heel serve --watch` (I-71 as amended). */
  watch: boolean;
  now?: () => Date;
  timeouts?: Partial<PipelineTimeouts>;
  /**
   * Called once a new pending request has committed (never for a repeat
   * that joins one, I-51). D4b notifies approvers from here; a throw is
   * logged and the request stays pending.
   */
  onApprovalRequested?: (approvalId: string) => void;
  /** Called as each stage starts. */
  trace?: (stage: PipelineStage) => void;
}

export interface Pipeline {
  run(request: CallRequest): Promise<PipelineResult>;
}

export function createPipeline(deps: PipelineDeps): Pipeline {
  return new DecisionPipeline(deps);
}

/** The provider recorded for a call whose account doesn't resolve. */
export const UNKNOWN_PROVIDER = "unknown";

const IDENTITY_FIELDS = [
  "orgId",
  "agentId",
  "ownerId",
  "runId",
  "surface",
  "account",
  "provider",
] as const satisfies readonly (keyof Call)[];

/**
 * Pure: how a definition's normalized call breaks its contract: identity
 * fields it changed, and `items` when that isn't a positive safe integer.
 * Empty when the call is usable.
 */
export function normalizationViolations(before: Call, after: Call): string[] {
  const violations: string[] = IDENTITY_FIELDS.filter((field) => before[field] !== after[field]);
  if (!isItemCount(after.items)) violations.push("items");
  return violations;
}

/** Pure: the pause scopes a call falls under, as the pause store matches them. */
export function pauseTarget(call: Call): PauseTarget {
  return {
    orgId: call.orgId,
    agentId: call.agentId,
    ownerId: call.ownerId,
    account: call.account,
    provider: call.provider,
  };
}

/** A definition returned a call that breaks the normalization contract. */
export class NormalizationContractError extends Error {
  readonly violations: readonly string[];

  constructor(violations: readonly string[]) {
    super(`normalized call breaks the contract: ${violations.join(", ")}`);
    this.name = "NormalizationContractError";
    this.violations = violations;
  }
}

/**
 * Thrown out of the decision transaction when the evaluator needs a state
 * check heel hasn't read yet. The transaction rolls back (it has written
 * nothing at that point), the lookup runs outside it, and the decision
 * starts again with fresh counts. Each restart adds one cached result, so
 * this ends after at most one restart per state check.
 */
class StateNeeded extends Error {
  readonly check: StateCheck;

  constructor(check: StateCheck) {
    super(`state check ${check} is not resolved yet`);
    this.name = "StateNeeded";
    this.check = check;
  }
}

/** What the run knows so far, so a failure can still be audited. */
interface Attempt {
  call: Call | null;
  /** `call`'s hash; null when its arguments have no canonical form. */
  hash: string | null;
  /** Set once the request may have left heel. */
  executing: boolean;
}

/**
 * Records the call the run now holds and returns its hash. The hash is
 * cleared first, so a failure audits the call with its own hash or with
 * none, never with the hash of the call before a rewrite.
 */
function track(attempt: Attempt, call: Call): string {
  attempt.call = call;
  attempt.hash = null;
  const hash = callHash(call);
  attempt.hash = hash;
  return hash;
}

interface DecideInput {
  call: Call;
  hash: string;
  facts: RuleFacts;
  set: RuleSet;
  /** The agent owner's user name: their rules file applies. */
  owner: string;
  /** State check results for this call only; never cached across calls. */
  states: Map<StateCheck, StateOutcome>;
}

type Decided =
  | { kind: "final"; result: PipelineResult; requestedApprovalId?: string }
  | { kind: "execute"; via: AllowedVia };

class DecisionPipeline implements Pipeline {
  readonly #deps: PipelineDeps;
  readonly #timeouts: PipelineTimeouts;
  readonly #now: () => Date;

  constructor(deps: PipelineDeps) {
    this.#deps = deps;
    this.#timeouts = { ...DEFAULT_PIPELINE_TIMEOUTS, ...deps.timeouts };
    this.#now = deps.now ?? (() => new Date());
  }

  async run(request: CallRequest): Promise<PipelineResult> {
    const attempt: Attempt = { call: null, hash: null, executing: false };
    try {
      return await this.#run(request, attempt);
    } catch (error) {
      return this.#failClosed(request, attempt, error);
    }
  }

  async #run(request: CallRequest, attempt: Attempt): Promise<PipelineResult> {
    const { db, log } = this.#deps;
    const { agent } = request;
    const runId = this.#runId(request);
    let call: Call = {
      orgId: agent.orgId,
      agentId: agent.agentId,
      ownerId: agent.ownerId,
      ...(runId !== undefined && { runId }),
      surface: request.surface,
      account: request.account,
      provider: UNKNOWN_PROVIDER,
      tool: request.tool,
      args: request.args,
      items: SINGLE_ITEM,
    };
    // The provider isn't part of the identity, so this hash holds until normalization rewrites.
    const identityHash = track(attempt, call);

    this.#trace("account");
    const account = findAccount(db, agent.orgId, request.account);
    // Until accounts can be shared (D13b), only the owner's agents may use one.
    if (account === null || account.ownerId !== agent.ownerId) {
      return this.#deny(call, identityHash, "account_unavailable");
    }
    call = { ...call, provider: account.provider };
    attempt.call = call;
    const owner = userName(db, agent.orgId, agent.ownerId);
    if (owner === null) throw new Error("the agent's owner is not a user in its org");

    this.#trace("pause");
    const scope = this.#deps.pauses.find(db, pauseTarget(call));
    if (scope !== null) {
      appendAudit(
        db,
        { kind: "paused", call, callHash: identityHash, pauseScope: scope },
        this.#now(),
      );
      return { status: "paused", scope };
    }
    if (account.status === "reconnect_required") {
      return this.#deny(call, identityHash, "reconnect_required");
    }
    const definition = this.#deps.definitions.forAccount(account);
    if (definition === null) return this.#deny(call, identityHash, "provider_unavailable");
    // One rule set decides the whole call, even if a reload lands mid-call.
    const set = this.#deps.rules.set;
    if (set === null) return this.#deny(call, identityHash, "rules_unavailable");
    const hide = hideEntriesFor(set, account.ownerName);

    this.#trace("normalize");
    const normalized = await this.#normalize(definition, call, hide);
    if (!normalized.ok) return this.#deny(call, identityHash, normalized.reason);
    const violations = normalizationViolations(call, normalized.call);
    if (violations.length > 0) throw new NormalizationContractError(violations);
    call = normalized.call;
    // The approval key covers the arguments as they will run (I-52).
    const hash = track(attempt, call);

    const decided = await this.#decideWithState(definition, {
      call,
      hash,
      facts: factsOf(call, agent.agentName),
      set,
      owner,
      states: new Map(),
    });
    if (decided.kind === "final") {
      if (decided.requestedApprovalId !== undefined) {
        this.#notify(decided.requestedApprovalId);
      }
      return decided.result;
    }

    attempt.executing = true;
    this.#trace("execute");
    let result: unknown;
    try {
      result = await withDeadline(this.#timeouts.upstreamMs, (signal) =>
        definition.execute(call, signal),
      );
    } catch (error) {
      if (error instanceof UpstreamError) {
        return { status: "upstream_error", upstreamStatus: error.status, body: error.body };
      }
      log.warn(
        { ...logContext(call), error: errorShape(error) },
        "upstream outcome unknown; the call stays counted and is not retried",
      );
      return { status: "upstream_outcome_unknown" };
    }

    if (definition.hide === undefined) return { status: "allowed", result, via: decided.via };
    this.#trace("hide");
    const filter = definition.hide.bind(definition);
    try {
      const visible = await withDeadline(this.#timeouts.upstreamMs, () =>
        filter(call, result, hide),
      );
      return { status: "allowed", result: visible, via: decided.via };
    } catch (error) {
      // The call ran, but an unfiltered result never reaches the agent.
      const reason: PipelineDenyReason =
        error instanceof ResponseUnparseableError ? "response_unparseable" : "internal";
      log.error(
        { ...logContext(call), reason, error: errorShape(error) },
        "result withheld: hiding failed after the call ran",
      );
      return { status: "denied", reason, rule: null };
    }
  }

  #runId(request: CallRequest): string | undefined {
    const parsed = parseRunId(request.runId);
    if (parsed.kind === "invalid") {
      // Ignored, never echoed: the call proceeds as one with no run id.
      this.#deps.log.warn(
        { agentId: request.agent.agentId, surface: request.surface, problem: parsed.problem },
        "run id ignored",
      );
    }
    return parsed.kind === "valid" ? parsed.runId : undefined;
  }

  async #normalize(
    definition: Definition,
    call: Call,
    hide: readonly CompiledHideEntry[],
  ): Promise<Normalized> {
    try {
      return await withDeadline(this.#timeouts.upstreamMs, (signal) =>
        definition.normalize(call, { signal, hide }),
      );
    } catch (error) {
      if (!(error instanceof DeadlineExceededError)) throw error;
      this.#deps.log.warn(logContext(call), "normalizing read timed out; the call is denied");
      return { ok: false, reason: "lookup_unavailable" };
    }
  }

  async #decideWithState(definition: Definition, input: DecideInput): Promise<Decided> {
    try {
      return this.#decide(input);
    } catch (error) {
      if (!(error instanceof StateNeeded) || input.states.has(error.check)) throw error;
      input.states.set(error.check, await this.#stateCheck(definition, error.check, input.call));
      return this.#decideWithState(definition, input);
    }
  }

  async #stateCheck(definition: Definition, check: StateCheck, call: Call): Promise<StateOutcome> {
    this.#trace("state");
    const { log } = this.#deps;
    if (definition.stateCheck === undefined) {
      log.warn({ ...logContext(call), check }, "provider has no state checks; the call is denied");
      return "unavailable";
    }
    const lookup = definition.stateCheck.bind(definition);
    try {
      const outcome: unknown = await withDeadline(this.#timeouts.stateCheckMs, (signal) =>
        lookup(check, call, signal),
      );
      if (outcome === "pass" || outcome === "fail") return outcome;
      throw new TypeError("state check returned neither pass nor fail");
    } catch (error) {
      // Never read as "fail": that would let a broader rule below match.
      log.warn(
        { ...logContext(call), check, error: errorShape(error) },
        "state check unavailable; the call is denied",
      );
      return "unavailable";
    }
  }

  /** Steps 5–7 in one `BEGIN IMMEDIATE` transaction, so parallel calls can't both fit a limit. */
  #decide(input: DecideInput): Decided {
    const { approvals, pauses } = this.#deps;
    return this.#deps.db.transaction(
      (tx) => {
        const at = this.#now();
        const { call, hash } = input;
        this.#trace("pause");
        const scope = pauses.find(tx, pauseTarget(call));
        if (scope !== null) {
          appendAudit(tx, { kind: "paused", call, callHash: hash, pauseScope: scope }, at);
          return final({ status: "paused", scope });
        }
        this.#trace("approval");
        const governing = approvals.governing(tx, call.orgId, hash, at);
        this.#trace("decide");
        const evaluation = evaluate(input.set, {
          owner: input.owner,
          facts: input.facts,
          watch: this.#deps.watch,
          state: (check) => {
            const outcome = input.states.get(check);
            if (outcome === undefined) throw new StateNeeded(check);
            return outcome;
          },
          counted: countReader(tx, call, at, () => this.#trace("counts")),
          standing: approvals.standing(tx, call, at),
        });
        for (const watched of evaluation.watched) {
          appendAudit(tx, watchedEvent(call, hash, watched), at);
        }
        return this.#settle(tx, input, evaluation, governing, at);
      },
      { behavior: "immediate" },
    );
  }

  #settle(
    tx: HeelTx,
    input: DecideInput,
    evaluation: Evaluation,
    governing: GoverningApproval | null,
    at: Date,
  ): Decided {
    const { call, hash, facts } = input;
    const { verdict } = evaluation;
    if (evaluation.relaxed && verdict.decision !== "allow") {
      // Global watch: record what the rules would have done, then let it run (I-71).
      appendAudit(
        tx,
        verdict.decision === "ask"
          ? { kind: "would_ask", call, callHash: hash, rule: verdict.rule.ref }
          : {
              kind: "would_deny",
              call,
              callHash: hash,
              rule: verdict.rule?.ref ?? null,
              reason: verdict.reason,
            },
        at,
      );
      reserve(tx, call, facts, at);
      return { kind: "execute", via: { kind: "watch", rule: verdict.rule?.ref ?? null } };
    }
    switch (verdict.decision) {
      case "allow": {
        const { standingApprovalId } = verdict;
        if (
          standingApprovalId !== null &&
          governing?.status === "approved" &&
          governing.ruleHash === verdict.rule.hash
        ) {
          // Approved as standing: the re-send of the approved call itself runs on
          // its one-time approval, so that approval is used up rather than left
          // to run the same call again if the standing one is revoked (I-54).
          return this.#runApproved(tx, input, verdict.rule, governing.id, at);
        }
        reserve(tx, call, facts, at);
        appendAudit(
          tx,
          {
            kind: "allow",
            call,
            callHash: hash,
            rule: verdict.rule.ref,
            ...(standingApprovalId !== null && { standingApprovalId }),
          },
          at,
        );
        return {
          kind: "execute",
          via: { kind: "rule", rule: verdict.rule.ref, standingApprovalId },
        };
      }
      case "deny": {
        const rule = verdict.rule?.ref ?? null;
        appendAudit(tx, { kind: "deny", call, callHash: hash, rule, reason: verdict.reason }, at);
        return final({ status: "denied", reason: verdict.reason, rule });
      }
      case "ask":
        return this.#ask(tx, input, verdict.rule, governing, at);
    }
  }

  /** Executes once (I-54): the approval is consumed in the transaction that reserves its items. */
  #runApproved(
    tx: HeelTx,
    input: DecideInput,
    rule: CompiledRule,
    approvalId: string,
    at: Date,
  ): Decided {
    const { call, hash, facts } = input;
    this.#deps.approvals.consume(tx, approvalId, at);
    reserve(tx, call, facts, at);
    appendAudit(tx, { kind: "executed", call, callHash: hash, approvalId, rule: rule.ref }, at);
    return { kind: "execute", via: { kind: "approval", rule: rule.ref, approvalId } };
  }

  /**
   * An ask, given the request that governs this call hash (spec: Approvals).
   * An approval satisfies only an ask from the rule that created it; when a
   * different ask now matches first, the call needs a new request.
   */
  #ask(
    tx: HeelTx,
    input: DecideInput,
    rule: CompiledRule,
    governing: GoverningApproval | null,
    at: Date,
  ): Decided {
    const { call, hash } = input;
    if (governing !== null) {
      const approvalId = governing.id;
      switch (governing.status) {
        case "approved":
          if (governing.ruleHash !== rule.hash) break;
          return this.#runApproved(tx, input, rule, approvalId, at);
        case "pending":
          // A repeat joins the pending request and notifies no one again (I-51).
          appendAudit(tx, { kind: "ask", call, callHash: hash, rule: rule.ref, approvalId }, at);
          return final({ status: "pending", approvalId, rule: rule.ref });
        case "denied":
          appendAudit(
            tx,
            {
              kind: "deny",
              call,
              callHash: hash,
              rule: rule.ref,
              reason: "approval_denied",
              approvalId,
            },
            at,
          );
          return final({ status: "denied", reason: "approval_denied", rule: rule.ref, approvalId });
        case "expired":
          appendAudit(tx, { kind: "expired", call, callHash: hash, approvalId }, at);
          return final({ status: "expired", approvalId });
      }
    }
    const approvalId = this.#deps.approvals.request(
      tx,
      { call, callHash: hash, rule: rule.ref, ruleHash: rule.hash, origin: rule.layer },
      at,
    );
    appendAudit(tx, { kind: "ask", call, callHash: hash, rule: rule.ref, approvalId }, at);
    return {
      kind: "final",
      result: { status: "pending", approvalId, rule: rule.ref },
      requestedApprovalId: approvalId,
    };
  }

  #deny(call: Call, hash: string, reason: PipelineDenyReason): PipelineResult {
    appendAudit(
      this.#deps.db,
      { kind: "deny", call, callHash: hash, rule: null, reason },
      this.#now(),
    );
    return { status: "denied", reason, rule: null };
  }

  #notify(approvalId: string): void {
    try {
      this.#deps.onApprovalRequested?.(approvalId);
    } catch (error) {
      // The request is committed and listed on the approval page; only the nudge failed.
      this.#deps.log.error(
        { approvalId, error: errorShape(error) },
        "approval notification failed",
      );
    }
  }

  #failClosed(request: CallRequest, attempt: Attempt, error: unknown): PipelineResult {
    const { log } = this.#deps;
    const context = {
      agentId: request.agent.agentId,
      surface: request.surface,
      account: request.account,
      error: errorShape(error),
    };
    if (attempt.executing) {
      log.error(context, "pipeline failed after the call was sent; outcome unknown");
      return { status: "upstream_outcome_unknown" };
    }
    log.error(context, "pipeline failed; the call is denied");
    const alerted = this.#alertOnStoreFailure(error);
    if (attempt.call === null) {
      log.error(context, "internal deny not audited: the run failed before it held a call");
      return { status: "denied", reason: "internal", rule: null };
    }
    const event: AuditEvent = {
      kind: "deny",
      ...(attempt.hash === null
        ? {
            call: { ...attempt.call, args: UNREPRESENTABLE_ARGS },
            callHash: UNREPRESENTABLE_CALL_HASH,
          }
        : { call: attempt.call, callHash: attempt.hash }),
      rule: null,
      reason: "internal",
    };
    try {
      appendAudit(this.#deps.db, event, this.#now());
    } catch (auditError) {
      log.error(
        { ...context, error: errorShape(auditError) },
        "internal deny not audited: the store refused the row",
      );
      if (!alerted) this.#alertOnStoreFailure(auditError);
    }
    return { status: "denied", reason: "internal", rule: null };
  }

  /** Raises `store_unavailable` when SQLite caused the failure; true if it did. */
  #alertOnStoreFailure(error: unknown): boolean {
    const code = sqliteErrorCode(error);
    if (code === null) return false;
    try {
      this.#deps.alerts.raise({ kind: "store_unavailable", code });
    } catch (alertError) {
      this.#deps.log.error({ error: errorShape(alertError) }, "admin alert failed");
    }
    return true;
  }

  #trace(stage: PipelineStage): void {
    this.#deps.trace?.(stage);
  }
}

function final(result: PipelineResult): Decided {
  return { kind: "final", result };
}

/** What a log line may say about a call: who and where, never its arguments. */
function logContext(call: Call): Record<string, string> {
  return { agentId: call.agentId, surface: call.surface, account: call.account };
}

function watchedEvent(call: Call, hash: string, watched: WatchedRule): AuditEvent {
  const rule = watched.rule.ref;
  switch (watched.wouldDecide) {
    case "allow":
      return { kind: "would_allow", call, callHash: hash, rule };
    case "ask":
      return { kind: "would_ask", call, callHash: hash, rule };
    case "deny":
      return { kind: "would_deny", call, callHash: hash, rule, reason: "rule" };
  }
}

/** Reserves the call's items in the decision transaction (I-24); never refunded. */
function reserve(tx: HeelTx, call: Call, facts: RuleFacts, at: Date): void {
  reserveCount(tx, {
    orgId: call.orgId,
    agentId: call.agentId,
    runId: call.runId ?? null,
    facts: storedFacts(facts),
    items: call.items,
    at,
  });
}

/** The evaluator's `counted`: reads each window at most once per decision. */
function countReader(tx: HeelTx, call: Call, at: Date, onRead: () => void): EvalContext["counted"] {
  const windows = new Map<"run" | "hour", CountEvent[]>();
  const read = (per: "run" | "hour"): CountEvent[] => {
    const cached = windows.get(per);
    if (cached !== undefined) return cached;
    onRead();
    let events: CountEvent[];
    if (per === "hour") {
      events = readCountWindow(tx, call.agentId, { per: "hour" }, at);
    } else {
      // The evaluator never asks for a run count without a run id (I-26).
      if (call.runId === undefined) throw new Error("a per-run count needs a run id");
      events = readCountWindow(tx, call.agentId, { per: "run", runId: call.runId }, at);
    }
    windows.set(per, events);
    return events;
  };
  return (rule, per) => sumMatching(rule, read(per));
}
