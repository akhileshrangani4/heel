import { and, asc, eq } from "drizzle-orm";
import { compileRulesText } from "../../src/config/rules.ts";
import type { Call } from "../../src/core/call.ts";
import { itemsFromIds, SINGLE_ITEM } from "../../src/core/items.ts";
import type { Layer, StateCheck } from "../../src/core/rules/compile.ts";
import {
  NO_STANDING_APPROVALS,
  type RuleSet,
  type StandingApprovals,
} from "../../src/core/rules/evaluate.ts";
import type { AuthenticatedAgent } from "../../src/gateway/agent-tokens.ts";
import {
  createPipeline,
  type Pipeline,
  type PipelineTimeouts,
} from "../../src/gateway/pipeline/pipeline.ts";
import {
  type ApprovalRequest,
  type ApprovalStore,
  type CallRequest,
  type Definition,
  type GoverningApproval,
  type GoverningStatus,
  type NormalizeContext,
  type Normalized,
  type PauseStore,
  type PauseTarget,
  type PipelineResult,
  type PipelineStage,
  UpstreamError,
} from "../../src/gateway/pipeline/ports.ts";
import { newId } from "../../src/store/ids.ts";
import { LOCAL_OWNER_NAME } from "../../src/store/install.ts";
import { accounts, agents, auditLog, countEvents } from "../../src/store/schema.ts";
import { captureLogger } from "./log.ts";
import { addAccount, type TestStore, testStore } from "./store.ts";

/**
 * A decision pipeline over a real SQLite store, with in-memory fakes for the
 * seams other deliverables fill in: the provider definition (D9/D11/D12),
 * and the pause and approval stores (D4b).
 */

/** The owner's rules file, as heel names it in rule refs. */
export const OWNER_FILE = `rules/${LOCAL_OWNER_NAME}.yaml`;

/** A rules file holding one rule. `match` is YAML flow text, e.g. `{ action: email.send }`. */
export function oneRule(match: string, then: "allow" | "deny" | "ask" = "allow"): string {
  return `rules:\n  - match: ${match}\n    then: ${then}\n`;
}

export function compileRules(files: { org?: string; owner?: string }): RuleSet {
  const compile = (yaml: string, display: string, layer: Layer) =>
    compileRulesText(yaml, `/heel/${display}`, display, layer).file;
  return {
    org: files.org === undefined ? null : compile(files.org, "org-rules.yaml", "org"),
    owners: new Map(
      files.owner === undefined
        ? []
        : [[LOCAL_OWNER_NAME, compile(files.owner, OWNER_FILE, "owner")] as const],
    ),
  };
}

// ── the fake provider ───────────────────────────────────────────────────────

/**
 * What the fake upstream does when a call runs:
 * - `ok`: answers with `{ ran: tool }`;
 * - `error`: answers with an error response;
 * - `drop`: the connection drops after the request went out;
 * - `hang`: never answers, ignoring the abort signal, so only heel's own
 *   deadline can end the wait.
 */
export type UpstreamBehavior =
  | { kind: "ok" }
  | { kind: "error"; status: number; body: unknown }
  | { kind: "drop" }
  | { kind: "hang" };

/** What the fake's state lookup does for a check. */
export type LookupBehavior = "pass" | "fail" | "throw" | "hang" | "garbage";

export type NormalizeHook = (base: Call, ctx: NormalizeContext) => Promise<Normalized>;
export type HideHook = NonNullable<Definition["hide"]>;

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? value : undefined;
}

/**
 * The fake definition's normalization: it reads what a real definition
 * would derive straight from the arguments. `action`, `recipients`, `repo`
 * and `persistence` become the call's fields; `ids` is a batch whose length
 * is its items (Gmail `batchDelete`), and an `ids` that isn't a list can't
 * be expanded.
 */
export function fakeNormalize(base: Call): Normalized {
  const args: Record<string, unknown> =
    typeof base.args === "object" && base.args !== null && !Array.isArray(base.args)
      ? { ...base.args }
      : {};
  let items = SINGLE_ITEM;
  if (Object.hasOwn(args, "ids")) {
    const expanded = itemsFromIds(args["ids"]);
    if (!expanded.ok) return { ok: false, reason: "batch_unexpandable" };
    items = expanded.items;
  }
  const action = args["action"];
  const recipients = stringList(args["recipients"]);
  const repo = args["repo"];
  const persistence = args["persistence"];
  return {
    ok: true,
    call: {
      ...base,
      ...(typeof action === "string" && { action, kind: "write" as const }),
      ...(recipients !== undefined && { recipients }),
      ...(typeof repo === "string" && { repo }),
      ...(typeof persistence === "boolean" && { persistence }),
      items,
    },
  };
}

