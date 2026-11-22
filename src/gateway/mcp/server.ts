import {
  type CallToolResult,
  createMcpHandler,
  type McpHttpHandler,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type Tool,
} from "@modelcontextprotocol/server";

import { eq } from "drizzle-orm";
import { BackgroundRunner } from "../../codemode/background.ts";
import {
  type ClaimedScript,
  findParked,
  modulesHash,
  openParked,
  purgeExpiredParked,
  releaseParked,
  type Sealer,
} from "../../codemode/parking.ts";
import { type CallRecord, runScript, type ScriptStatus } from "../../codemode/run.ts";
import { accountModule } from "../../codemode/stubs.ts";
import { type CodeWorker, DEFAULT_LIMITS } from "../../codemode/worker.ts";
import type { Logger } from "../../log.ts";
import { ProposeRulesInput, pendingProposals, proposeRules } from "../../proposals/rules.ts";
import {
  pendingRequests,
  RequestConnectionInput,
  requestConnection,
} from "../../requests/connection.ts";
import { approvalStatusForAgent } from "../../store/approvals.ts";
import type { HeelDb } from "../../store/db.ts";
import { type AccountRecord, findAccount } from "../../store/directory.ts";
import { SqlitePauseStore } from "../../store/pauses.ts";
import { agentTokens } from "../../store/schema.ts";
import { accountsUsableBy } from "../../store/sharing.ts";
import { errorShape } from "../../util/error-shape.ts";
import { isBuiltInProvider, isMcpProvider } from "../../vault/connect.ts";
import type { AuthenticatedAgent } from "../agent-tokens.ts";
import { agentStillLive } from "../agent-tokens.ts";
import { TOKEN_WARNING_DAYS } from "../agents.ts";
import type { Pipeline } from "../pipeline/pipeline.ts";
import type { Definition, DefinitionRegistry, PauseStore } from "../pipeline/ports.ts";
import { type SandboxSlots, UNLIMITED_SLOT } from "../sandbox-slots.ts";
import { clientNameFrom } from "./client-info.ts";
import {
  directName,
  HEEL_ACCOUNTS,
  HEEL_ACCOUNTS_TOOL,
  HEEL_PROPOSE_RULES,
  HEEL_PROPOSE_RULES_TOOL,
  HEEL_REQUEST_CONNECTION,
  HEEL_REQUEST_CONNECTION_TOOL,
  HEEL_STATUS,
  HEEL_STATUS_TOOL,
  HEEL_STUBS,
  HEEL_STUBS_TOOL,
  listedTool,
  RUN_CODE,
  RUN_CODE_TOOL,
  splitDirectName,
  takeReason,
} from "./names.ts";
import { toolResult } from "./results.ts";
import { SETUP_PROMPT_NAME, setupPrompt } from "./setup-prompt.ts";

/**
 * heel's MCP endpoints on the agent plane (spec: MCP and code mode).
 *
 * The agent was authenticated before the request got here (requireAgent).
 * For each request the SDK builds a fresh low-level `Server` for that agent
 * and scope, which answers two things:
 *
 * - `tools/list`: the tools of the accounts the agent's owner owns, as each
 *   account's definition lists them (a passthrough asks its server now),
 *   plus `heel_status`;
 * - `tools/call`: every call goes through the decision pipeline as one
 *   `Call` with `surface: "mcp"`; `heel_status` only reads an approval.
 */

/** Which tools a request sees: one account's, or every account's prefixed. */
export type McpScope =
  | { kind: "account"; alias: string }
  | { kind: "direct" }
  /** Bare `/mcp`: code mode's `run_code` and `heel_stubs` (D6b). */
  | { kind: "code" };

