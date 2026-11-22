import { describe, expect, it } from "vitest";
import { decideApproval, SqliteApprovalStore } from "../../src/store/approvals.ts";
import { pause, SqlitePauseStore } from "../../src/store/pauses.ts";
import {
  accounts,
  agentRequests,
  approvals,
  auditLog,
  ruleProposals,
} from "../../src/store/schema.ts";
import { mcpHarness } from "../helpers/mcp.ts";

/** A rule object as an agent sends it; `then` is the rules file's own key. */
const ruleOf = (fields: Record<string, unknown>, decision: string) =>
  // biome-ignore lint/suspicious/noThenProperty: `then` is the rules file's key.
  Object.fromEntries([...Object.entries(fields), ["then", decision]]);

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
      "heel_accounts",
      "heel_history",
      "heel_propose_rules",
      "heel_request_connection",
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
      "heel_accounts",
      "heel_history",
      "heel_propose_rules",
      "heel_request_connection",
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

    for (const tool of tools.filter((t) => !t.name.startsWith("heel_"))) {
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

  it("records the client the agent connected with on its request", async () => {
    const h = await mcpHarness({ owner: READS_ALLOWED });
    const client = await h.connect("/mcp/notes");

    await client.callTool({ name: "delete_note", arguments: { id: "n1" } });

    expect(h.t.db.select().from(approvals).get()?.client).toBe("test-agent");
  });

  it("answers an unknown direct tool name with a protocol error", async () => {
    const h = await mcpHarness({ owner: READS_ALLOWED });
    const client = await h.connect("/mcp?tools=direct");

    await expect(client.callTool({ name: "no-separator", arguments: {} })).rejects.toThrow(
      /Unknown tool/,
    );
  });
});

describe("heel_propose_rules", () => {
  const proposal = {
    rules: [
      {
        rule: ruleOf({ name: "delete-notes", match: { tool: "delete_note" } }, "allow"),
        why: "so I can tidy duplicate notes",
      },
    ],
    reason: "Cleaning up the notes you asked about",
  };

  it("stores a proposal for the agent's owner and says nothing changes yet", async () => {
    const h = await mcpHarness({ owner: READS_ALLOWED });
    const client = await h.connect("/mcp/notes");
    const result = await client.callTool({ name: "heel_propose_rules", arguments: proposal });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ status: "proposed" });
    const [row] = h.t.db.select().from(ruleProposals).all();
    expect(row).toMatchObject({
      ownerId: h.t.ownerId,
      status: "pending",
      reason: "Cleaning up the notes you asked about",
    });
    expect(row?.rules[0]?.why).toBe("so I can tidy duplicate notes");
  });

  it("answers what's wrong with an invalid rule, and stores nothing", async () => {
    const h = await mcpHarness({ owner: READS_ALLOWED });
    const client = await h.connect("/mcp?tools=direct");
    const result = await client.callTool({
      name: "heel_propose_rules",
      arguments: { rules: [{ rule: ruleOf({ match: { tooll: "x" } }, "allow") }] },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain("tooll");
    expect(h.t.db.select().from(ruleProposals).all()).toEqual([]);
  });

  it("takes workdirs for the agent's own heel run, checking only the path's form", async () => {
    const h = await mcpHarness({ owner: READS_ALLOWED });
    const client = await h.connect("/mcp/notes");
    const { tools } = await client.listTools();
    const schema = tools.find((tool) => tool.name === "heel_propose_rules")?.inputSchema as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties)).toContain("workdirs");
    const result = await client.callTool({
      name: "heel_propose_rules",
      arguments: { workdirs: [{ path: "/home/me/code", why: "to run your tests" }] },
    });
    expect(result.structuredContent).toMatchObject({ status: "proposed" });
    const [row] = h.t.db.select().from(ruleProposals).all();
    expect(row?.workdirs).toEqual([{ path: "/home/me/code", why: "to run your tests" }]);
    const relative = await client.callTool({
      name: "heel_propose_rules",
      arguments: { workdirs: [{ path: "code" }] },
    });
    expect(relative.isError).toBe(true);
    expect(JSON.stringify(relative.structuredContent)).toContain("workdirs.0");
  });

  it("refuses while the agent is paused", async () => {
    const h = await mcpHarness({ owner: READS_ALLOWED });
    pause(h.t.db, h.t.orgId, { scope: "global", target: "" }, h.t.ownerId, new Date());
    const client = await h.connect("/mcp/notes");
    const result = await client.callTool({ name: "heel_propose_rules", arguments: proposal });
    expect(result.structuredContent).toMatchObject({ status: "paused" });
    expect(h.t.db.select().from(ruleProposals).all()).toEqual([]);
  });
});

