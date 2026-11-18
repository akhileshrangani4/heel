import { isAbsolute, normalize } from "node:path";
import type { Context } from "hono";
import { z } from "zod";
import type { CliResult } from "../definitions/cli/definition.ts";
import type { HeelDb } from "../store/db.ts";
import { accountsOwnedBy } from "../store/directory.ts";
import { isCliProvider } from "../vault/connect.ts";
import type { AuthenticatedAgent } from "./agent-tokens.ts";
import type { Pipeline } from "./pipeline/pipeline.ts";
import type { PipelineResult } from "./pipeline/ports.ts";

/**
 * The CLI runner's endpoint (D8b; spec: CLI runner): `heel run` posts the
 * command line, the directory it runs in, and optionally the account. Without
 * an account, heel picks the agent owner's one CLI account for that command,
 * and refuses when there are none or several.
 *
 * Answers are JSON with the same statuses as the HTTP proxy: 200 with the
 * program's exit code and output for an allow, 202 for an ask, 403 for a
 * deny, 423 for a pause, 410 for an expired approval.
 */

export const RunRequestSchema = z.strictObject({
  argv: z.array(z.string().max(65_536)).min(1).max(4_096),
  cwd: z.string().max(4_096),
  runId: z.string().max(256).optional(),
  account: z.string().max(128).optional(),
});

export interface RunRouteDeps {
  db: HeelDb;
  pipeline: Pipeline;
}

const deny = (c: Context, reason: string, status: 400 | 404 | 409 = 400) =>
  c.json({ status: "denied", reason, rule: null }, status);

function respond(c: Context, result: PipelineResult): Response {
  switch (result.status) {
    case "allowed": {
      const ran = result.result as CliResult;
      // A limit or an abort stopped the program: the spec's exit 70, with what it printed.
      if (ran.stopped !== undefined) return c.json({ status: "error", ...ran }, 200);
      return c.json({ status: "ran", ...ran }, 200);
    }
    case "pending":
      return c.json(
        {
          status: "pending",
          approvalId: result.approvalId,
          check: `/approvals/${result.approvalId}`,
        },
        202,
      );
    case "denied":
      return c.json({ status: "denied", reason: result.reason, rule: result.rule }, 403);
    case "paused":
      return c.json({ status: "paused", scope: result.scope }, 423);
    case "expired":
      return c.json({ status: "expired", approvalId: result.approvalId }, 410);
    case "upstream_error":
      return c.json({ status: "error", upstreamStatus: result.upstreamStatus }, 502);
    case "upstream_outcome_unknown":
      return c.json({ status: "outcome_unknown" }, 502);
  }
}

export async function handleRun(
  c: Context,
  agent: AuthenticatedAgent,
  deps: RunRouteDeps,
): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return deny(c, "invalid_request");
  }
  const parsed = RunRequestSchema.safeParse(body);
  if (!parsed.success) return deny(c, "invalid_request");
  const { argv, cwd, runId } = parsed.data;
  if (!isAbsolute(cwd) || normalize(cwd) !== cwd.replace(/(.)\/$/, "$1")) {
    return deny(c, "invalid_request");
  }
  const command = argv[0] as string;
  const candidates = accountsOwnedBy(deps.db, agent.orgId, agent.ownerId).filter(
    (account) =>
      isCliProvider(account.provider) &&
      (parsed.data.account === undefined
        ? account.provider === `cli:${command}`
        : account.alias === parsed.data.account),
  );
  if (candidates.length === 0) return deny(c, "unknown_endpoint", 404);
  if (candidates.length > 1) return deny(c, "account_ambiguous", 409);
  const account = candidates[0] as (typeof candidates)[number];
  const result = await deps.pipeline.run({
    agent,
    surface: "cli",
    account: account.alias,
    tool: command,
    args: { argv, cwd },
    ...(runId === undefined ? {} : { runId }),
  });
  return respond(c, result);
}
