import type { Call } from "./call.ts";
import { canonicalHash } from "./canonical.ts";

/**
 * What makes two calls "the same call" for approvals (spec: Call model,
 * "Canonical call hash"; I-51, I-52).
 *
 * - The agent is in: approving is approving an agent as well as an action,
 *   so another agent's identical call is a separate request.
 * - The run id is out: a new run asking for the same send joins the pending
 *   request instead of creating a duplicate.
 * - `args` are the post-rewrite arguments (e.g. a pinned head SHA), exactly
 *   what will run. For the CLI they are `{argv, cwd}`.
 */
export type CallIdentity = Pick<Call, "agentId" | "account" | "tool" | "args">;

/** Pure: absent arguments are none (`{}`); anything else, `null` included, is kept. */
export function argsOrNone(args: unknown): unknown {
  return args === undefined ? {} : args;
}

/**
 * Pure: `sha256(JCS({agentId, account, tool, args}))`, lower-case hex.
 * MCP treats absent `arguments` as none, so absent args hash as `{}`, the
 * same as the audit row records them. Only absent: an explicit `null` is a
 * different call and hashes as `null`. Throws on arguments JSON can't carry
 * exactly (NaN, bigint, class instances); the pipeline denies such a call.
 */
export function callHash(call: CallIdentity): string {
  return canonicalHash({
    agentId: call.agentId,
    account: call.account,
    tool: call.tool,
    args: argsOrNone(call.args),
  });
}

/**
 * What an audit row records as a call's arguments when they have no
 * canonical JSON form (a non-finite number, a bigint, a lone surrogate),
 * so the row can't record them exactly.
 */
export const UNREPRESENTABLE_ARGS: Readonly<Record<string, true>> = Object.freeze({
  "heel/unrepresentable": true,
});

/**
 * The hash that audit row carries. It hashes a JSON string, and every real
 * call hash hashes an object, so it equals no call's hash. Such a call is
 * always denied, so this hash never keys an approval.
 */
export const UNREPRESENTABLE_CALL_HASH = canonicalHash("heel/unrepresentable-call");
