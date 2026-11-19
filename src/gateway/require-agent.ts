import type { MiddlewareHandler } from "hono";
import type { Logger } from "../log.ts";
import type { HeelDb } from "../store/db.ts";
import {
  type AgentAuthFailure,
  type AuthenticatedAgent,
  authenticateAgent,
  isAgentTokenShape,
} from "./agent-tokens.ts";

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
export function requireAgent(deps: {
  db: HeelDb;
  log: Logger;
  now?: () => Date;
  /**
   * The protected-resource metadata URL, when OAuth for connectors is on.
   * Every 401 names it, which is how an MCP client finds where to sign in.
   */
  resourceMetadataUrl?: string;
}): MiddlewareHandler<AgentPlaneEnv> {
  /**
   * The body says why in words a person can act on. Expired is told apart
   * (the fix is a new token); unknown and revoked are not, so a guessed token
   * learns nothing.
   */
  const unauthorized = (failure: AgentAuthFailure | "query" = "unknown"): Response =>
    new Response(JSON.stringify(refusalBody(failure)), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate":
          deps.resourceMetadataUrl === undefined
            ? 'Bearer realm="heel"'
            : `Bearer realm="heel", resource_metadata="${deps.resourceMetadataUrl}"`,
      },
    });
  return async (c, next) => {
    const url = new URL(c.req.url);
    if (queryCarriesAgentToken(url)) {
      deps.log.warn({ path: url.pathname }, "agent token sent in a query string; rejected");
      return unauthorized("query");
    }
    let result: ReturnType<typeof authenticateAgent>;
    try {
      result = authenticateAgent(
        deps.db,
        c.req.header("authorization"),
        deps.now?.() ?? new Date(),
      );
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
      return unauthorized(result.failure);
    }
    c.set("agent", result.agent);
    return next();
  };
}

/** Pure: the JSON body of an agent-plane 401. */
export function refusalBody(failure: AgentAuthFailure | "query"): {
  status: "denied";
  reason: "token_expired" | "token_refused";
  message: string;
} {
  switch (failure) {
    case "expired":
      return {
        status: "denied",
        reason: "token_expired",
        message:
          "This agent token has expired. Whoever runs heel can issue a new one with `heel agent rotate <agent>`, then update this agent's configuration.",
      };
    case "query":
      return {
        status: "denied",
        reason: "token_refused",
        message: "Send the agent token in the Authorization header (Bearer), never in the URL.",
      };
    default:
      return {
        status: "denied",
        reason: "token_refused",
        message:
          "heel didn't accept this agent token: it is missing, mistyped, or no longer valid. Check HEEL_TOKEN or this agent's configuration.",
      };
  }
}
