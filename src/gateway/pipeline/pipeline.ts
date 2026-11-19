import type { Logger } from "pino";
import {
  ADAPTER_NAME,
  type AdapterOutcome,
  combineAdapters,
  parseAdapterVerdict,
  parseResponseVerdict,
} from "../../core/adapters.ts";
import type { AuditEvent } from "../../core/audit.ts";
import type { Call, Surface } from "../../core/call.ts";
import { callHash, UNREPRESENTABLE_ARGS, UNREPRESENTABLE_CALL_HASH } from "../../core/call-hash.ts";
import { type CountEvent, storedFacts, sumMatching } from "../../core/counts.ts";
import {
  type HideReason,
  type Hiding,
  hidingFor,
  type LooksLikeJudge,
  UNSURE_JUDGE,
} from "../../core/hide.ts";
import { isItemCount, SINGLE_ITEM } from "../../core/items.ts";
import { strictest } from "../../core/modes.ts";
import type { CompiledRule, StateCheck } from "../../core/rules/compile.ts";
import {
  type EvalContext,
  type Evaluation,
  effectiveDecision,
  evaluate,
  hideEntriesFor,
  type RuleSet,
  type StateOutcome,
  type WatchedRule,
} from "../../core/rules/evaluate.ts";
import { factsOf, type RuleFacts } from "../../core/rules/facts.ts";
import { parseRunId } from "../../core/run-id.ts";
import { compileGrant } from "../../grants/compile.ts";
import type { AdminAlerts } from "../../notify/admin-alerts.ts";
import { appendAudit } from "../../store/audit.ts";
import { readCountWindow, reserveCount } from "../../store/counts.ts";
import { type HeelDb, type HeelTx, sqliteErrorCode } from "../../store/db.ts";
import { findAccount, userName } from "../../store/directory.ts";
import { type GrantRow, liveGrants } from "../../store/grants.ts";
import { modeFor } from "../../store/modes.ts";
import { accountApproverIds, mayUseAccount } from "../../store/sharing.ts";
import { DeadlineExceededError, withDeadline } from "../../util/deadline.ts";
import { errorShape } from "../../util/error-shape.ts";
import type {
  AdapterInput,
  AllowedVia,
  ApprovalStore,
  CallRequest,
  DecisionAdapter,
  Definition,
  DefinitionRegistry,
  GoverningApproval,
  Normalized,
  PauseStore,
  PauseTarget,
  PipelineDenyReason,
  PipelineResult,
  PipelineStage,
  ResponseAdapter,
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
 * Decision adapters (core/adapters.ts) join step 7 when any are configured:
 * once the rules would let a call run or ask about it, every adapter is
 * consulted outside the transaction, and any deny stops the call. Response
 * adapters run after step 9 and can withhold the result.
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
  /** Each decision or response adapter's answer: 5 s, the same as a state lookup. */
  adapterMs: number;
}

export const DEFAULT_PIPELINE_TIMEOUTS: PipelineTimeouts = {
  stateCheckMs: 5_000,
  upstreamMs: 60_000,
  adapterMs: 5_000,
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
  /**
   * `heel serve --watch`: the mode is `shadow` wherever no mode is stored
   * (A3). A stored mode, set on the human plane, takes precedence.
   */
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
  /** Checks beside the rules, in chain order. They can only tighten. */
  adapters?: readonly DecisionAdapter[];
  /** Checks on an allowed call's result after hiding, in chain order. */
  responseAdapters?: readonly ResponseAdapter[];
  /**
   * Judges `looks_like` hide entries. Without one, every message such an
   * entry covers is hidden (I-44).
   */
  looksLike?: LooksLikeJudge;
  /** Called for each hidden message, with why: the fail-closed metric (I-44). */
  onHidden?: (reason: HideReason) => void;
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

/** What the adapters are asked about a call, beyond the call itself. */
type AdapterQuestion = Omit<AdapterInput, "call" | "callHash">;

/**
 * Thrown out of the decision transaction when the rules would let a call run
 * or ask about it and the adapters haven't answered for that outcome yet.
 * Like `StateNeeded`, the transaction rolls back, the adapters run outside
 * it, and the decision starts again.
 */
class AdaptersNeeded extends Error {
  readonly key: string;
  readonly input: AdapterQuestion;

  constructor(key: string, input: AdapterQuestion) {
    super("decision adapters have not answered for this outcome yet");
    this.name = "AdaptersNeeded";
    this.key = key;
    this.input = input;
  }
}

/** Throws unless every adapter has a valid name that no other adapter in its chain uses. */
export function checkAdapterNames(chain: string, names: readonly string[]): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (!ADAPTER_NAME.test(name)) throw new Error(`${chain} adapter name is invalid: ${name}`);
    if (seen.has(name)) throw new Error(`${chain} adapter name is used twice: ${name}`);
    seen.add(name);
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
  /**
   * The adapters' answers for this call, keyed by the outcome they were asked
   * about. A restart that lands on a different rule or outcome asks again.
   */
  adapters: Map<string, AdapterOutcome[]>;
  /** The agent's reason, stored on a new request only (CallRequest.reason). */
  reason: string | null;
  /** The agent's MCP client, stored on a new request only. */
  client: string | null;
}

