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

export const RUN_CODE = "run_code";
export const HEEL_STUBS = "heel_stubs";

/** Code mode's one tool (spec: Code mode). */
export const RUN_CODE_TOOL: Tool = {
  name: RUN_CODE,
  description:
    "Run a Python script (Monty's subset) that calls your accounts as modules: `import gmail_work` then " +
    "`gmail_work.send(...)`. Every call is checked by heel on its own. A denial raises PermissionError " +
    "at the call. If a call needs approval or you're paused, the script stops there and the result says " +
    "so, with what already ran; send the rest as a new script once it's approved. A `busy` status means " +
    "heel already runs as many scripts as it allows at once, yours or all agents', so this one didn't " +
    "start; send it again once one has finished. See heel_stubs for " +
    "the functions and their arguments.",
  // heel_reason here covers every call the script makes: one sentence on what the script is for.
  inputSchema: {
    type: "object",
    properties: {
      code: { type: "string", description: "The script." },
      run_id: { type: "string", description: "Your run id, for per-run limits." },
      heel_reason: {
        type: "string",
        description:
          "Optional. One plain sentence on what this script is for. If a call in it needs approval, " +
          "heel shows it to the person deciding, next to what that call actually does. It never " +
          "changes whether a call runs.",
      },
    },
    required: ["code"],
    additionalProperties: false,
  },
};

export const HEEL_STUBS_TOOL: Tool = {
  name: HEEL_STUBS,
  description: "The .pyi stubs of the modules run_code can import: one per account.",
  inputSchema: {
    type: "object",
    properties: { account: { type: "string", description: "Only this account's module." } },
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
  return { ...rest, name, inputSchema: withReason(tool.inputSchema) };
}

/**
 * The optional argument every listed account tool gains: the agent's reason,
 * shown to the approver (spec: The approval page). The name is heel's own, so
 * it's taken out of the arguments before anything else sees them.
 */
export const REASON_ARG = "heel_reason";

/** Reasons longer than this are cut, so one argument can't fill the approval page. */
export const REASON_MAX_CHARS = 500;

const REASON_PROPERTY = {
  type: "string",
  description:
    "Optional. One plain sentence on why you're making this call. If the call needs approval, " +
    "heel shows it to the person deciding, next to what the call actually does. It never " +
    "changes whether the call runs.",
} as const;

/** Pure: an input schema with `heel_reason` added to its properties. */
export function withReason(schema: Tool["inputSchema"]): Tool["inputSchema"] {
  return { ...schema, properties: { ...(schema.properties ?? {}), [REASON_ARG]: REASON_PROPERTY } };
}

/**
 * Pure: a call's arguments without `heel_reason`, and the reason itself when
 * it's a non-blank string (trimmed and capped). Anything else under that name
 * is dropped, never forwarded.
 */
export function takeReason(args: Record<string, unknown>): {
  args: Record<string, unknown>;
  reason: string | undefined;
} {
  if (!Object.hasOwn(args, REASON_ARG)) return { args, reason: undefined };
  const { [REASON_ARG]: raw, ...rest } = args;
  return { args: rest, reason: cleanReason(raw) };
}

/**
 * Pure: an agent's reason as heel shows it, from any surface (MCP's
 * `heel_reason`, the HTTP proxy's `Heel-Reason` header, `heel run --reason`):
 * trimmed and capped, or undefined when blank or not text.
 */
export function cleanReason(raw: unknown): string | undefined {
  const text = typeof raw === "string" ? raw.trim() : "";
  return text === "" ? undefined : text.slice(0, REASON_MAX_CHARS);
}