export class FakeProvider {
  /** Each call the pipeline asked the definition to normalize, as it arrived. */
  readonly normalized: Call[] = [];
  /** Each call that reached the upstream. */
  readonly executed: Call[] = [];
  /** Each state lookup, in order. */
  readonly lookups: StateCheck[] = [];
  upstream: UpstreamBehavior = { kind: "ok" };
  readonly states = new Map<StateCheck, LookupBehavior>();
  /** Replaces `fakeNormalize`, e.g. to rewrite arguments or fail a read. */
  normalizeHook: NormalizeHook | null = null;
  /** Runs as the call goes upstream, before the upstream answers. */
  onExecute: ((call: Call) => void) | null = null;
  hide: HideHook | null = null;
  /** False for a provider with no state checks (the definition omits `stateCheck`). */
  hasStateChecks = true;

  /** The definition as the pipeline sees it, built from the current settings. */
  definition(): Definition {
    const definition: Definition = {
      normalize: (base, ctx) => {
        this.normalized.push(base);
        return this.normalizeHook?.(base, ctx) ?? Promise.resolve(fakeNormalize(base));
      },
      execute: (call) => this.#execute(call),
    };
    if (this.hasStateChecks) definition.stateCheck = (check) => this.#lookup(check);
    if (this.hide !== null) definition.hide = this.hide;
    return definition;
  }

  async #execute(call: Call): Promise<unknown> {
    this.executed.push(call);
    this.onExecute?.(call);
    const behavior = this.upstream;
    switch (behavior.kind) {
      case "ok":
        return { ran: call.tool };
      case "error":
        throw new UpstreamError(behavior.status, behavior.body);
      case "drop":
        throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      case "hang":
        return never();
    }
  }

  async #lookup(check: StateCheck): Promise<"pass" | "fail"> {
    this.lookups.push(check);
    const behavior = this.states.get(check) ?? "pass";
    switch (behavior) {
      case "pass":
      case "fail":
        return behavior;
      case "throw":
        throw new Error("GitHub answered 502");
      case "hang":
        return never();
      case "garbage":
        // A definition bug the type system can't see once the value crossed a JSON boundary.
        return JSON.parse('"maybe"') as "pass";
    }
  }
}

// ── the D4b stores, in memory ───────────────────────────────────────────────

export interface FakePauseScopes {
  global: boolean;
  agents: Set<string>;
  accounts: Set<string>;
  providers: Set<string>;
}

/** Pause state in memory. A real store answers inside the decision transaction. */
export class FakePauseStore implements PauseStore {
  readonly paused: FakePauseScopes = {
    global: false,
    agents: new Set(),
    accounts: new Set(),
    providers: new Set(),
  };

  find(_db: unknown, target: PauseTarget) {
    if (this.paused.global) return "global" as const;
    if (this.paused.agents.has(target.agentId)) return "agent" as const;
    if (this.paused.accounts.has(target.account)) return "account" as const;
    if (this.paused.providers.has(target.provider)) return "provider" as const;
    return null;
  }
}

export interface FakeApproval {
  id: string;
  orgId: string;
  status: GoverningStatus | "executed";
  callHash: string;
  ruleHash: string;
  request: ApprovalRequest;
}

/**
 * Approval requests in memory. TTLs are the test's business: it moves a
 * request to `expired` or `denied` itself. Unlike D4b's store, writes here
 * don't roll back with the decision transaction.
 */
export class FakeApprovalStore implements ApprovalStore {
  readonly rows: FakeApproval[] = [];
  standingApprovals: StandingApprovals = NO_STANDING_APPROVALS;
  #next = 1;

  governing(_db: unknown, orgId: string, callHash: string): GoverningApproval | null {
    const row = this.rows.findLast(
      (r) => r.orgId === orgId && r.callHash === callHash && r.status !== "executed",
    );
    if (row === undefined || row.status === "executed") return null;
    return { id: row.id, status: row.status, ruleHash: row.ruleHash };
  }

  request(_db: unknown, input: ApprovalRequest): string {
    const id = `apr_test${this.#next++}`;
    this.rows.push({
      id,
      orgId: input.call.orgId,
      status: "pending",
      callHash: input.callHash,
      ruleHash: input.ruleHash,
      request: input,
    });
    return id;
  }

  consume(_db: unknown, approvalId: string): void {
    const row = this.get(approvalId);
    if (row.status !== "approved") throw new Error(`approval ${approvalId} is ${row.status}`);
    row.status = "executed";
  }

  standing(): StandingApprovals {
    return this.standingApprovals;
  }

  get(approvalId: string): FakeApproval {
    const row = this.rows.find((r) => r.id === approvalId);
    if (row === undefined) throw new Error(`no approval ${approvalId}`);
    return row;
  }

  /** A person's decision, or the TTL running out. */
  set(approvalId: string, status: GoverningStatus): void {
    this.get(approvalId).status = status;
  }
}

// ── the harness ─────────────────────────────────────────────────────────────