export interface McpSurfaceDeps {
  db: HeelDb;
  pipeline: Pipeline;
  definitions: DefinitionRegistry;
  log: Logger;
  version: string;
  now?: () => Date;
  /** A fresh sandboxed worker per script; absent where the sandbox can't run. */
  /** Makes the worker for one script of this agent (the helper path keeps each agent on its own lane). */
  codeWorker?: (agentId: string) => CodeWorker;
  /** How many scripts may run at once, shared with `heel run`; unlimited when absent. */
  slots?: SandboxSlots;
  /** Pauses that stop an agent's proposals too; heel's own store when absent. */
  pauses?: PauseStore;
  /**
   * Saves a script whose call asks for approval, so the agent can resume it
   * (code mode round 2, C2); the vault, which seals it. Without it an ask ends
   * the script, as before.
   */
  parking?: { sealer: Sealer };
  /** Called after an agent proposes rules, to tell its owner. */
  onRuleProposal?: (proposalId: string) => void;
  /** Called after an agent asks for a connection, to tell its owner. */
  onAgentRequest?: (requestId: string) => void;
  /** heel's approval page, named in the setup prompt; the prompt says "heel's approval page" without it. */
  approvalsUrl?: string;
}

/**
 * What a parked script's answer tells the agent to do. In a dry run an agent
 * holding only a bare `resume` id rewrote the waiting call instead, which
 * drops the rest of the script.
 */
export function resumeMessage(resume: string): string {
  return (
    "The script is parked at the call waiting for approval; nothing after it has run. " +
    `Once heel_status says it's decided, call run_code with {"resume": "${resume}"} and no code: ` +
    "the script carries on from that call, with everything it already read. Don't resend the call or the script yourself."
  );
}

/**
 * A finished script's last expression, beside what it printed, like a REPL
 * (code mode round 2, C1): an agent that ends with `rows[:3]` sees the rows.
 * None (a script ending in an assignment) adds nothing. A value larger than
 * the stdout cap is left out with a note, so it can't flood the agent's context.
 */
export function lastExpression(output: unknown): { output?: unknown; output_omitted?: string } {
  if (output === undefined || output === null) return {};
  const text = JSON.stringify(output);
  if (text === undefined) return {};
  if (text.length > DEFAULT_LIMITS.maxStdout) {
    return {
      output_omitted: `the last expression's value is ${text.length} characters, more than heel returns; print the part you need`,
    };
  }
  return { output };
}

/** heel's own tools, listed on every MCP scope. */
const HEEL_TOOLS = [
  HEEL_STATUS_TOOL,
  HEEL_ACCOUNTS_TOOL,
  HEEL_PROPOSE_RULES_TOOL,
  HEEL_REQUEST_CONNECTION_TOOL,
];
const HEEL_TOOL_NAMES: ReadonlySet<string> = new Set(HEEL_TOOLS.map((tool) => tool.name));

export interface McpSurface {
  /** Whether bare `/mcp` serves code mode: only with a sandboxed worker. */
  readonly codeMode: boolean;
  /** Background scripts (C6), when code mode and parking are on. */
  readonly background: BackgroundRunner | null;
  /** Serves one MCP request for an authenticated agent. */
  serve(request: Request, agent: AuthenticatedAgent, scope: McpScope): Promise<Response>;
  close(): Promise<void>;
}

/** `_meta` key an agent puts its run id under (spec: Run ids). */
export const RUN_ID_META_KEY = "heel/runId";

type ListingAccount = { account: AccountRecord; tools: NonNullable<Definition["tools"]> };

