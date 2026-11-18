import { Hono } from "hono";
import type { Logger } from "../log.ts";
import { approvalStatusForAgent } from "../store/approvals.ts";
import type { HeelDb } from "../store/db.ts";
import { type AgentPlaneEnv, requireAgent } from "./require-agent.ts";

export interface AgentAppDeps {
  db: HeelDb;
  log: Logger;
  now?: () => Date;
}

/**
 * The agent plane's surfaces (spec: Architecture, "Listeners"). Each one is
 * built by its own deliverable: MCP and code mode (D5, D6), the HTTP proxy
 * (D7) and the CLI runner (D8).
 */
const SURFACE_ROUTES = ["/mcp", "/mcp/*", "/http/*", "/run"] as const;

/**
 * The agent plane. Every request, including one for an unknown path, is
 * authenticated first (I-03), so an unauthenticated caller can't even learn
 * which endpoints exist. A surface whose pipeline isn't built yet denies
 * every call: nothing on this plane reaches an upstream by default.
 */
export function createAgentApp(deps: AgentAppDeps): Hono<AgentPlaneEnv> {
  const app = new Hono<AgentPlaneEnv>();
  app.use("*", requireAgent(deps));

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
  for (const route of SURFACE_ROUTES) {
    app.all(route, (c) =>
      c.json({ status: "denied", reason: "surface_unavailable", rule: null }, 501),
    );
  }
  app.notFound((c) => c.json({ status: "denied", reason: "unknown_endpoint", rule: null }, 404));
  app.onError((error, c) => {
    // Fail closed (spec: Fail-closed behavior): nothing was sent upstream.
    deps.log.error({ err: error, path: c.req.path }, "agent plane request failed");
    return c.json({ status: "denied", reason: "heel error" }, 503);
  });
  return app;
}
