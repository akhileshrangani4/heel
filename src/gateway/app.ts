import { Hono } from "hono";
import type { Logger } from "../log.ts";
import { approvalStatusForAgent } from "../store/approvals.ts";
import type { HeelDb } from "../store/db.ts";
import { findAccount } from "../store/directory.ts";
import { requireServedHost } from "./allowed-hosts.ts";
import { type HttpProxyDeps, handleHttpProxy } from "./http-proxy.ts";
import type { McpSurface } from "./mcp/server.ts";
import type { Pipeline } from "./pipeline/pipeline.ts";
import { type AgentPlaneEnv, requireAgent } from "./require-agent.ts";
import { handleRun } from "./run-route.ts";

export interface AgentAppDeps {
  db: HeelDb;
  log: Logger;
  now?: () => Date;
  /** The MCP endpoints; without it they answer 501, like any surface not built yet. */
  mcp?: McpSurface;
  /** The HTTP proxy (D7a); absent, `/http/*` answers that it isn't available. */
  http?: HttpProxyDeps;
  /**
   * OAuth for connectors (A2): where the agent plane is reachable and which
   * authorization server issues its tokens. Null or absent: static tokens only.
   */
  oauth?: { agentPublicUrl: URL; authorizationServer: URL } | null;
  /**
   * Hostnames besides loopback the agent plane answers to: its listen host,
   * and `agent_public_url`'s host (DNS-rebinding protection).
   */
  hosts?: readonly string[];
  /** The CLI runner's `/run` (D8b); without it, `/run` answers 501. */
  run?: { pipeline: Pipeline; sandbox: boolean };
}

/** RFC 9728: where an MCP client learns which authorization server to use. */
const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";

/**
 * The agent plane's surfaces (spec: Architecture, "Listeners"). Each one is
 * built by its own deliverable: MCP and code mode (D5, D6), the HTTP proxy
 * (D7) and the CLI runner (D8).
 */
const SURFACE_ROUTES: readonly string[] = [];

const NOT_BUILT = { status: "denied", reason: "surface_unavailable", rule: null } as const;

/**
 * The agent plane. Every request, including one for an unknown path, is
 * authenticated first (I-03), so an unauthenticated caller can't even learn
 * which endpoints exist. A surface whose pipeline isn't built yet denies
 * every call: nothing on this plane reaches an upstream by default.
 */
export function createAgentApp(deps: AgentAppDeps): Hono<AgentPlaneEnv> {
  const app = new Hono<AgentPlaneEnv>();
  app.use(
    "*",
    requireServedHost([
      ...(deps.hosts ?? []),
      ...(deps.oauth ? [deps.oauth.agentPublicUrl.hostname] : []),
    ]),
  );
  const oauth = deps.oauth ?? null;
  if (oauth !== null) {
    // Before authentication: a client reads this to find out how to get a token.
    app.get(`${PROTECTED_RESOURCE_PATH}/*`, (c) => {
      const resourcePath = new URL(c.req.url).pathname.slice(PROTECTED_RESOURCE_PATH.length);
      return c.json({
        resource: new URL(resourcePath, oauth.agentPublicUrl).toString(),
        authorization_servers: [oauth.authorizationServer.origin],
        bearer_methods_supported: ["header"],
        resource_name: "heel",
      });
    });
    app.get(PROTECTED_RESOURCE_PATH, (c) =>
      c.json({
        resource: oauth.agentPublicUrl.toString(),
        authorization_servers: [oauth.authorizationServer.origin],
        bearer_methods_supported: ["header"],
        resource_name: "heel",
      }),
    );
  }
  app.use(
    "*",
    requireAgent({
      ...deps,
      ...(oauth !== null && {
        resourceMetadataUrl: new URL(PROTECTED_RESOURCE_PATH, oauth.agentPublicUrl).toString(),
      }),
    }),
  );

  // MCP (spec: Endpoints and tools). Bare /mcp is code mode, served only
  // where the sandbox runs (D6b); without it, it says where the direct tools are.
  app.all("/mcp", async (c) => {
    const mcp = deps.mcp;
    if (mcp === undefined) return c.json(NOT_BUILT, 501);
    if (c.req.query("tools") === "direct") {
      return mcp.serve(c.req.raw, c.get("agent"), { kind: "direct" });
    }
    if (mcp.codeMode) return mcp.serve(c.req.raw, c.get("agent"), { kind: "code" });
    return c.json(
      {
        ...NOT_BUILT,
        message:
          "Code mode needs the sandbox, which this host can't run. Use /mcp?tools=direct, or /mcp/<account>.",
      },
      501,
    );
  });
  app.all("/mcp/:account", async (c) => {
    const mcp = deps.mcp;
    if (mcp === undefined) return c.json(NOT_BUILT, 501);
    const agent = c.get("agent");
    const alias = c.req.param("account");
    const account = findAccount(deps.db, agent.orgId, alias);
    // Someone else's account reads as unknown, so aliases can't be probed.
    if (account === null || account.ownerId !== agent.ownerId) {
      return c.json({ status: "denied", reason: "unknown_endpoint", rule: null }, 404);
    }
    return mcp.serve(c.req.raw, agent, { kind: "account", alias });
  });

  // Check-back (spec: Pending, joining and checking back): read-only, and only
  // for the agent that made the request. Another agent's id reads as unknown,
  // so ids can't be probed. Re-sending the call is the only way it runs.
  app.get("/approvals/:id", (c) => {
    const agent = c.get("agent");
    const approvalId = c.req.param("id");
    const now = deps.now?.() ?? new Date();
    const status = approvalStatusForAgent(deps.db, agent, approvalId, now);
    if (status === null) return c.json({ status: "unknown", approvalId }, 404);
    return c.json({ status, approvalId });
  });
  app.all("/http/*", async (c) => {
    const http = deps.http;
    if (http === undefined) return c.json(NOT_BUILT, 501);
    return handleHttpProxy(c, c.get("agent"), http);
  });
  app.post("/run", async (c) => {
    if (deps.run === undefined) return c.json(NOT_BUILT, 501);
    return handleRun(c, c.get("agent"), { db: deps.db, ...deps.run });
  });
  app.all("/run", (c) =>
    c.json({ status: "denied", reason: "method_not_allowed", rule: null }, 405),
  );
  for (const route of SURFACE_ROUTES) {
    app.all(route, (c) => c.json(NOT_BUILT, 501));
  }
  app.notFound((c) => c.json({ status: "denied", reason: "unknown_endpoint", rule: null }, 404));
  app.onError((error, c) => {
    // Fail closed (spec: Fail-closed behavior): nothing was sent upstream.
    deps.log.error({ err: error, path: c.req.path }, "agent plane request failed");
    return c.json({ status: "denied", reason: "heel error" }, 503);
  });
  return app;
}
