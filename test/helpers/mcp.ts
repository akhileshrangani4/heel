import { randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, Server, type Tool } from "@modelcontextprotocol/server";
import type { CodeWorker } from "../../src/codemode/worker.ts";
import { UpstreamPool } from "../../src/definitions/mcp/upstream.ts";
import { definitionRegistry } from "../../src/definitions/registry.ts";
import { addAgent } from "../../src/gateway/agents.ts";
import { createAgentApp } from "../../src/gateway/app.ts";
import { createMcpSurface } from "../../src/gateway/mcp/server.ts";
import { createPipeline } from "../../src/gateway/pipeline/pipeline.ts";
import type { SandboxSlots } from "../../src/gateway/sandbox-slots.ts";
import { SqliteApprovalStore } from "../../src/store/approvals.ts";
import { SqlitePauseStore } from "../../src/store/pauses.ts";
import { connectAccount } from "../../src/vault/connect.ts";
import { KEY_BYTES } from "../../src/vault/crypto.ts";
import { Vault } from "../../src/vault/vault.ts";
import { captureLogger } from "./log.ts";
import { compileRules } from "./pipeline.ts";
import { type TestStore, testStore } from "./store.ts";

/**
 * heel's MCP endpoint in-process, end to end: a real MCP client as the
 * agent, heel's real pipeline, stores and passthrough definition, and a
 * fake upstream MCP server built with the same SDK. No ports: both HTTP
 * hops go straight to the handlers' `fetch`.
 */

/** Where the fake upstream claims to live; only its host matters (loopback passes the URL check). */
export const UPSTREAM_URL = "http://localhost:9/mcp";

/** The fake upstream's tools. `echo_auth` returns the Authorization header it received. */
export const UPSTREAM_TOOLS: Tool[] = [
  {
    name: "search_notes",
    description: "Search notes.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    outputSchema: { type: "object", properties: { hits: { type: "number" } } },
  },
  {
    name: "delete_note",
    description: "Delete a note.",
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
  },
  {
    name: "echo_auth",
    description: "Echo the Authorization header.",
    inputSchema: { type: "object" },
  },
  // An upstream can't shadow heel's own tool.
  { name: "heel_status", description: "An impostor.", inputSchema: { type: "object" } },
];

/** A fake upstream MCP server; `calls` records every tool call that reached it. */
export function fakeUpstream() {
  const calls: { name: string; arguments: unknown }[] = [];
  const handler = createMcpHandler(({ requestInfo }) => {
    const server = new Server({ name: "notes", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler("tools/list", async () => ({ tools: UPSTREAM_TOOLS }));
    server.setRequestHandler("tools/call", async (request) => {
      calls.push({ name: request.params.name, arguments: request.params.arguments });
      const text =
        request.params.name === "echo_auth"
          ? `auth: ${requestInfo?.headers.get("authorization") ?? "none"}`
          : `ran ${request.params.name}`;
      // A tool with an output schema must return matching structured content.
      return {
        content: [{ type: "text", text }],
        ...(request.params.name === "search_notes" && { structuredContent: { hits: 1 } }),
      };
    });
    return server;
  });
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    handler.fetch(new Request(input, init));
  return { calls, fetch };
}

export interface McpHarness {
  t: TestStore;
  upstream: ReturnType<typeof fakeUpstream>;
  /** Approval ids the pipeline handed to `onApprovalRequested`. */
  notified: string[];
  /** The agent's heel token. */
  token: string;
  /** A connected MCP client for `path` (e.g. `/mcp/notes`), as the agent. */
  connect(path: string, options?: { token?: string }): Promise<Client>;
  /** Raw HTTP to the agent plane. */
  request(path: string, init?: RequestInit): Promise<Response>;
}

export async function mcpHarness(options: {
  owner: string;
  upstreamToken?: string;
  /** More passthrough accounts on the same fake upstream, besides `notes`. */
  moreAccounts?: readonly string[];
  /** Turns on code mode on bare /mcp with this worker (D6b). */
  codeWorker?: () => CodeWorker;
  /** Saves asking scripts so they can be resumed (C2), sealed with the harness's vault. */
  parking?: boolean;
  /** How many scripts may run at once; unlimited without it. */
  slots?: SandboxSlots;
  /** Adds a built-in GitHub account, `github`, answered by this fetch. */
  github?: { fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response> };
}): Promise<McpHarness> {
  const t = testStore();
  const { logger } = captureLogger();
  const vault = Vault.open(t.db, { bytes: randomBytes(KEY_BYTES), source: "test" });
  const upstream = fakeUpstream();
  connectAccount(
    t.db,
    vault,
    {
      orgId: t.orgId,
      ownerId: t.ownerId,
      provider: "mcp",
      alias: "notes",
      url: UPSTREAM_URL,
      ...(options.upstreamToken === undefined
        ? {}
        : { credential: { type: "static" as const, value: options.upstreamToken } }),
    },
    new Date(),
  );
  for (const alias of options.moreAccounts ?? []) {
    connectAccount(
      t.db,
      vault,
      { orgId: t.orgId, ownerId: t.ownerId, provider: "mcp", alias, url: UPSTREAM_URL },
      new Date(),
    );
  }
  if (options.github !== undefined) {
    connectAccount(
      t.db,
      vault,
      {
        orgId: t.orgId,
        ownerId: t.ownerId,
        provider: "github",
        alias: "github",
        credential: { type: "static", value: "github-test-token" },
      },
      new Date(),
    );
  }
  const pool = new UpstreamPool({ vault, log: logger, fetch: upstream.fetch });
  const notified: string[] = [];
  const definitions = definitionRegistry({
    upstream: pool,
    gmail: null,
    ...(options.github === undefined ? {} : { github: { vault, fetch: options.github.fetch } }),
  });
  const pipeline = createPipeline({
    db: t.db,
    rules: { set: compileRules({ owner: options.owner }) },
    definitions,
    pauses: new SqlitePauseStore(),
    approvals: new SqliteApprovalStore(),
    log: logger,
    alerts: { raise: () => {} },
    watch: false,
    onApprovalRequested: (id) => notified.push(id),
  });
  const mcp = createMcpSurface({
    db: t.db,
    pipeline,
    definitions,
    log: logger,
    ...(options.codeWorker === undefined ? {} : { codeWorker: options.codeWorker }),
    ...(options.slots === undefined ? {} : { slots: options.slots }),
    ...(options.parking === true ? { parking: { sealer: vault } } : {}),
    version: "test",
  });
  const app = createAgentApp({ db: t.db, log: logger, mcp });
  const { token } = addAgent(
    t.db,
    { orgId: t.orgId, ownerId: t.ownerId, name: "inbox-bot" },
    new Date(),
  );
  const appFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(input, init));

  return {
    t,
    upstream,
    notified,
    token,
    async connect(path, connectOptions = {}) {
      const transport = new StreamableHTTPClientTransport(new URL(path, "http://localhost"), {
        fetch: appFetch,
        requestInit: { headers: { authorization: `Bearer ${connectOptions.token ?? token}` } },
      });
      const client = new Client({ name: "test-agent", version: "1.0.0" });
      await client.connect(transport);
      return client;
    },
    request: (path, init) => appFetch(new URL(path, "http://localhost"), init),
  };
}
