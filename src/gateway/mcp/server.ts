import {
  type CallToolResult,
  createMcpHandler,
  type McpHttpHandler,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type Tool,
} from "@modelcontextprotocol/server";
import type { UpstreamPool } from "../../definitions/mcp/upstream.ts";
import type { Logger } from "../../log.ts";
import { approvalStatusForAgent } from "../../store/approvals.ts";
import type { HeelDb } from "../../store/db.ts";
import { type AccountRecord, accountsOwnedBy } from "../../store/directory.ts";
import { errorShape } from "../../util/error-shape.ts";
import { isMcpProvider } from "../../vault/connect.ts";
import type { AuthenticatedAgent } from "../agent-tokens.ts";
import type { Pipeline } from "../pipeline/pipeline.ts";
import { directName, HEEL_STATUS, HEEL_STATUS_TOOL, listedTool, splitDirectName } from "./names.ts";
import { toolResult } from "./results.ts";

/**
 * heel's MCP endpoints on the agent plane (spec: MCP and code mode).
 *
 * The agent was authenticated before the request got here (requireAgent).
 * For each request the SDK builds a fresh low-level `Server` for that agent
 * and scope, which answers two things:
 *
 * - `tools/list`: the tools of the accounts the agent's owner owns, as each
 *   upstream lists them now, plus `heel_status`;
 * - `tools/call`: every call goes through the decision pipeline as one
 *   `Call` with `surface: "mcp"`; `heel_status` only reads an approval.
 *
 * Built-in providers list no tools until their definitions land (D9 on).
 */

/** Which tools a request sees: one account's, or every account's prefixed. */
export type McpScope = { kind: "account"; alias: string } | { kind: "direct" };

export interface McpSurfaceDeps {
  db: HeelDb;
  pipeline: Pipeline;
  upstream: UpstreamPool;
  log: Logger;
  version: string;
  now?: () => Date;
}

export interface McpSurface {
  /** Serves one MCP request for an authenticated agent. */
  serve(request: Request, agent: AuthenticatedAgent, scope: McpScope): Promise<Response>;
  close(): Promise<void>;
}

/** `_meta` key an agent puts its run id under (spec: Run ids). */
export const RUN_ID_META_KEY = "heel/runId";

/** Of the accounts an agent may use, those that list tools today. */
function accountsWithTools(db: HeelDb, agent: AuthenticatedAgent): AccountRecord[] {
  return accountsOwnedBy(db, agent.orgId, agent.ownerId).filter((account) =>
    isMcpProvider(account.provider),
  );
}

export function createMcpSurface(deps: McpSurfaceDeps): McpSurface {
  const now = deps.now ?? (() => new Date());

  /** An upstream's tools as this scope lists them, or [] when it can't be reached. */
  async function upstreamTools(
    account: AccountRecord,
    rename: (tool: string) => string,
  ): Promise<Tool[]> {
    const tools = await deps.upstream.listTools(account, AbortSignal.timeout(10_000));
    return tools
      .filter((tool) => tool.name !== HEEL_STATUS)
      .map((tool) => listedTool(tool, rename(tool.name)));
  }

  async function listTools(agent: AuthenticatedAgent, scope: McpScope): Promise<Tool[]> {
    const accounts = accountsWithTools(deps.db, agent);
    if (scope.kind === "account") {
      const account = accounts.find((a) => a.alias === scope.alias);
      const tools = account === undefined ? [] : await upstreamTools(account, (name) => name);
      return [...tools, HEEL_STATUS_TOOL];
    }
    const perAccount = await Promise.all(
      accounts.map(async (account) => {
        try {
          return await upstreamTools(account, (name) => directName(account.alias, name));
        } catch (error) {
          // One unreachable upstream must not hide every other account's tools.
          deps.log.warn(
            { account: account.alias, error: errorShape(error) },
            "upstream MCP server unreachable; its tools are left out of the list",
          );
          return [];
        }
      }),
    );
    return [...perAccount.flat(), HEEL_STATUS_TOOL];
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
    return toolResult(result, { account: target.alias, tool: target.tool });
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
