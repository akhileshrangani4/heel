import { describe, expect, it } from "vitest";
import { decideApproval, SqliteApprovalStore } from "../../src/store/approvals.ts";
import { pause, SqlitePauseStore } from "../../src/store/pauses.ts";
import { approvals, auditLog } from "../../src/store/schema.ts";
import { mcpHarness } from "../helpers/mcp.ts";

/**
 * The MCP agent plane (D5a), end to end with a real MCP client: what an
 * agent sees listed, and what happens to its calls.
 */

const READS_ALLOWED = `rules:
  - match: { tool: search_notes }
    then: allow
  - match: { tool: echo_auth }
    then: allow
  - match: { tool: delete_note }
    then: ask
`;

/** The structured decision on a non-allowed result. */
function decisionOf(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
}

describe("listing tools", () => {
  it("lists one account's tools under their own names, without output schemas, plus heel_status", async () => {
    const h = await mcpHarness({ owner: READS_ALLOWED });
    const client = await h.connect("/mcp/notes");

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      "search_notes",
      "delete_note",
      "echo_auth",
      "heel_status",
    ]);
    expect(tools.find((tool) => tool.name === "search_notes")).not.toHaveProperty("outputSchema");
    // The upstream's own heel_status is dropped; the one listed is heel's.
    expect(tools.find((tool) => tool.name === "heel_status")?.description).toMatch(
      /approval request/,
    );
  });

  it("lists every account's tools prefixed on /mcp?tools=direct", async () => {
    const h = await mcpHarness({ owner: READS_ALLOWED });
    const client = await h.connect("/mcp?tools=direct");

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      "notes__search_notes",
      "notes__delete_note",
      "notes__echo_auth",
      "heel_status",
    ]);
  });

  it("I-74: two accounts on the same kind of server are separate namespaces, and a call names one", async () => {
    const h = await mcpHarness({ owner: READS_ALLOWED, moreAccounts: ["archive"] });

    const direct = await (await h.connect("/mcp?tools=direct")).listTools();
    expect(direct.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["notes__search_notes", "archive__search_notes"]),
    );
    const onlyNotes = await (await h.connect("/mcp/notes")).listTools();
    expect(onlyNotes.tools.map((tool) => tool.name)).not.toContain("archive__search_notes");

    const client = await h.connect("/mcp?tools=direct");
    await client.callTool({ name: "archive__search_notes", arguments: {} });
    expect(h.t.db.select().from(auditLog).all()).toMatchObject([{ account: "archive" }]);
  });

  it("keeps bare /mcp for code mode, which needs the sandbox", async () => {
    const h = await mcpHarness({ owner: READS_ALLOWED });
    const response = await h.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ message: expect.stringMatching(/tools=direct/) });
  });

  it("I-03: refuses a missing or unknown heel token before anything else", async () => {
    const h = await mcpHarness({ owner: READS_ALLOWED });
    await expect(h.connect("/mcp/notes", { token: "not-a-heel-token" })).rejects.toThrow();
    expect((await h.request("/mcp/notes", { method: "POST" })).status).toBe(401);
    expect(h.upstream.calls).toEqual([]);
  });

  it("reads another owner's account, or one that doesn't exist, as unknown", async () => {
    const h = await mcpHarness({ owner: READS_ALLOWED });
    const response = await h.request("/mcp/someone-elses", {
      method: "POST",
      headers: { authorization: `Bearer ${h.token}` },
    });
    expect(response.status).toBe(404);
  });
});