type Decided =
  | { kind: "final"; result: PipelineResult; requestedApprovalId?: string }
  | { kind: "execute"; via: AllowedVia };

class DecisionPipeline implements Pipeline {
  /** Intent grants compiled once each, by id; a grant's match never changes after signing. */
  readonly #grantRules = new Map<string, CompiledRule | null>();

  #grantRule(row: GrantRow): CompiledRule | null {
    let rule = this.#grantRules.get(row.id);
    if (rule === undefined) {
      try {
        rule = compileGrant(row.match, { id: row.id }).rule;
      } catch (error) {
        // Validated when signed; one that no longer compiles allows nothing.
        this.#deps.log.error({ grant: row.id, error: errorShape(error) }, "grant didn't compile");
        rule = null;
      }
      this.#grantRules.set(row.id, rule);
    }
    return rule;
  }

  readonly #deps: PipelineDeps;
  readonly #timeouts: PipelineTimeouts;
  readonly #now: () => Date;

  constructor(deps: PipelineDeps) {
    this.#deps = deps;
    this.#timeouts = { ...DEFAULT_PIPELINE_TIMEOUTS, ...deps.timeouts };
    this.#now = deps.now ?? (() => new Date());
    checkAdapterNames(
      "decision",
      (deps.adapters ?? []).map((adapter) => adapter.name),
    );
    checkAdapterNames(
      "response",
      (deps.responseAdapters ?? []).map((adapter) => adapter.name),
    );
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
    // An agent may use an account only if its owner may (spec: Teams, "Who may use an account").
    if (account === null || !mayUseAccount(db, account, agent.ownerId)) {
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
    const hide = hidingFor(
      hideEntriesFor(set, account.ownerName),
      this.#deps.looksLike ?? UNSURE_JUDGE,
      this.#deps.onHidden,
    );

    this.#trace("normalize");
    const normalized = await this.#normalize(definition, call, hide);
    if (!normalized.ok) {
      return this.#deny(call, identityHash, normalized.reason, normalized.detail);
    }
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
      adapters: new Map(),
      reason: request.reason ?? null,
      client: clientFor(request.surface, agent.clientName ?? null),
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
      result = await withDeadline(
        definition.executeTimeoutMs ?? this.#timeouts.upstreamMs,
        (signal) => definition.execute(call, signal),
        request.signal,
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

    if (definition.hide === undefined) return this.#respond(call, result, decided.via);
    this.#trace("hide");
    const filter = definition.hide.bind(definition);
    let visible: unknown;
    try {
      visible = await withDeadline(this.#timeouts.upstreamMs, () => filter(call, result, hide));
    } catch (error) {
      // The call ran, but an unfiltered result never reaches the agent.
      const reason: PipelineDenyReason =
        error instanceof ResponseUnparseableError ? "response_unparseable" : "internal";
      log.error(
        { ...logContext(call), reason, error: errorShape(error) },
        "result withheld: hiding failed after the call ran",
      );
      return { status: "denied", reason, rule: null, executed: true };
    }
    return this.#respond(call, visible, decided.via);
  }

  /**
   * Response adapters, in chain order, on what would reach the agent (after
   * hiding). The first one that doesn't pass withholds the result; the call
   * already ran and stays counted.
   */
  async #respond(call: Call, result: unknown, via: AllowedVia): Promise<PipelineResult> {
    const chain = this.#deps.responseAdapters ?? [];
    if (chain.length === 0) return { status: "allowed", result, via };
    this.#trace("respond");
    for (const adapter of chain) {
      let reason: string;
      try {
        const answer: unknown = await withDeadline(this.#timeouts.adapterMs, (signal) =>
          adapter.check(call, result, signal),
        );
        const verdict = parseResponseVerdict(answer);
        if (verdict.decision === "pass") continue;
        reason = verdict.reason;
      } catch (error) {
        reason = `unavailable: ${errorShape(error).name}`;
      }
      this.#deps.log.warn(
        { ...logContext(call), adapter: adapter.name },
        "result withheld by a response adapter after the call ran",
      );
      // The adapter's reason may quote the result, so it stays out of the default log level.
      this.#deps.log.debug(
        { ...logContext(call), adapter: adapter.name, detail: reason },
        "withheld",
      );
      return {
        status: "denied",
        reason: "response_withheld",
        rule: null,
        adapter: adapter.name,
        executed: true,
      };
    }
    return { status: "allowed", result, via };
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

  async #normalize(definition: Definition, call: Call, hide: Hiding): Promise<Normalized> {
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
      if (error instanceof StateNeeded && !input.states.has(error.check)) {
        input.states.set(error.check, await this.#stateCheck(definition, error.check, input.call));
        return this.#decideWithState(definition, input);
      }
      if (error instanceof AdaptersNeeded && !input.adapters.has(error.key)) {
        input.adapters.set(error.key, await this.#consultAdapters(input, error.input));
        return this.#decideWithState(definition, input);
      }
      throw error;
    }
  }

  /**
   * Asks every decision adapter at once, each under its own deadline. A
   * throw, a timeout or an answer that isn't `pass` or `deny` is
   * unavailable, which denies the call: never read as a pass.
   */
  async #consultAdapters(input: DecideInput, asked: AdapterQuestion): Promise<AdapterOutcome[]> {
    this.#trace("adapters");
    const { call, hash } = input;
    const request: AdapterInput = { call, callHash: hash, ...asked };
    return Promise.all(
      (this.#deps.adapters ?? []).map(async (adapter): Promise<AdapterOutcome> => {
        const watch = adapter.watch === true;
        try {
          const answer: unknown = await withDeadline(this.#timeouts.adapterMs, (signal) =>
            adapter.check(request, signal),
          );
          const verdict = parseAdapterVerdict(answer);
          if (verdict.decision === "unavailable") {
            this.#deps.log.warn(
              { ...logContext(call), adapter: adapter.name },
              "decision adapter answered with neither pass nor deny; the call is denied",
            );
          }
          return { adapter: adapter.name, watch, verdict };
        } catch (error) {
          this.#deps.log.warn(
            { ...logContext(call), adapter: adapter.name, error: errorShape(error) },
            "decision adapter unavailable; the call is denied",
          );
          return { adapter: adapter.name, watch, verdict: { decision: "unavailable" } };
        }
      }),
    );
  }

  /**
   * The adapters' verdict on a call the rules would let run or ask about,
   * inside the decision transaction. Throws `AdaptersNeeded` the first time
   * an outcome is seen; returns a final deny when an adapter denies, or null
   * when the call goes on to settle as the rules decided.
   */
  #adapterVerdict(
    tx: HeelTx,
    input: DecideInput,
    evaluation: Evaluation,
    at: Date,
  ): Decided | null {
    if ((this.#deps.adapters ?? []).length === 0) return null;
    const decision = effectiveDecision(evaluation);
    // A call the rules deny is settled without them: its data never leaves heel.
    if (decision === "deny") return null;
    const rule = evaluation.verdict.rule?.ref ?? null;
    const key = `${decision}:${evaluation.verdict.rule?.hash ?? "none"}`;
    const outcomes = input.adapters.get(key);
    if (outcomes === undefined) throw new AdaptersNeeded(key, { tentative: decision, rule });
    const { call, hash } = input;
    const { deny, wouldDeny } = combineAdapters(outcomes);
    for (const would of wouldDeny) {
      appendAudit(
        tx,
        {
          kind: "would_deny",
          call,
          callHash: hash,
          rule: null,
          reason: would.reason,
          adapter: would.adapter,
        },
        at,
      );
    }
    if (deny === null) return null;
    if (deny.detail !== null) {
      // An adapter's explanation may quote the call, so it stays out of the default log level.
      this.#deps.log.debug(
        { ...logContext(call), adapter: deny.adapter, detail: deny.detail },
        "decision adapter denied the call",
      );
    }
    appendAudit(
      tx,
      {
        kind: "deny",
        call,
        callHash: hash,
        rule: null,
        reason: deny.reason,
        adapter: deny.adapter,
      },
      at,
    );
    return final({ status: "denied", reason: deny.reason, rule: null, adapter: deny.adapter });
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
        if (governing?.status === "expired") {
          // The store settled this request as expired just now. Record that
          // whatever the rules decide below, so the transition is audited (I-55, I-73).
          appendAudit(tx, { kind: "expired", call, callHash: hash, approvalId: governing.id }, at);
        }
        this.#trace("decide");
        // Read once per call, beside the pause check, so a switch applies
        // from the next call on (A3).
        const fallback = this.#deps.watch ? "shadow" : "enforce";
        // On a shared account (D13b), the account owner's rollout mode counts too, strictest wins:
        // a sharee in shadow or record mode can't make the owner's account run unchecked.
        const accountOwner = findAccount(tx, call.orgId, call.account)?.ownerId ?? call.ownerId;
        const mode = strictest(
          [
            modeFor(tx, call.orgId, call.ownerId, fallback),
            ...(accountOwner === call.ownerId
              ? []
              : [modeFor(tx, call.orgId, accountOwner, fallback)]),
          ],
          fallback,
        );
        // Live intent grants for this agent (A4b), compiled once each. A grant stands in for an
        // approval, so on someone else's account it counts only when its signer approves that account.
        const approvers =
          accountOwner === call.ownerId
            ? null
            : accountApproverIds(tx, call.orgId, call.account, call.repo);
        const grants = liveGrants(tx, call.orgId, call.agentId, at).flatMap((row) => {
          if (approvers !== null && !approvers.includes(row.createdBy)) return [];
          const compiled = this.#grantRule(row);
          return compiled === null ? [] : [compiled];
        });
        const evaluation = evaluate(input.set, {
          owner: input.owner,
          facts: input.facts,
          mode,
          grants,
          state: (check) => {
            const outcome = input.states.get(check);
            if (outcome === undefined) throw new StateNeeded(check);
            return outcome;
          },
          counted: countReader(tx, call, at, () => this.#trace("counts")),
          standing: approvals.standing(tx, call, hash, at),
        });
        for (const watched of evaluation.watched) {
          appendAudit(tx, watchedEvent(call, hash, watched), at);
        }
        return (
          this.#adapterVerdict(tx, input, evaluation, at) ??
          this.#settle(tx, input, evaluation, governing, at)
        );
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
      // Shadow or record mode (global watch): record what the rules would
      // have done, then let it run (I-71).
      appendAudit(
        tx,
        verdict.decision === "ask"
          ? {
              kind: "would_ask",
              call,
              callHash: hash,
              rule: verdict.rule.ref,
              mode: evaluation.mode,
            }
          : {
              kind: "would_deny",
              call,
              callHash: hash,
              rule: verdict.rule?.ref ?? null,
              reason: verdict.reason,
              mode: evaluation.mode,
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
          (standingApprovalId !== null || verdict.grant === true) &&
          governing?.status === "denied"
        ) {
          // A person denied this exact call. A standing approval or an intent
          // grant doesn't overrule them while the denial lasts (Q-A5).
          return this.#deniedByPerson(tx, input, verdict.rule, governing.id, at);
        }
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

  /** A person denied this exact call, and its deny window hasn't ended (Q-A5). */
  #deniedByPerson(
    tx: HeelTx,
    input: DecideInput,
    rule: CompiledRule,
    approvalId: string,
    at: Date,
  ): Decided {
    const { call, hash } = input;
    appendAudit(
      tx,
      { kind: "deny", call, callHash: hash, rule: rule.ref, reason: "approval_denied", approvalId },
      at,
    );
    return final({ status: "denied", reason: "approval_denied", rule: rule.ref, approvalId });
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
          return this.#deniedByPerson(tx, input, rule, approvalId, at);
        case "expired":
          // Its audit row was written when the store settled it (see #decide).
          return final({ status: "expired", approvalId });
      }
    }
    const approvalId = this.#deps.approvals.request(
      tx,
      {
        call,
        callHash: hash,
        rule: rule.ref,
        ruleHash: rule.hash,
        origin: rule.layer,
        reason: input.reason,
        client: input.client,
      },
      at,
    );
    appendAudit(tx, { kind: "ask", call, callHash: hash, rule: rule.ref, approvalId }, at);
    return {
      kind: "final",
      result: { status: "pending", approvalId, rule: rule.ref },
      requestedApprovalId: approvalId,
    };
  }

  #deny(call: Call, hash: string, reason: PipelineDenyReason, detail?: string): PipelineResult {
    appendAudit(
      this.#deps.db,
      { kind: "deny", call, callHash: hash, rule: null, reason },
      this.#now(),
    );
    return { status: "denied", reason, rule: null, ...(detail === undefined ? {} : { detail }) };
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

/**
 * Pure: the MCP client to record on a call's approval. The client an agent
 * names in `initialize` is stored on its token, so it is only true of MCP
 * and code-mode calls; an HTTP proxy request or a `heel run` command with the
 * same token records none, and the approval page names its surface instead.
 */
export function clientFor(surface: Surface, mcpClient: string | null): string | null {
  return surface === "mcp" || surface === "code" ? mcpClient : null;
}