export function createMcpSurface(deps: McpSurfaceDeps): McpSurface {
  const pauses = deps.pauses ?? new SqlitePauseStore();
  const now = deps.now ?? (() => new Date());

  /** Of the accounts an agent may use, those whose definition lists tools. */
  function accountsWithTools(agent: AuthenticatedAgent): ListingAccount[] {
    return accountsUsableBy(deps.db, agent.orgId, agent.ownerId).flatMap((account) => {
      const tools = deps.definitions.forAccount(account)?.tools;
      return tools === undefined ? [] : [{ account, tools }];
    });
  }

  /** An account's tools as this scope lists them. */
  async function accountTools(
    { account, tools }: ListingAccount,
    rename: (tool: string) => string,
  ): Promise<Tool[]> {
    const listed = await tools(AbortSignal.timeout(10_000));
    const builtIn = isBuiltInProvider(account.provider);
    return listed
      .filter((tool) => !HEEL_TOOL_NAMES.has(tool.name))
      .map((tool) => listedTool(tool, rename(tool.name), builtIn));
  }

  async function listTools(agent: AuthenticatedAgent, scope: McpScope): Promise<Tool[]> {
    if (scope.kind === "code") return [RUN_CODE_TOOL, HEEL_STUBS_TOOL, ...HEEL_TOOLS];
    const accounts = accountsWithTools(agent);
    if (scope.kind === "account") {
      const listing = accounts.find(({ account }) => account.alias === scope.alias);
      const tools = listing === undefined ? [] : await accountTools(listing, (name) => name);
      return [...tools, ...HEEL_TOOLS];
    }
    const perAccount = await Promise.all(
      accounts.map(async (listing) => {
        const { alias } = listing.account;
        try {
          return await accountTools(listing, (name) => directName(alias, name));
        } catch (error) {
          // One unreachable upstream must not hide every other account's tools.
          deps.log.warn(
            { account: alias, error: errorShape(error) },
            "account's tools couldn't be listed; they are left out",
          );
          return [];
        }
      }),
    );
    return [...perAccount.flat(), ...HEEL_TOOLS];
  }

  /** Every account the agent may use, as a Python module (spec: Code mode). */
  async function modulesFor(agent: AuthenticatedAgent) {
    const modules = await Promise.all(
      accountsWithTools(agent).map(async ({ account, tools }) => {
        try {
          // Built-in accounts' reads get `_async` twins (C4); heel marks those, not the server.
          const module = accountModule(account.alias, await tools(AbortSignal.timeout(10_000)), {
            asyncReads: isBuiltInProvider(account.provider),
          });
          return module === null ? [] : [{ ...module, account: account.alias }];
        } catch (error) {
          deps.log.warn(
            { account: account.alias, error: errorShape(error) },
            "account's tools couldn't be listed; it's left out of code mode",
          );
          return [];
        }
      }),
    );
    return modules.flat();
  }

  // Background scripts (C6) need code mode and somewhere to park.
  const background =
    deps.codeWorker !== undefined && deps.parking !== undefined
      ? new BackgroundRunner({
          db: deps.db,
          sealer: deps.parking.sealer,
          pipeline: deps.pipeline,
          codeWorker: deps.codeWorker,
          slots: deps.slots,
          modulesFor,
          log: deps.log,
          now,
        })
      : null;

  async function heelStubs(
    agent: AuthenticatedAgent,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const wanted = typeof args["account"] === "string" ? args["account"] : null;
    const modules = (await modulesFor(agent)).filter(
      (m) => wanted === null || m.account === wanted,
    );
    const text = modules
      .map((m) => `# ${m.module}.pyi (account ${m.account})\n${m.stubs}`)
      .join("\n");
    return { content: [{ type: "text", text: text === "" ? "# no accounts" : text }] };
  }

  async function runCode(
    agent: AuthenticatedAgent,
    args: Record<string, unknown>,
    metaRunId: unknown,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    const makeWorker = deps.codeWorker;
    if (makeWorker === undefined) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        "Code mode isn't available on this host",
      );
    }
    const { args: scriptArgs, reason } = takeReason(args);
    const code = typeof scriptArgs["code"] === "string" ? scriptArgs["code"] : "";
    const resumeId = typeof scriptArgs["resume"] === "string" ? scriptArgs["resume"] : undefined;
    const runId =
      typeof scriptArgs["run_id"] === "string"
        ? scriptArgs["run_id"]
        : typeof metaRunId === "string"
          ? metaRunId
          : undefined;
    const answer = (error: string): CallToolResult =>
      runCodeResult({ status: "error", stdout: "", calls: [], error });
    if (resumeId !== undefined && code !== "")
      return answer("send either code or resume, not both");
    if (resumeId === undefined && code === "") return answer("send the script as code");
    if (scriptArgs["background"] === true) {
      if (resumeId !== undefined) return answer("a background script can't resume a parked one");
      if (background === null) return answer("background scripts aren't available on this heel");
      const started = background.start(agent, { code, runId, reason });
      if (!started.ok) {
        return runCodeResult({ status: "busy", stdout: "", calls: [], error: started.message });
      }
      return runCodeResult({
        status: "running",
        script: started.id,
        message: `Running in the background. Follow it with heel_status({"script_id": "${started.id}"}); it carries on by itself after any approval.`,
        stdout: "",
        calls: [],
        error: null,
      });
    }
    // A background script that parked is heel's to resume, once its approval is decided.
    if (resumeId !== undefined && background?.isParkedBackground(resumeId) === true) {
      return answer(
        "heel resumes this background script by itself once its approval is decided; follow it with heel_status",
      );
    }
    if (deps.parking !== undefined) purgeExpiredParked(deps.db, now());
    // A parked script still waiting on its approval: say so without taking a slot or loading it.
    if (resumeId !== undefined) {
      const parked =
        deps.parking === undefined ? null : findParked(deps.db, agent, resumeId, now());
      if (parked === null) {
        return answer(
          "there's no parked script with that resume id: it already ran, expired, your owner stopped it, or it isn't yours",
        );
      }
      const status = approvalStatusForAgent(deps.db, agent, parked.approvalId, now());
      if (status === "pending") {
        return runCodeResult({
          status: "pending",
          approvalId: parked.approvalId,
          resume: parked.id,
          message:
            "Still waiting for approval. Check again with heel_status, then resume the same way.",
          stdout: "",
          calls: [],
          error: null,
        });
      }
    }
    const slot = deps.slots?.tryAcquire(agent.agentId) ?? UNLIMITED_SLOT;
    if (!slot.ok)
      return runCodeResult({ status: "busy", stdout: "", calls: [], error: slot.message });
    const worker = makeWorker(agent.agentId);
    // An aborted request (the HTTP request closing) stops its script, so its slot frees now.
    const stop = () => void worker.stop().catch(() => {});
    signal.addEventListener("abort", stop, { once: true });
    // A listener added to a signal that already fired never runs: a client that hung up
    // before this point gets its script stopped now, before it starts.
    if (signal.aborted) stop();
    try {
      const modules = await modulesFor(agent);
      let resume: ClaimedScript | undefined;
      if (resumeId !== undefined && deps.parking !== undefined) {
        // Read, not taken: it's removed only once the script is back at its call (onRestored),
        // so a resume that fails before that leaves it to try again.
        const claimed = openParked(deps.db, deps.parking.sealer, agent, resumeId, now());
        if (claimed === null) {
          return answer("that parked script can't be resumed: it already ran, or expired");
        }
        // The script was checked against these modules when it started; different ones now
        // (an account added, removed or changed) could leave it calling what isn't there.
        if (claimed.modulesHash !== modulesHash(modules)) {
          return answer(
            "your accounts changed since this script parked, so it can't carry on; send the rest as a new script",
          );
        }
        resume = claimed;
      }
      // A resumed script keeps the run id and reason it started with.
      const scriptReason = resume?.reason ?? reason;
      const result = await runScript({
        code,
        agent,
        runId: resume?.runId ?? runId,
        ...(scriptReason === undefined ? {} : { reason: scriptReason }),
        modules,
        pipeline: deps.pipeline,
        worker,
        // A revoked agent, a disabled owner or an expired token stops the script at its next call.
        stillLive: () => agentStillLive(deps.db, agent, now()),
        ...(resume === undefined || resumeId === undefined
          ? {}
          : { resume, onRestored: () => releaseParked(deps.db, agent, resumeId) }),
        ...(deps.parking === undefined
          ? {}
          : { parking: { db: deps.db, sealer: deps.parking.sealer, now } }),
      });
      return runCodeResult({
        status: result.status,
        ...(result.approvalId === undefined ? {} : { approvalId: result.approvalId }),
        ...(result.resume === undefined
          ? {}
          : { resume: result.resume, message: resumeMessage(result.resume) }),
        ...(result.notParked === undefined ? {} : { notParked: result.notParked }),
        stdout: result.stdout,
        ...lastExpression(result.output),
        calls: result.calls,
        error: result.error,
      });
    } finally {
      signal.removeEventListener("abort", stop);
      // runScript stops the worker when the script ends; this covers a throw on the way.
      await worker.stop().catch(() => {});
      slot.release();
    }
  }

  function runCodeResult(body: {
    status: ScriptStatus | "busy" | "running";
    script?: string;
    approvalId?: string;
    resume?: string;
    message?: string;
    notParked?: string;
    stdout: string;
    output?: unknown;
    output_omitted?: string;
    calls: CallRecord[];
    error: string | null;
  }): CallToolResult {
    return {
      ...((body.status === "error" || body.status === "busy") && { isError: true }),
      content: [{ type: "text", text: JSON.stringify(body) }],
      structuredContent: body,
    };
  }

  /** Stores a rule proposal for the agent's owner; the target file is never the agent's choice. */
  function proposeRulesTool(
    agent: AuthenticatedAgent,
    args: Record<string, unknown>,
  ): CallToolResult {
    const refuse = (body: Record<string, unknown>): CallToolResult => ({
      isError: true,
      content: [{ type: "text", text: JSON.stringify(body) }],
      structuredContent: body,
    });
    const paused = pauses.find(deps.db, {
      orgId: agent.orgId,
      agentId: agent.agentId,
      ownerId: agent.ownerId,
      account: "",
      provider: "",
    });
    if (paused !== null) return refuse({ status: "paused", scope: paused });
    const input = ProposeRulesInput.safeParse(args);
    if (!input.success) {
      return refuse({
        status: "invalid",
        problems: input.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
    }
    const outcome = proposeRules(
      deps.db,
      { orgId: agent.orgId, ownerId: agent.ownerId, agentId: agent.agentId },
      input.data,
      now(),
    );
    if (!outcome.ok) return refuse({ status: "invalid", problems: outcome.problems });
    deps.log.info({ agent: agent.agentName, proposal: outcome.proposalId }, "rules proposed");
    deps.onRuleProposal?.(outcome.proposalId);
    const answer = {
      status: "proposed",
      proposalId: outcome.proposalId,
      expiresAt: outcome.expiresAt.toISOString(),
      message:
        "Your owner will see this on heel's approval page and can add it with a passkey. " +
        "Nothing changes until then; calls it would allow are still decided as they are now.",
    };
    return { content: [{ type: "text", text: JSON.stringify(answer) }], structuredContent: answer };
  }

  /** Stores a connection request for the agent's owner; nothing is connected or contacted. */
  function requestConnectionTool(
    agent: AuthenticatedAgent,
    args: Record<string, unknown>,
  ): CallToolResult {
    const refuse = (body: Record<string, unknown>): CallToolResult => ({
      isError: true,
      content: [{ type: "text", text: JSON.stringify(body) }],
      structuredContent: body,
    });
    const paused = pauses.find(deps.db, {
      orgId: agent.orgId,
      agentId: agent.agentId,
      ownerId: agent.ownerId,
      account: "",
      provider: "",
    });
    if (paused !== null) return refuse({ status: "paused", scope: paused });
    const input = RequestConnectionInput.safeParse(args);
    if (!input.success) {
      return refuse({
        status: "invalid",
        problems: input.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
    }
    const outcome = requestConnection(
      deps.db,
      { orgId: agent.orgId, ownerId: agent.ownerId, agentId: agent.agentId },
      input.data,
      now(),
    );
    if (!outcome.ok) return refuse({ status: "refused", problem: outcome.problem });
    deps.log.info({ agent: agent.agentName, request: outcome.requestId }, "connection requested");
    deps.onAgentRequest?.(outcome.requestId);
    const answer = {
      status: "requested",
      requestId: outcome.requestId,
      expiresAt: outcome.expiresAt.toISOString(),
      message:
        "Your owner will see this on heel's approval page and can connect it with a passkey. " +
        "Nothing is connected until then. Once it is, the account's tools appear and your owner's rules decide what you can do.",
    };
    return { content: [{ type: "text", text: JSON.stringify(answer) }], structuredContent: answer };
  }

  /** The agent's accounts and what it asked for that still waits (roadmap 2.6). Names only. */
  function heelAccounts(agent: AuthenticatedAgent): CallToolResult {
    const at = now();
    const answer = {
      accounts: accountsUsableBy(deps.db, agent.orgId, agent.ownerId).map((a) => ({
        alias: a.alias,
        // A remote MCP server's provider id carries heel's own key; the agent sees "mcp".
        service: isMcpProvider(a.provider) ? "mcp" : a.provider,
        status: a.status,
      })),
      waiting: {
        connections: pendingRequests(deps.db, agent.ownerId, at)
          .filter((r) => r.agentId === agent.agentId)
          .map((r) => ({
            alias: r.details.alias,
            service: r.details.provider,
            expiresAt: r.expiresAt.toISOString(),
          })),
        ruleProposals: pendingProposals(deps.db, agent.ownerId, at)
          // Only its own: heel's suggestions about it (2.10) aren't the agent's to see.
          .filter((p) => p.agentId === agent.agentId && p.origin === "agent")
          .map((p) => ({ proposalId: p.id, expiresAt: p.expiresAt.toISOString() })),
      },
      ...(deps.approvalsUrl === undefined ? {} : { approveAt: deps.approvalsUrl }),
    };
    return { content: [{ type: "text", text: JSON.stringify(answer) }], structuredContent: answer };
  }

  function heelStatus(agent: AuthenticatedAgent, args: Record<string, unknown>): CallToolResult {
    if (typeof args["script_id"] === "string") {
      const view = background?.view(agent, args["script_id"]) ?? null;
      const answer = view ?? { scriptId: args["script_id"], status: "unknown" };
      return {
        ...(view === null && { isError: true }),
        content: [{ type: "text", text: JSON.stringify(answer) }],
        structuredContent: answer as Record<string, unknown>,
      };
    }
    const approvalId = typeof args["approval_id"] === "string" ? args["approval_id"] : "";
    const status = approvalStatusForAgent(deps.db, agent, approvalId, now());
    const answer = { approvalId, status: status ?? "unknown" };
    return {
      ...(status === null && { isError: true }),
      content: [{ type: "text", text: JSON.stringify(answer) }],
      structuredContent: answer,
    };
  }

  async function callTool(
    agent: AuthenticatedAgent,
    scope: McpScope,
    params: {
      name: string;
      arguments?: Record<string, unknown> | undefined;
      _meta?: Record<string, unknown> | undefined;
    },
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    const args = params.arguments ?? {};
    if (params.name === HEEL_STATUS) return heelStatus(agent, args);
    if (params.name === HEEL_ACCOUNTS) return heelAccounts(agent);
    if (params.name === HEEL_PROPOSE_RULES) return proposeRulesTool(agent, args);
    if (params.name === HEEL_REQUEST_CONNECTION) return requestConnectionTool(agent, args);
    if (scope.kind === "code") {
      if (params.name === RUN_CODE)
        return runCode(agent, args, params._meta?.[RUN_ID_META_KEY], signal);
      if (params.name === HEEL_STUBS) return heelStubs(agent, args);
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${params.name}`);
    }
    const target =
      scope.kind === "account"
        ? { alias: scope.alias, tool: params.name }
        : splitDirectName(params.name);
    if (target === null) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${params.name}`);
    }
    // The agent's reason travels beside the call, never inside it (spec: The approval page).
    const { args: callArgs, reason } = takeReason(args);
    const result = await deps.pipeline.run({
      agent,
      surface: "mcp",
      account: target.alias,
      tool: target.tool,
      args: callArgs,
      runId: params._meta?.[RUN_ID_META_KEY],
      ...(reason !== undefined && { reason }),
    });
    // The pipeline already checked the account; this only tells a native tool from a passthrough.
    const account = findAccount(deps.db, agent.orgId, target.alias);
    const native = account !== null && !isMcpProvider(account.provider);
    return toolResult(result, { account: target.alias, tool: target.tool, native });
  }

  /**
   * Records the client an `initialize` names on the token it came with, so a
   * later request can say "via Claude Code". Best effort: a body that isn't
   * JSON is left for the SDK to refuse.
   */
  async function noteClient(request: Request, agent: AuthenticatedAgent): Promise<void> {
    if (request.method !== "POST") return;
    const body: unknown = await request
      .clone()
      .json()
      .catch(() => null);
    const name = clientNameFrom(body);
    if (name === null || name === agent.clientName) return;
    deps.db
      .update(agentTokens)
      .set({ clientName: name })
      .where(eq(agentTokens.id, agent.tokenId))
      .run();
  }

  const handler: McpHttpHandler = createMcpHandler(({ authInfo }) => {
    const context = authInfo?.extra as { agent: AuthenticatedAgent; scope: McpScope } | undefined;
    // `serve` always passes these; reaching here without them is a bug in heel, not a caller error.
    if (context === undefined) throw new Error("MCP request reached the server without an agent");
    const { agent, scope } = context;
    const server = new Server(
      { name: "heel", version: deps.version },
      { capabilities: { tools: {}, prompts: {} } },
    );
    server.setRequestHandler("tools/list", async () => ({ tools: await listTools(agent, scope) }));
    // The setup prompt (roadmap 2.6): in Claude Code, /mcp__heel__setup.
    server.setRequestHandler("prompts/list", async () => ({
      prompts: [
        {
          name: SETUP_PROMPT_NAME,
          title: "Put my services behind heel",
          description:
            "Find the services you use, ask heel to connect each and propose rules, then help replace the raw keys. Everything waits for your passkey.",
        },
      ],
    }));
    server.setRequestHandler("prompts/get", async (request) => {
      if (request.params.name !== SETUP_PROMPT_NAME) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Unknown prompt: ${request.params.name}`,
        );
      }
      return {
        description: "Put my services behind heel",
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: setupPrompt(deps.approvalsUrl ?? null) },
          },
        ],
      };
    });
    server.setRequestHandler("tools/call", async (request, ctx) =>
      withExpiryNote(
        await callTool(agent, scope, request.params, ctx.mcpReq.signal),
        agent,
        deps.now?.() ?? new Date(),
      ),
    );
    return server;
  });

  return {
    codeMode: deps.codeWorker !== undefined,
    background,
    serve: async (request, agent, scope) => {
      await noteClient(request, agent);
      return handler.fetch(request, {
        // Pass-through to the factory; the SDK never reads it as a credential.
        authInfo: {
          token: agent.agentId,
          clientId: agent.agentId,
          scopes: [],
          extra: { agent, scope },
        },
      });
    },
    close: async () => {
      await background?.close();
      await handler.close();
    },
  };
}

/**
 * A static token close to its expiry adds one line to every tool result, so
 * the agent can tell its person before calls start failing (roadmap 1.6).
 * OAuth access tokens renew themselves and are left alone.
 */
export function withExpiryNote(
  result: CallToolResult,
  agent: Pick<AuthenticatedAgent, "agentName" | "tokenExpiresAt">,
  now: Date,
): CallToolResult {
  const expiresAt = agent.tokenExpiresAt ?? null;
  if (expiresAt === null) return result;
  const days = Math.ceil((expiresAt.getTime() - now.getTime()) / 86_400_000);
  if (days > TOKEN_WARNING_DAYS) return result;
  const text =
    `heel: this agent's token expires on ${expiresAt.toISOString().slice(0, 10)} ` +
    `(in ${days} day${days === 1 ? "" : "s"}). Ask the person who runs heel to issue a new one ` +
    `with \`heel agent rotate ${agent.agentName}\` and put it in this agent's configuration.`;
  return { ...result, content: [...(result.content ?? []), { type: "text", text }] };
}
