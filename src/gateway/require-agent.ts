import type { MiddlewareHandler } from "hono";
import type { Logger } from "../log.ts";
import type { HeelDb } from "../store/db.ts";
import { type AuthenticatedAgent, authenticateAgent, isAgentTokenShape } from "./agent-tokens.ts";

export interface AgentPlaneEnv {
  Variables: { agent: AuthenticatedAgent };
}

/** Pure: true when any query parameter carries a heel token (spec: tokens go in the header only). */
export function queryCarriesAgentToken(url: URL): boolean {
  for (const value of url.searchParams.values()) {
    if (isAgentTokenShape(value)) return true;
  }
  return false;
}

/**
 * The agent plane's first step (spec: Pipeline order, step 1). Nothing after
 * this middleware runs for a missing, malformed, unknown or revoked token
 * (I-03). The 401 body is empty and identical for every failure so a caller
 * learns nothing about which tokens once existed; the reason goes to the log,
 * never the token.
 */
export function requireAgent(deps: { db: HeelDb; log: Logger }): MiddlewareHandler<AgentPlaneEnv> {
  return async (c, next) => {
    const url = new URL(c.req.url);
    if (queryCarriesAgentToken(url)) {
      deps.log.warn({ path: url.pathname }, "agent token sent in a query string; rejected");
      return unauthorized();
    }
    let result: ReturnType<typeof authenticateAgent>;
    try {
      result = authenticateAgent(deps.db, c.req.header("authorization"));
    } catch (error) {
      // A store failure must not let a request through (spec: Fail-closed behavior).
      deps.log.error({ err: error }, "agent authentication failed: store error");
      return c.json({ status: "denied", reason: "heel error" }, 503);
    }
    if (!result.ok) {
      deps.log.warn(
        { failure: result.failure, path: url.pathname },
        "agent authentication rejected",
      );
      return unauthorized();
    }
    c.set("agent", result.agent);
    return next();
  };
}

function unauthorized(): Response {
  return new Response(null, {
    status: 401,
    headers: { "www-authenticate": 'Bearer realm="heel"' },
  });
}