export interface HarnessOptions {
  owner?: string;
  org?: string;
  /** `heel serve --watch`. */
  watch?: boolean;
  timeouts?: Partial<PipelineTimeouts>;
  /** Start with no valid rule set, as after an invalid rules file at boot. */
  noRules?: boolean;
}

export interface CallInput {
  agent?: AuthenticatedAgent;
  account?: string;
  tool?: string;
  args?: unknown;
  runId?: unknown;
  surface?: CallRequest["surface"];
}

/** The fake clock the pipeline reads; tests move it explicitly. */
export interface TestClock {
  now: Date;
  advance(ms: number): void;
}

export type AuditRow = typeof auditLog.$inferSelect;
export type CountRow = typeof countEvents.$inferSelect;

export interface PipelineHarness {
  t: TestStore;
  agent: AuthenticatedAgent;
  provider: FakeProvider;
  pauses: FakePauseStore;
  approvals: FakeApprovalStore;
  rules: { set: RuleSet | null };
  clock: TestClock;
  /** Stages in the order the pipeline entered them, across every call. */
  stages: PipelineStage[];
  /** Approval ids the pipeline asked to notify about. */
  notified: string[];
  /** Every log line written so far, as JSON lines. */
  logs(): string;
  pipeline: Pipeline;
  /** One call through the pipeline; defaults to `send` on `gmail-work` over MCP. */
  call(input?: CallInput): Promise<PipelineResult>;
  addAgent(name: string): AuthenticatedAgent;
  setRules(files: { org?: string; owner?: string }): void;
  audit(): AuditRow[];
  counts(): CountRow[];
  /** Providers with no definition in this harness. */
  undefinedProviders: Set<string>;
}

/** Accounts every harness starts with, all owned by the local owner. */
export const HARNESS_ACCOUNTS = {
  "gmail-work": "gmail",
  "gmail-personal": "gmail",
  github: "github",
  notion: "notion",
} as const;

export function pipelineHarness(options: HarnessOptions = {}): PipelineHarness {
  const t = testStore();
  for (const [alias, provider] of Object.entries(HARNESS_ACCOUNTS)) {
    addAccount(t, alias, provider);
  }
  const addAgent = (name: string): AuthenticatedAgent => {
    const agentId = newId("agent");
    t.db
      .insert(agents)
      .values({ id: agentId, orgId: t.orgId, ownerId: t.ownerId, name, createdAt: new Date() })
      .run();
    return { orgId: t.orgId, agentId, agentName: name, ownerId: t.ownerId, tokenId: "tok_test" };
  };
  const agent = addAgent("inbox-bot");

  const provider = new FakeProvider();
  const pauses = new FakePauseStore();
  const approvals = new FakeApprovalStore();
  const rules: { set: RuleSet | null } = {
    set: options.noRules === true ? null : compileRules(options),
  };
  const start = new Date("2026-11-13T09:00:00.000Z");
  const clock: TestClock = {
    now: start,
    advance(ms) {
      clock.now = new Date(clock.now.getTime() + ms);
    },
  };
  const stages: PipelineStage[] = [];
  const notified: string[] = [];
  const undefinedProviders = new Set<string>(["notion"]);
  const { logger, output } = captureLogger();

  const pipeline = createPipeline({
    db: t.db,
    rules,
    definitions: {
      forAccount: (account) =>
        undefinedProviders.has(account.provider) ? null : provider.definition(),
    },
    pauses,
    approvals,
    log: logger,
    watch: options.watch ?? false,
    now: () => clock.now,
    ...(options.timeouts !== undefined && { timeouts: options.timeouts }),
    onApprovalRequested: (id) => notified.push(id),
    trace: (stage) => stages.push(stage),
  });

  return {
    t,
    agent,
    provider,
    pauses,
    approvals,
    rules,
    clock,
    stages,
    notified,
    logs: output,
    pipeline,
    undefinedProviders,
    addAgent,
    call: (input = {}) =>
      pipeline.run({
        agent: input.agent ?? agent,
        surface: input.surface ?? "mcp",
        account: input.account ?? "gmail-work",
        tool: input.tool ?? "send",
        // Only an omitted `args` defaults; an explicit null reaches the pipeline as sent.
        args: "args" in input ? input.args : {},
        ...(input.runId !== undefined && { runId: input.runId }),
      }),
    setRules: (files) => {
      rules.set = compileRules(files);
    },
    audit: () => t.db.select().from(auditLog).orderBy(asc(auditLog.id)).all(),
    counts: () => t.db.select().from(countEvents).orderBy(asc(countEvents.id)).all(),
  };
}

/** Marks an account as needing its OAuth grant reconnected. */
export function markReconnectRequired(h: PipelineHarness, alias: string): void {
  h.t.db
    .update(accounts)
    .set({ status: "reconnect_required" })
    .where(and(eq(accounts.orgId, h.t.orgId), eq(accounts.alias, alias)))
    .run();
}
