import type { Tool } from "@modelcontextprotocol/server";

/**
 * Tool names on heel's MCP endpoints (spec: Endpoints and tools). Pure.
 *
 * - `/mcp/<account>` lists one account's tools under their own names.
 * - `/mcp?tools=direct` lists every account's tools as `<account>__<tool>`.
 *   Aliases can't contain `_` (they become Python module names), so the first
 *   `__` always ends the alias, even when the tool name has `__` in it.
 * - Both list `heel_status`, which is heel's own and can't be shadowed.
 */

export const HEEL_STATUS = "heel_status";

export const HEEL_STATUS_TOOL: Tool = {
  name: HEEL_STATUS,
  description:
    "Where an approval request stands: pending, approved, denied, expired or executed. " +
    "Read-only: it never runs the call. Once approved, send the identical call again to run it.",
  inputSchema: {
    type: "object",
    properties: {
      approval_id: { type: "string", description: "The approvalId a pending result gave." },
    },
    required: ["approval_id"],
    additionalProperties: false,
  },
};

const SEPARATOR = "__";

export function directName(alias: string, tool: string): string {
  return `${alias}${SEPARATOR}${tool}`;
}

/** The account and tool a direct name points at; null when it has no `__`. */
export function splitDirectName(name: string): { alias: string; tool: string } | null {
  const at = name.indexOf(SEPARATOR);
  if (at <= 0) return null;
  return { alias: name.slice(0, at), tool: name.slice(at + SEPARATOR.length) };
}

/**
 * An upstream tool as heel lists it. `outputSchema` is dropped: a denied or
 * pending result isn't shaped like the tool's output, and a client that
 * validated against the schema would reject it (spec: MCP §1.3).
 */
export function listedTool(tool: Tool, name: string): Tool {
  const { outputSchema: _dropped, ...rest } = tool;
  return { ...rest, name };
}
