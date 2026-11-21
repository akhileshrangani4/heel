import type { Context } from "hono";
import type { HttpArgs, HttpResponse } from "../definitions/http/definition.ts";
import { HTTP_METHODS } from "../definitions/http/openapi.ts";
import { type RestCall, type RestRequest, restMapFor } from "../definitions/http/rest.ts";
import type { Logger } from "../log.ts";
import type { HeelDb } from "../store/db.ts";
import { findAccount } from "../store/directory.ts";
import { mayUseAccount } from "../store/sharing.ts";
import { isHttpProvider } from "../vault/connect.ts";
import type { AuthenticatedAgent } from "./agent-tokens.ts";
import { cleanReason } from "./mcp/names.ts";
import type { Pipeline } from "./pipeline/pipeline.ts";
import type { PipelineResult } from "./pipeline/ports.ts";

/**
 * The HTTP proxy surface (D7a; spec: HTTP proxy):
 * `<METHOD> /http/<account>/<path>?<query>` with the agent's heel token.
 *
 * - The target can't change, and the path rules see is the path sent. The
 *   path is decoded once and must then be canonical: no encoded slash or
 *   backslash, no `%` left (a double-encoded `..` would decode again
 *   upstream), no `.` or `..` segment, no empty segment or trailing slash, no
 *   control character. A forwarded-host header is refused too. Each is a 400
 *   before anything else. The definition re-encodes each segment itself.
 * - Request bodies are capped at 25 MB while they are read.
 * - TRACE is refused.
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
  let account: string;
  try {
    account = decodeURIComponent(match[1] ?? "");
  } catch {
    return refuse(404, "unknown_endpoint");
  }
  const raw = match[2] ?? "/";
  if (/%2f|%5c|\\/i.test(raw)) return refuse(400, "path_not_allowed");
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return refuse(400, "path_not_allowed");
  }
  if (decoded === "/") return { account, path: decoded };
  // Anything an upstream would decode or normalize again: what rules see must be what is sent.
  if (decoded.includes("%")) return refuse(400, "path_not_allowed");
  const segments = decoded.split("/").slice(1);
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    return refuse(400, "path_not_allowed");
  }
  if ([...decoded].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) {
    return refuse(400, "path_not_allowed");
  }
  return { account, path: decoded };
}

/** Reads a body, stopping as soon as it passes the cap. Null when it does. */
async function readCapped(body: ReadableStream<Uint8Array> | null): Promise<Buffer | null> {
  if (body === null) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** Statuses whose response can't carry a body. */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

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
      return new Response(
        NULL_BODY.has(upstream.status) ? null : Buffer.from(upstream.body, "base64"),
        {
          status: upstream.status,
          // heel's own answers from the hide step (a hidden item) carry their own decision.
          headers: { "heel-decision": "allow", ...upstream.headers },
        },
      );
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
      // An internal failure is the spec's 503 "heel error", not a rule's 403.
      if (result.reason === "internal") {
        return c.json({ status: "denied", reason: "heel error" }, 503, { "heel-decision": "deny" });
      }
      return c.json({ status: "denied", reason: result.reason, rule: result.rule }, 403, {
        "heel-decision": "deny",
      });
    case "paused":
      return c.json({ status: "paused", scope: result.scope }, 423, { "heel-decision": "paused" });
    case "expired":
      return c.json({ status: "expired", approvalId: result.approvalId }, 410);
    case "upstream_error":
      return c.json(
        {
          status: "upstream_error",
          upstreamStatus: result.upstreamStatus,
          ...(result.message === undefined ? {} : { message: result.message }),
        },
        502,
      );
    case "upstream_outcome_unknown":
      return c.json({ status: "upstream_outcome_unknown" }, 502);
  }
}

/**
 * The agent's reason from its `Heel-Reason` header, shown to the approver.
 * heel never sends the agent's request headers upstream (only the body's
 * content type), so it can't reach the API.
 */
function reasonOf(c: Context): { reason?: string } {
  const reason = cleanReason(c.req.header("heel-reason"));
  return reason === undefined ? {} : { reason };
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
  const restMap = account === null ? undefined : restMapFor(account.provider);
  // Someone else's account, or one with no REST surface, reads as unknown.
  if (
    account === null ||
    !mayUseAccount(deps.db, account, agent.ownerId) ||
    (!isHttpProvider(account.provider) && restMap === undefined)
  ) {
    return c.json(refuse(404, "unknown_endpoint").body, 404);
  }
  const method = c.req.method.toUpperCase();
  if (!(HTTP_METHODS as readonly string[]).includes(method) || method === "TRACE") {
    return c.json(refuse(400, "method_not_allowed").body, 400);
  }
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return c.json(refuse(413, "body_too_large").body, 413);
  let bytes: Buffer | null = null;
  if (method !== "GET" && method !== "HEAD") {
    bytes = await readCapped(c.req.raw.body);
    if (bytes === null) return c.json(refuse(413, "body_too_large").body, 413);
  }
  const stripped = ["cookie", "proxy-authorization"].filter((h) => c.req.header(h) !== undefined);
  if (stripped.length > 0) {
    deps.log.info(
      { account: account.alias, headers: stripped },
      "stripped the agent's credential headers",
    );
  }
  if (restMap !== undefined) {
    return builtInRest(c, agent, deps, account.alias, restMap, {
      method,
      path: target.path,
      query: queryOf(url),
      contentType: c.req.header("content-type"),
      bytes,
    });
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
    ...reasonOf(c),
  });
  return respond(c, result);
}

/**
 * A built-in provider's REST path (D7b): mapped to heel's native tool, run
 * through the pipeline as that tool, answered with the tool's result as JSON.
 * A path heel has no mapping for, or a body that isn't the JSON it expects,
 * is refused as unsupported.
 */
async function builtInRest(
  c: Context,
  agent: AuthenticatedAgent,
  deps: HttpProxyDeps,
  alias: string,
  map: (request: RestRequest) => RestCall | null,
  request: {
    method: string;
    path: string;
    query: Record<string, string | string[]>;
    contentType: string | undefined;
    bytes: Buffer | null;
  },
): Promise<Response> {
  let json: unknown;
  if (request.bytes !== null && request.bytes.length > 0) {
    const type = (request.contentType ?? "").split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") return c.json(refuse(400, "unsupported").body, 400);
    try {
      json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request.bytes));
    } catch {
      return c.json(refuse(400, "unsupported").body, 400);
    }
  }
  const mapped = map({ method: request.method, path: request.path, query: request.query, json });
  if (mapped === null) {
    return c.json({ status: "denied", reason: "unsupported", rule: null }, 403, {
      "heel-decision": "deny",
    });
  }
  const result = await deps.pipeline.run({
    agent,
    surface: "http",
    account: alias,
    tool: mapped.tool,
    args: mapped.args,
    runId: c.req.header("heel-run-id"),
    ...reasonOf(c),
  });
  if (result.status === "allowed") {
    return c.json(result.result as object, 200, { "heel-decision": "allow" });
  }
  return respond(c, result);
}
