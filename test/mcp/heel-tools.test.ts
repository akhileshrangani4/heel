import { describe, expect, it } from "vitest";
import { MontyWorker } from "../../src/codemode/monty.ts";
import { LEARNING_WINDOW_DAYS } from "../../src/core/learning.ts";
import { revokeAgent } from "../../src/gateway/agents.ts";
import {
  HEEL_ACCOUNTS_TOOL,
  HEEL_HISTORY_TOOL,
  HEEL_PROPOSE_RULES_TOOL,
  HEEL_REQUEST_CONNECTION_TOOL,
  HEEL_STATUS_TOOL,
} from "../../src/gateway/mcp/names.ts";
import { mcpHarness } from "../helpers/mcp.ts";

/**
 * heel's own tools on every MCP scope: how they're listed, and that heel
 * answers them, never an account tool of the same name.
 */

// The upstream lists an impostor heel_status; this rule would let a call to it run.
const RULES = `rules:
  - match: { tool: heel_status }
    then: allow
`;

const HEEL_OWN = [
  HEEL_STATUS_TOOL,
  HEEL_ACCOUNTS_TOOL,
  HEEL_HISTORY_TOOL,
  HEEL_PROPOSE_RULES_TOOL,
  HEEL_REQUEST_CONNECTION_TOOL,
];

const SCOPES = ["/mcp/notes", "/mcp?tools=direct", "/mcp"];

const harness = () => mcpHarness({ owner: RULES, codeWorker: () => new MontyWorker() });

describe("heel's own tools", () => {
  it.each(SCOPES)("are listed last on %s, exactly as heel defines them", async (path) => {
    const h = await harness();
    const { tools } = await (await h.connect(path)).listTools();
    // No heel_reason added, and heel_history keeps its output schema.
    expect(tools.slice(-HEEL_OWN.length)).toEqual(HEEL_OWN);
  });

  it.each(SCOPES)("are answered by heel on %s, and nothing reaches the upstream", async (path) => {
    const h = await harness();
    const client = await h.connect(path);
    const call = (name: string) => client.callTool({ name, arguments: {} });

    expect(await call("heel_status")).toMatchObject({
      isError: true,
      structuredContent: { approvalId: "", status: "unknown" },
    });
    expect((await call("heel_accounts")).structuredContent).toEqual({
      accounts: [{ alias: "notes", service: "mcp", status: "active" }],
      waiting: { connections: [], ruleProposals: [] },
    });
    expect(await call("heel_history")).toMatchObject({
      structuredContent: { window_days: LEARNING_WINDOW_DAYS, decisions: [], suggestions: [] },
    });
    expect(await call("heel_propose_rules")).toMatchObject({
      isError: true,
      structuredContent: { status: "invalid" },
    });
    expect(await call("heel_request_connection")).toMatchObject({
      isError: true,
      structuredContent: { status: "invalid" },
    });
    expect(h.upstream.calls).toEqual([]);
  });

  it("heel_status answers unknown, as an error, for an approval or a script it doesn't know", async () => {
    const h = await harness();
    const client = await h.connect("/mcp");

    const approval = await client.callTool({
      name: "heel_status",
      arguments: { approval_id: "apr_nope" },
    });
    expect(approval).toMatchObject({
      isError: true,
      structuredContent: { approvalId: "apr_nope", status: "unknown" },
    });
    // This heel has no background scripts at all.
    const script = await client.callTool({
      name: "heel_status",
      arguments: { script_id: "scr_nope" },
    });
    expect(script).toMatchObject({
      isError: true,
      structuredContent: { scriptId: "scr_nope", status: "unknown" },
    });
  });

  it.each(["nope", "constructor", "__proto__"])(
    "answers %s on code mode's /mcp with a protocol error",
    async (name) => {
      const h = await harness();
      const client = await h.connect("/mcp");
      await expect(client.callTool({ name, arguments: {} })).rejects.toThrow(
        `Unknown tool: ${name}`,
      );
    },
  );

  it("heel_accounts with wait answers a protocol error when its agent is revoked while it waits", async () => {
    const h = await mcpHarness({
      owner: RULES,
      approvalWait: { windowMs: () => 500, pollMs: 10, beatMs: 30 },
    });
    const client = await h.connect("/mcp/notes");
    await client.callTool({
      name: "heel_request_connection",
      arguments: { service: "github", alias: "gh", why: "issues" },
    });
    const waiting = client.callTool({ name: "heel_accounts", arguments: { wait: true } });
    // Revoked once the call is held, not before heel takes it.
    await new Promise((resolve) => setTimeout(resolve, 150));
    revokeAgent(h.t.db, h.t.orgId, "inbox-bot", new Date());
    await expect(waiting).rejects.toThrow(/no longer active/);
  });
});
