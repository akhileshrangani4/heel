import {
  type CallToolResult,
  createMcpHandler,
  type McpHttpHandler,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type Tool,
} from "@modelcontextprotocol/server";
import { runScript } from "../../codemode/run.ts";
import { accountModule } from "../../codemode/stubs.ts";
import type { CodeWorker } from "../../codemode/worker.ts";
import type { Logger } from "../../log.ts";
import { approvalStatusForAgent } from "../../store/approvals.ts";
import type { HeelDb } from "../../store/db.ts";
import type { AccountRecord } from "../../store/directory.ts";
import { accountsUsableBy } from "../../store/sharing.ts";
import { errorShape } from "../../util/error-shape.ts";
import { isMcpProvider } from "../../vault/connect.ts";
import type { AuthenticatedAgent } from "../agent-tokens.ts";
import type { Pipeline } from "../pipeline/pipeline.ts";
import type { Definition, DefinitionRegistry } from "../pipeline/ports.ts";
import {
  directName,
  HEEL_STATUS,
  HEEL_STATUS_TOOL,
  HEEL_STUBS,
  HEEL_STUBS_TOOL,
  listedTool,
  RUN_CODE,
  RUN_CODE_TOOL,
  splitDirectName,
} from "./names.ts";
import { toolResult } from "./results.ts";

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
  codeWorker?: () => CodeWorker;
}

export interface McpSurface {
  /** Whether bare `/mcp` serves code mode: only with a sandboxed worker. */
  readonly codeMode: boolean;
  /** Serves one MCP request for an authenticated agent. */
  serve(request: Request, agent: AuthenticatedAgent, scope: McpScope): Promise<Response>;
  close(): Promise<void>;
}

/** `_meta` key an agent puts its run id under (spec: Run ids). */
export const RUN_ID_META_KEY = "heel/runId";

type ListingAccount = { account: AccountRecord; tools: NonNullable<Definition["tools"]> };

export function createMcpSurface(deps: McpSurfaceDeps): McpSurface {
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
    { tools }: ListingAccount,
    rename: (tool: string) => string,
  ): Promise<Tool[]> {
    const listed = await tools(AbortSignal.timeout(10_000));
    return listed
      .filter((tool) => tool.name !== HEEL_STATUS)
      .map((tool) => listedTool(tool, rename(tool.name)));
  }

  async function listTools(agent: AuthenticatedAgent, scope: McpScope): Promise<Tool[]> {
    if (scope.kind === "code") return [RUN_CODE_TOOL, HEEL_STUBS_TOOL, HEEL_STATUS_TOOL];
    const accounts = accountsWithTools(agent);
    if (scope.kind === "account") {
      const listing = accounts.find(({ account }) => account.alias === scope.alias);
      const tools = listing === undefined ? [] : await accountTools(listing, (name) => name);
      return [...tools, HEEL_STATUS_TOOL];
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
    return [...perAccount.flat(), HEEL_STATUS_TOOL];
  }

  /** Every account the agent may use, as a Python module (spec: Code mode). */
  async function modulesFor(agent: AuthenticatedAgent) {
    const modules = await Promise.all(
      accountsWithTools(agent).map(async ({ account, tools }) => {
        try {
          const module = accountModule(account.alias, await tools(AbortSignal.timeout(10_000)));
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
  ): Promise<CallToolResult> {
    const makeWorker = deps.codeWorker;
    if (makeWorker === undefined) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        "Code mode isn't available on this host",
      );
    }
    const code = typeof args["code"] === "string" ? args["code"] : "";
    const runId =
      typeof args["run_id"] === "string"
        ? args["run_id"]
        : typeof metaRunId === "string"
          ? metaRunId
          : undefined;
    const result = await runScript({
      code,
      agent,
      runId,
      modules: await modulesFor(agent),
      pipeline: deps.pipeline,
      worker: makeWorker(),
    });
    const body = {
      status: result.status,
      ...(result.approvalId === undefined ? {} : { approvalId: result.approvalId }),
      stdout: result.stdout,
      calls: result.calls,
      error: result.error,
    };
    return {
      ...(result.status === "error" && { isError: true }),
      content: [{ type: "text", text: JSON.stringify(body) }],
      structuredContent: body,
    };
  }

  function heelStatus(agent: AuthenticatedAgent, args: Record<string, unknown>): CallToolResult {
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
  ): Promise<CallToolResult> {
    const args = params.arguments ?? {};
    if (params.name === HEEL_STATUS) return heelStatus(agent, args);
    if (scope.kind === "code") {
      if (params.name === RUN_CODE) return runCode(agent, args, params._meta?.[RUN_ID_META_KEY]);
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
    const result = await deps.pipeline.run({
      agent,
      surface: "mcp",
      account: target.alias,
      tool: target.tool,
      args,
      runId: params._meta?.[RUN_ID_META_KEY],
    });
    const account = accountsUsableBy(deps.db, agent.orgId, agent.ownerId).find(
      (a) => a.alias === target.alias,
    );
    const native = account !== undefined && !isMcpProvider(account.provider);
    return toolResult(result, { account: target.alias, tool: target.tool, native });
  }

  const handler: McpHttpHandler = createMcpHandler(({ authInfo }) => {
    const context = authInfo?.extra as { agent: AuthenticatedAgent; scope: McpScope } | undefined;
    // `serve` always passes these; reaching here without them is a bug in heel, not a caller error.
    if (context === undefined) throw new Error("MCP request reached the server without an agent");
    const { agent, scope } = context;
    const server = new Server(
      { name: "heel", version: deps.version },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler("tools/list", async () => ({ tools: await listTools(agent, scope) }));
    server.setRequestHandler("tools/call", async (request) =>
      callTool(agent, scope, request.params),
    );
    return server;
  });

  return {
    codeMode: deps.codeWorker !== undefined,
    serve: (request, agent, scope) =>
      handler.fetch(request, {
        // Pass-through to the factory; the SDK never reads it as a credential.
        authInfo: {
          token: agent.agentId,
          clientId: agent.agentId,
          scopes: [],
          extra: { agent, scope },
        },
      }),
    close: () => handler.close(),
  };
}