describe("heel_request_connection", () => {
  const ask = { service: "gmail", alias: "gmail-work", why: "so I can triage your work mail" };
  const accountCount = (h: Awaited<ReturnType<typeof mcpHarness>>) =>
    h.t.db.select().from(accounts).all().length;

  it("stores a request for the agent's owner, and connects and contacts nothing", async () => {
    const h = await mcpHarness({ owner: READS_ALLOWED });
    const before = accountCount(h);
    const client = await h.connect("/mcp/notes");
    const result = await client.callTool({ name: "heel_request_connection", arguments: ask });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ status: "requested" });
    const [row] = h.t.db.select().from(agentRequests).all();
    expect(row).toMatchObject({
      ownerId: h.t.ownerId,
      kind: "connection",
      status: "pending",
      details: { provider: "gmail", alias: "gmail-work" },
      why: "so I can triage your work mail",
      accountId: null,
    });
    expect(accountCount(h)).toBe(before);
  });

  it("answers the same when the name is already taken, so it learns nothing about accounts", async () => {
    const h = await mcpHarness({ owner: READS_ALLOWED });
    const client = await h.connect("/mcp/notes");
    const taken = await client.callTool({
      name: "heel_request_connection",
      arguments: { ...ask, alias: "notes" },
    });
    expect(taken.structuredContent).toMatchObject({ status: "requested" });
  });

  it("asks only for sign-in services and https MCP servers", async () => {
    const h = await mcpHarness({ owner: READS_ALLOWED });
    const client = await h.connect("/mcp/notes");
    for (const args of [
      { service: "cli", alias: "x" },
      { service: "http", alias: "x" },
      { service: "github", alias: "x", url: "https://api.github.com" },
      { service: "mcp", alias: "x" },
      { service: "mcp", alias: "x", url: "http://127.0.0.1:7301/mcp" },
      { service: "mcp", alias: "x", url: "https://good.example@evil.example/mcp" },
      { service: "mcp", alias: "x", url: "https://127.0.0.1/mcp" },
      { service: "mcp", alias: "x", url: "https://[::1]/mcp" },
      { service: "mcp", alias: "x", url: "https://localhost/mcp" },
      { service: "mcp", alias: "x", url: "https://intranet/mcp" },
      { service: "mcp", alias: "x", url: "https://wiki.corp.internal/mcp" },
      { service: "gmail", alias: "x", url: "https://mcp.example.com" },
      { service: "gmail", alias: "Bad Name" },
      // A key request whose name points at another service: the owner might paste the wrong key.
      { service: "github", alias: "stripe-live" },
      { service: "mcp", alias: "x", url: "https://mcp.example.com", command: "/bin/sh" },
    ]) {
      const result = await client.callTool({ name: "heel_request_connection", arguments: args });
      expect(result.isError, JSON.stringify(args)).toBe(true);
    }
    expect(h.t.db.select().from(agentRequests).all()).toEqual([]);
  });

  it("lets an MCP server or a sign-in service carry another service's name", async () => {
    const h = await mcpHarness({ owner: READS_ALLOWED });
    const client = await h.connect("/mcp/notes");
    const mcp = await client.callTool({
      name: "heel_request_connection",
      arguments: { service: "mcp", alias: "github-mcp", url: "https://api.githubcopilot.com/mcp" },
    });
    expect(mcp.structuredContent).toMatchObject({ status: "requested" });
  });

  it("replaces a waiting request for the same name, and caps how many wait", async () => {
    const h = await mcpHarness({ owner: READS_ALLOWED });
    const client = await h.connect("/mcp/notes");
    await client.callTool({ name: "heel_request_connection", arguments: ask });
    await client.callTool({ name: "heel_request_connection", arguments: ask });
    const rows = h.t.db.select().from(agentRequests).all();
    expect(rows.map((r) => r.status).sort()).toEqual(["pending", "superseded"]);
    for (const n of [2, 3, 4, 5]) {
      await client.callTool({
        name: "heel_request_connection",
        arguments: { ...ask, alias: `gmail-${n}` },
      });
    }
    const sixth = await client.callTool({
      name: "heel_request_connection",
      arguments: { ...ask, alias: "gmail-6" },
    });
    expect(sixth.structuredContent).toMatchObject({ status: "refused" });
  });

  it("can't flood its owner by asking again and again", async () => {
    const h = await mcpHarness({ owner: READS_ALLOWED });
    const client = await h.connect("/mcp/notes");
    for (let i = 0; i < 10; i++) {
      const result = await client.callTool({ name: "heel_request_connection", arguments: ask });
      expect(result.structuredContent).toMatchObject({ status: "requested" });
    }
    const eleventh = await client.callTool({ name: "heel_request_connection", arguments: ask });
    expect(eleventh.structuredContent).toMatchObject({ status: "refused" });
  });

  it("keeps its why to plain text: no line breaks or direction controls", async () => {
    const h = await mcpHarness({ owner: READS_ALLOWED });
    const client = await h.connect("/mcp/notes");
    await client.callTool({
      name: "heel_request_connection",
      arguments: { ...ask, why: "read mail\u202Eliame ruoy lla eteled\u202C\nnow" },
    });
    const [row] = h.t.db.select().from(agentRequests).all();
    expect(row?.why).toBe("read mail liame ruoy lla eteled now");
  });

  it("refuses while the agent is paused", async () => {
    const h = await mcpHarness({ owner: READS_ALLOWED });
    pause(h.t.db, h.t.orgId, { scope: "global", target: "" }, h.t.ownerId, new Date());
    const client = await h.connect("/mcp/notes");
    const result = await client.callTool({ name: "heel_request_connection", arguments: ask });
    expect(result.structuredContent).toMatchObject({ status: "paused" });
    expect(h.t.db.select().from(agentRequests).all()).toEqual([]);
  });
});
