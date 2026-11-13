import { Hono } from "hono";
import type { Logger } from "../log.ts";
import type { HeelDb } from "../store/db.ts";
import { type AgentPlaneEnv, requireAgent } from "./require-agent.ts";

export interface AgentAppDeps {
  db: HeelDb;
  log: Logger;
}

/**
 * The agent plane's surfaces (spec: Architecture, "Listeners"). Each one is
 * built by its own deliverable: MCP and code mode (D5, D6), the HTTP proxy
 * (D7), the CLI runner (D8) and approval check-back (D4).
 */
const SURFACE_ROUTES = ["/mcp", "/mcp/*", "/http/*", "/run", "/approvals/*"] as const;

/**
 * The agent plane. Every request, including one for an unknown path, is
 * authenticated first (I-03), so an unauthenticated caller can't even learn
 * which endpoints exist. A surface whose pipeline isn't built yet denies
 * every call: nothing on this plane reaches an upstream by default.
 */
export function createAgentApp(deps: AgentAppDeps): Hono<AgentPlaneEnv> {
  const app = new Hono<AgentPlaneEnv>();
  app.use("*", requireAgent(deps));
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
