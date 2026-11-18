import type { Context } from "hono";
import type { HttpArgs, HttpResponse } from "../definitions/http/definition.ts";
import { HTTP_METHODS } from "../definitions/http/openapi.ts";
import type { Logger } from "../log.ts";
import type { HeelDb } from "../store/db.ts";
import { findAccount } from "../store/directory.ts";
import { isHttpProvider } from "../vault/connect.ts";
import type { AuthenticatedAgent } from "./agent-tokens.ts";
import type { Pipeline } from "./pipeline/pipeline.ts";
import type { PipelineResult } from "./pipeline/ports.ts";

/**
 * The HTTP proxy surface (D7a; spec: HTTP proxy):
 * `<METHOD> /http/<account>/<path>?<query>` with the agent's heel token.
 *
 * - The target can't change: an encoded slash or backslash, a `.` or `..`
 *   segment after decoding, a scheme-relative path, or a forwarded-host
 *   header is refused with 400 before anything else.
 * - Request bodies are capped at 25 MB.
 * - The decision maps to the spec's statuses: the upstream's own status for
 *   an allow (with `Heel-Decision: allow`), 202 for an ask, 403 for a deny,
 *   423 for a pause, 410 for an expired approval.
 */

const MAX_BODY_BYTES = 25 * 1024 * 1024;
const PREFIX = /^\/http\/([^/]+)(\/.*)?$/;

export interface HttpProxyDeps {
  db: HeelDb;
  pipeline: Pipeline;
  log: Logger;
}

type Refusal = { status: 400 | 404 | 413; body: Record<string, unknown> };

const refuse = (status: Refusal["status"], reason: string): Refusal => ({
  status,
  body: { status: "denied", reason, rule: null },
});

/** Pure: the path below the account, or why it's refused. Works on the raw, undecoded path. */
export function proxiedPath(rawPath: string): { account: string; path: string } | Refusal {
  const match = PREFIX.exec(rawPath);
  if (match === null) return refuse(404, "unknown_endpoint");
  const account = decodeURIComponent(match[1] ?? "");
  const raw = match[2] ?? "/";
  if (/%2f|%5c|\\/i.test(raw)) return refuse(400, "path_not_allowed");
  if (raw.startsWith("//")) return refuse(400, "path_not_allowed");
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return refuse(400, "path_not_allowed");
  }
  const segments = decoded.split("/").slice(1);
  if (segments.some((s) => s === "." || s === "..")) return refuse(400, "path_not_allowed");
  if ([...decoded].some((ch) => ch.charCodeAt(0) < 0x20)) return refuse(400, "path_not_allowed");
  return { account, path: decoded };
}

function queryOf(url: URL): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of url.searchParams) {
    const prior = out[key];
    out[key] =
      prior === undefined ? value : Array.isArray(prior) ? [...prior, value] : [prior, value];
  }
  return out;
}

/** The HTTP response for a pipeline outcome. */
function respond(c: Context, result: PipelineResult): Response {
  switch (result.status) {
    case "allowed": {
      const upstream = result.result as HttpResponse;
      return new Response(Buffer.from(upstream.body, "base64"), {
        status: upstream.status,
        headers: { ...upstream.headers, "heel-decision": "allow" },
      });
    }
    case "pending":
      return c.json(
        {
          status: "pending",
          approvalId: result.approvalId,
          check: `/approvals/${result.approvalId}`,
        },
        202,
        { "heel-decision": "ask" },
      );
    case "denied":
      return c.json({ status: "denied", reason: result.reason, rule: result.rule }, 403, {
        "heel-decision": "deny",
      });
    case "paused":
      return c.json({ status: "paused", scope: result.scope }, 423, { "heel-decision": "paused" });
    case "expired":
      return c.json({ status: "expired", approvalId: result.approvalId }, 410);
    case "upstream_error":
      return c.json({ status: "upstream_error", upstreamStatus: result.upstreamStatus }, 502);
    case "upstream_outcome_unknown":
      return c.json({ status: "upstream_outcome_unknown" }, 502);
  }
}

export async function handleHttpProxy(
  c: Context,
  agent: AuthenticatedAgent,
  deps: HttpProxyDeps,
): Promise<Response> {
  const url = new URL(c.req.url);
  const target = proxiedPath(url.pathname);
  if ("status" in target) return c.json(target.body, target.status);
  if (c.req.header("x-forwarded-host") !== undefined || c.req.header("forwarded") !== undefined) {
    return c.json(refuse(400, "host_override").body, 400);
  }
  const account = findAccount(deps.db, agent.orgId, target.account);
  // Someone else's account, or one that isn't an HTTP account, reads as unknown.
  if (account === null || account.ownerId !== agent.ownerId || !isHttpProvider(account.provider)) {
    return c.json(refuse(404, "unknown_endpoint").body, 404);
  }
  const method = c.req.method.toUpperCase();
  if (!(HTTP_METHODS as readonly string[]).includes(method)) {
    return c.json(refuse(400, "method_not_allowed").body, 400);
  }
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return c.json(refuse(413, "body_too_large").body, 413);
  const bytes =
    method === "GET" || method === "HEAD" ? null : Buffer.from(await c.req.arrayBuffer());
  if (bytes !== null && bytes.length > MAX_BODY_BYTES) {
    return c.json(refuse(413, "body_too_large").body, 413);
  }
  const stripped = ["cookie", "proxy-authorization"].filter((h) => c.req.header(h) !== undefined);
  if (stripped.length > 0) {
    deps.log.info(
      { account: account.alias, headers: stripped },
      "stripped the agent's credential headers",
    );
  }
  const contentType = c.req.header("content-type");
  const args: HttpArgs = {
    method: method as HttpArgs["method"],
    path: target.path,
    query: queryOf(url),
    ...(contentType === undefined ? {} : { contentType }),
    ...(bytes === null || bytes.length === 0 ? {} : { body: bytes.toString("base64") }),
  };
  const result = await deps.pipeline.run({
    agent,
    surface: "http",
    account: account.alias,
    tool: `${method} ${target.path}`,
    args,
    runId: c.req.header("heel-run-id"),
  });
  return respond(c, result);
}