describe("calling tools", () => {
  it("runs an allowed call upstream and returns its result", async () => {
    const h = await mcpHarness({ owner: READS_ALLOWED });
    const client = await h.connect("/mcp/notes");

    const result = await client.callTool({ name: "search_notes", arguments: { query: "q3" } });

    expect(result).toMatchObject({ content: [{ type: "text", text: "ran search_notes" }] });
    expect(result.isError).toBeFalsy();
    expect(h.upstream.calls).toEqual([{ name: "search_notes", arguments: { query: "q3" } }]);
  });

  it("I-10: denies a call no rule matches, as a tool error the model can read; nothing runs", async () => {
    const h = await mcpHarness({ owner: "rules: []\n" });
    const client = await h.connect("/mcp?tools=direct");

    const result = await client.callTool({ name: "notes__search_notes", arguments: {} });

    expect(result.isError).toBe(true);
    expect(decisionOf(result)).toMatchObject({
      status: "denied",
      reason: "no_rule_matched",
      rule: null,
    });
    expect(JSON.parse((result.content as { text: string }[])[0]?.text ?? "")).toEqual(
      decisionOf(result),
    );
    expect(h.upstream.calls).toEqual([]);
  });

  it("I-20: a passthrough tool is never kind: read, so a read rule doesn't allow it", async () => {
    const h = await mcpHarness({ owner: "rules:\n  - match: { kind: read }\n    then: allow\n" });
    const client = await h.connect("/mcp/notes");

    const result = await client.callTool({ name: "search_notes", arguments: {} });

    expect(decisionOf(result)).toMatchObject({ status: "denied", reason: "no_rule_matched" });
    expect(h.upstream.calls).toEqual([]);
  });

  it("denies a tool the upstream doesn't list now, even one a rule names", async () => {
    const h = await mcpHarness({
      owner: "rules:\n  - match: { tool: drop_all }\n    then: allow\n",
    });
    const client = await h.connect("/mcp/notes");

    const result = await client.callTool({ name: "drop_all", arguments: {} });

    expect(decisionOf(result)).toMatchObject({ status: "denied", reason: "unsupported" });
    expect(h.upstream.calls).toEqual([]);
  });

  it("I-50, I-53: an ask returns pending at once; heel_status reads it; the identical re-send runs once approved", async () => {
    const h = await mcpHarness({ owner: READS_ALLOWED });
    const client = await h.connect("/mcp/notes");

    const first = await client.callTool({ name: "delete_note", arguments: { id: "n1" } });
    const pending = decisionOf(first);
    expect(pending).toMatchObject({ status: "pending", check: "heel_status" });
    expect(h.notified).toEqual([pending["approvalId"]]);
    expect(h.upstream.calls).toEqual([]);

    const status = await client.callTool({
      name: "heel_status",
      arguments: { approval_id: pending["approvalId"] },
    });
    expect(status.structuredContent).toEqual({
      approvalId: pending["approvalId"],
      status: "pending",
    });

    const row = h.t.db.select().from(approvals).get();
    if (row === undefined) throw new Error("no approval row");
    decideApproval(h.t.db, new SqliteApprovalStore(), new SqlitePauseStore(), {
      approver: { orgId: h.t.orgId, userId: h.t.ownerId, role: "admin" },
      approvalId: row.id,
      callHash: row.callHash,
      intent: "approve",
      standing: null,
      now: new Date(),
    });

    const rerun = await client.callTool({ name: "delete_note", arguments: { id: "n1" } });
    expect(rerun.isError).toBeFalsy();
    expect(h.upstream.calls).toEqual([{ name: "delete_note", arguments: { id: "n1" } }]);
  });

  it("I-60: a paused agent gets paused, and nothing reaches the upstream", async () => {
    const h = await mcpHarness({ owner: READS_ALLOWED });
    pause(h.t.db, h.t.orgId, { scope: "global", target: "" }, h.t.ownerId, new Date());
    const client = await h.connect("/mcp/notes");

    const result = await client.callTool({ name: "search_notes", arguments: {} });

    expect(decisionOf(result)).toMatchObject({ status: "paused", scope: "global" });
    expect(h.upstream.calls).toEqual([]);
  });

  it("I-02: sends the account's credential upstream as a bearer, and never returns it to the agent", async () => {
    const h = await mcpHarness({ owner: READS_ALLOWED, upstreamToken: "upstream-test-token" });
    const client = await h.connect("/mcp/notes");

    const result = await client.callTool({ name: "echo_auth", arguments: {} });

    // The upstream received it…
    expect(h.upstream.calls).toHaveLength(1);
    // …but the agent only sees it redacted.
    expect(JSON.stringify(result)).not.toContain("upstream-test-token");
    expect(result).toMatchObject({
      content: [{ text: "auth: Bearer [redacted by heel]" }],
    });
  });

  it("carries the run id from _meta['heel/runId']", async () => {
    const h = await mcpHarness({ owner: READS_ALLOWED });
    const client = await h.connect("/mcp/notes");

    await client.callTool({
      name: "search_notes",
      arguments: {},
      _meta: { "heel/runId": "run-42" },
    });

    expect(h.t.db.select().from(auditLog).all()).toMatchObject([
      { kind: "allow", runId: "run-42" },
    ]);
  });

  it("offers heel_reason on every account tool, but not on heel_status", async () => {
    const h = await mcpHarness({ owner: READS_ALLOWED });
    const client = await h.connect("/mcp/notes");

    const { tools } = await client.listTools();

    for (const tool of tools.filter((t) => t.name !== "heel_status")) {
      expect(tool.inputSchema.properties).toHaveProperty("heel_reason");
      expect(tool.inputSchema.required ?? []).not.toContain("heel_reason");
    }
    expect(tools.find((t) => t.name === "heel_status")?.inputSchema.properties).not.toHaveProperty(
      "heel_reason",
    );
  });

  it("takes heel_reason out of the arguments: the upstream and the audit never see it", async () => {
    const h = await mcpHarness({ owner: READS_ALLOWED });
    const client = await h.connect("/mcp/notes");

    await client.callTool({
      name: "search_notes",
      arguments: { query: "q3", heel_reason: "Finding the Q3 notes you asked for" },
    });

    expect(h.upstream.calls).toEqual([{ name: "search_notes", arguments: { query: "q3" } }]);
    expect(JSON.stringify(h.t.db.select().from(auditLog).all())).not.toContain("Q3 notes");
  });

  it("stores the first reason on the request; a re-send with new words joins it and runs once approved", async () => {
    const h = await mcpHarness({ owner: READS_ALLOWED });
    const client = await h.connect("/mcp/notes");

    const first = await client.callTool({
      name: "delete_note",
      arguments: { id: "n1", heel_reason: "  Removing the duplicate note  " },
    });
    const again = await client.callTool({
      name: "delete_note",
      arguments: { id: "n1", heel_reason: "Cleaning up, as you asked" },
    });
    expect(decisionOf(again)["approvalId"]).toBe(decisionOf(first)["approvalId"]);
    expect(h.notified).toHaveLength(1);

    const rows = h.t.db.select().from(approvals).all();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) throw new Error("no approval row");
    expect(row.reason).toBe("Removing the duplicate note");
    expect(JSON.stringify(row.call)).not.toContain("heel_reason");

    decideApproval(h.t.db, new SqliteApprovalStore(), new SqlitePauseStore(), {
      approver: { orgId: h.t.orgId, userId: h.t.ownerId, role: "admin" },
      approvalId: row.id,
      callHash: row.callHash,
      intent: "approve",
      standing: null,
      now: new Date(),
    });
    const rerun = await client.callTool({
      name: "delete_note",
      arguments: { id: "n1", heel_reason: "Yet another wording" },
    });
    expect(rerun.isError).toBeFalsy();
    expect(h.upstream.calls).toEqual([{ name: "delete_note", arguments: { id: "n1" } }]);
  });

  it("answers an unknown direct tool name with a protocol error", async () => {
    const h = await mcpHarness({ owner: READS_ALLOWED });
    const client = await h.connect("/mcp?tools=direct");

    await expect(client.callTool({ name: "no-separator", arguments: {} })).rejects.toThrow(
      /Unknown tool/,
    );
  });
});
