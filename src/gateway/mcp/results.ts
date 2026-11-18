import type { CallToolResult } from "@modelcontextprotocol/server";
import type { RuleRef } from "../../core/call.ts";
import type { PipelineResult } from "../pipeline/ports.ts";

/**
 * What an agent gets back from a tool call (spec: Result shapes). Pure.
 *
 * An allowed call returns the upstream's own result. Every other outcome is
 * an `isError: true` tool result, so the model reads it and can correct
 * itself, carrying the same object twice: as `structuredContent` and as a
 * JSON text block for clients that only read text. JSON-RPC errors are kept
 * for protocol faults, such as an unknown tool.
 */

/** The decision object an agent reads when its call didn't simply run. */
export type Decision =
  | { status: "pending"; approvalId: string; check: "heel_status"; message: string }
  | {
      status: "denied";
      reason: string;
      rule: RuleRef | null;
      message: string;
      approvalId?: string;
    }
  | { status: "paused"; scope: string; message: string }
  | { status: "expired"; approvalId: string; message: string }
  | { status: "upstream_error"; upstreamStatus: number; body: unknown; message: string }
  | { status: "upstream_outcome_unknown"; message: string };

/** The account and tool the agent called, for the messages. */
export interface CallLabel {
  account: string;
  tool: string;
}

export function decisionFor(
  result: Exclude<PipelineResult, { status: "allowed" }>,
  call: CallLabel,
): Decision {
  const what = `${call.tool} on ${call.account}`;
  switch (result.status) {
    case "pending":
      return {
        status: "pending",
        approvalId: result.approvalId,
        check: "heel_status",
        message: `Approval needed: ${what}. Check with heel_status, then re-send the same call once it's approved.`,
      };
    case "denied":
      return {
        status: "denied",
        reason: result.reason,
        rule: result.rule,
        message: `heel denied ${what} (${result.reason.replaceAll("_", " ")}).`,
        ...(result.approvalId === undefined ? {} : { approvalId: result.approvalId }),
      };
    case "paused":
      return { status: "paused", scope: result.scope, message: `${what} is paused. Nothing ran.` };
    case "expired":
      return {
        status: "expired",
        approvalId: result.approvalId,
        message: `The approval for ${what} expired. Send the call again to ask again.`,
      };
    case "upstream_error":
      return {
        status: "upstream_error",
        upstreamStatus: result.upstreamStatus,
        body: result.body,
        message: `${call.account} answered ${what} with an error.`,
      };
    case "upstream_outcome_unknown":
      return {
        status: "upstream_outcome_unknown",
        message: `heel doesn't know whether ${what} took effect, and won't retry it.`,
      };
  }
}

/** The tool result for a decision: an error result carrying it twice. */
export function decisionResult(decision: Decision): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(decision) }],
    structuredContent: decision,
  };
}

/** The tool result for any pipeline outcome. */
export function toolResult(result: PipelineResult, call: CallLabel): CallToolResult {
  if (result.status === "allowed") return result.result as CallToolResult;
  return decisionResult(decisionFor(result, call));
}
