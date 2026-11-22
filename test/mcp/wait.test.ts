import { describe, expect, it } from "vitest";
import { MontyWorker } from "../../src/codemode/monty.ts";
import { MAX_HELD_PER_AGENT } from "../../src/gateway/mcp/server.ts";
import { DEFAULT_APPROVAL_WAIT } from "../../src/gateway/mcp/wait.ts";
import { rejectRequest } from "../../src/requests/connection.ts";
import { decideApproval, SqliteApprovalStore } from "../../src/store/approvals.ts";
import { SqlitePauseStore } from "../../src/store/pauses.ts";
import { agentRequests, approvals } from "../../src/store/schema.ts";
import { type McpHarness, mcpHarness } from "../helpers/mcp.ts";

/**
 * Roadmap 2.12: a call that needs approval waits for the decision and
 * answers with the result, so the person never has to tell the agent to look
 * again after the passkey tap. Past the window it answers `pending`, as before.
 */

const RULES = `rules:
  - match: { tool: search_notes }
    then: allow
  - match: { tool: delete_note }
    then: ask
`;

const wait = (windowMs: number) => ({ windowMs: () => windowMs, pollMs: 10, beatMs: 30 });

/** Waits until an approval row exists, then decides it as the owner. */
async function decideWhenAsked(h: McpHarness, intent: "approve" | "deny"): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const row = h.t.db.select().from(approvals).get();
    if (row !== undefined) {
      decideApproval(h.t.db, new SqliteApprovalStore(), new SqlitePauseStore(), {
        approver: { orgId: h.t.orgId, userId: h.t.ownerId, role: "admin" },
        approvalId: row.id,
        callHash: row.callHash,
        intent,
        standing: null,
        now: new Date(),
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the call never asked");
}

describe("a call that needs approval waits for the decision (2.12)", () => {
  it("answers with the result once approved, running the call once", async () => {
    const h = await mcpHarness({ owner: RULES, approvalWait: wait(5_000) });
    const client = await h.connect("/mcp/notes");
    const [result] = await Promise.all([
      client.callTool({ name: "delete_note", arguments: { id: "n1" } }),
      decideWhenAsked(h, "approve"),
    ]);
    expect(result.isError).toBeFalsy();
    expect(h.upstream.calls).toEqual([{ name: "delete_note", arguments: { id: "n1" } }]);
    expect(h.t.db.select().from(approvals).get()?.status).toBe("executed");
  });

  it("answers with the denial once denied, and nothing runs", async () => {
    const h = await mcpHarness({ owner: RULES, approvalWait: wait(5_000) });
    const client = await h.connect("/mcp/notes");
    const [result] = await Promise.all([
      client.callTool({ name: "delete_note", arguments: { id: "n1" } }),
      decideWhenAsked(h, "deny"),
    ]);
    expect(result.structuredContent).toMatchObject({ status: "denied", reason: "approval_denied" });
    expect(h.upstream.calls).toEqual([]);
  });

  it("answers pending when no one decides in time, and the re-send still works", async () => {
    const h = await mcpHarness({ owner: RULES, approvalWait: wait(60) });
    const client = await h.connect("/mcp/notes");
    const first = await client.callTool({ name: "delete_note", arguments: { id: "n1" } });
    expect(first.structuredContent).toMatchObject({
      status: "pending",
      check: "heel_status",
      message: expect.stringMatching(/No one has decided yet/),
    });
    await decideWhenAsked(h, "approve");
    const again = await client.callTool({ name: "delete_note", arguments: { id: "n1" } });
    expect(again.isError).toBeFalsy();
    expect(h.upstream.calls).toHaveLength(1);
  });

  it("stops waiting when the client cancels the call, so a later approval doesn't run it unseen", async () => {
    const h = await mcpHarness({ owner: RULES, approvalWait: wait(5_000) });
    const client = await h.connect("/mcp/notes");
    const controller = new AbortController();
    const call = client.callTool(
      { name: "delete_note", arguments: { id: "n1" } },
      { signal: controller.signal },
    );
    while (h.t.db.select().from(approvals).get() === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    controller.abort();
    await expect(call).rejects.toThrow();
    // Give the cancel time to arrive and the held call time to let go.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await decideWhenAsked(h, "approve");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.upstream.calls).toEqual([]);
    expect(h.t.db.select().from(approvals).get()?.status).toBe("approved");
  });

  it("tells a client that asked for progress that it's still waiting", async () => {
    const h = await mcpHarness({ owner: RULES, approvalWait: wait(5_000) });
    const client = await h.connect("/mcp/notes");
    const progress: string[] = [];
    const call = client.callTool(
      { name: "delete_note", arguments: { id: "n1" } },
      {
        onprogress: (p) => progress.push(p.message ?? ""),
      },
    );
    while (progress.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    await decideWhenAsked(h, "approve");
    expect((await call).isError).toBeFalsy();
    expect(progress[0]).toMatch(/Waiting for approval/);
  });

  it("carries a script on from the call that asked, with what it printed before", async () => {
    const h = await mcpHarness({
      owner: RULES,
      codeWorker: () => new MontyWorker(),
      parking: true,
      approvalWait: wait(10_000),
    });
    const client = await h.connect("/mcp");
    const code = [
      "import notes",
      'notes.search_notes(query="q3")',
      'print("before")',
      'notes.delete_note(id="n1")',
      'print("after")',
      '"done"',
    ].join("\n");
    const [result] = await Promise.all([
      client.callTool({ name: "run_code", arguments: { code } }),
      decideWhenAsked(h, "approve"),
    ]);
    expect(result.structuredContent).toMatchObject({
      status: "completed",
      stdout: "before\nafter\n",
      output: "done",
    });
    const calls = (result.structuredContent as { calls: { tool: string }[] }).calls;
    expect(calls.map((c) => [c.tool, (c as { decision?: string }).decision])).toEqual([
      ["search_notes", "allow"],
      ["delete_note", "allow"],
    ]);
    expect(h.upstream.calls.map((c) => c.name)).toEqual(["search_notes", "delete_note"]);
  });

  it("heel_accounts with wait answers once a request is decided, and at once when nothing waits", async () => {
    const h = await mcpHarness({ owner: RULES, approvalWait: wait(5_000) });
    const client = await h.connect("/mcp/notes");
    const started = Date.now();
    await client.callTool({ name: "heel_accounts", arguments: { wait: true } });
    expect(Date.now() - started).toBeLessThan(1_000);

    await client.callTool({
      name: "heel_request_connection",
      arguments: { service: "github", alias: "gh", why: "issues" },
    });
    const held = client.callTool({ name: "heel_accounts", arguments: { wait: true } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const row = h.t.db.select().from(agentRequests).get();
    if (row === undefined) throw new Error("no request");
    rejectRequest(h.t.db, row, h.t.ownerId, new Date());
    const answer = (await held).structuredContent as { waiting: { connections: unknown[] } };
    expect(answer.waiting.connections).toEqual([]);
  });

  it("holds Claude Code for four minutes, and every other client under the 60 seconds it waits", () => {
    expect(DEFAULT_APPROVAL_WAIT.windowMs("claude-code")).toBe(240_000);
    expect(DEFAULT_APPROVAL_WAIT.windowMs("codex-mcp-client")).toBeLessThan(60_000);
    expect(DEFAULT_APPROVAL_WAIT.windowMs("my-claude-code-fork")).toBeLessThan(60_000);
    expect(DEFAULT_APPROVAL_WAIT.windowMs(null)).toBeLessThan(60_000);
  });

  it("two identical held calls: one runs on the approval, the other says so and asks nothing new", async () => {
    const h = await mcpHarness({ owner: RULES, approvalWait: wait(5_000) });
    const client = await h.connect("/mcp/notes");
    const call = () => client.callTool({ name: "delete_note", arguments: { id: "n1" } });
    const [a, b] = await Promise.all([call(), call(), decideWhenAsked(h, "approve")]);
    const statuses = [a, b].map((r) =>
      r.isError ? (r.structuredContent as { status: string }).status : "ran",
    );
    expect(statuses).toContain("ran");
    expect(statuses.filter((s) => s !== "ran")).toEqual([expect.stringMatching(/^(used|denied)$/)]);
    expect(h.upstream.calls).toHaveLength(1);
    expect(h.t.db.select().from(approvals).all()).toHaveLength(1);
  });

  it("holds at most a few calls per agent; the rest answer pending at once", async () => {
    const h = await mcpHarness({ owner: RULES, approvalWait: wait(400) });
    const client = await h.connect("/mcp/notes");
    const started = Date.now();
    const answers = await Promise.all(
      Array.from({ length: MAX_HELD_PER_AGENT + 2 }, (_, i) =>
        client
          .callTool({ name: "delete_note", arguments: { id: `n${i}` } })
          .then(() => Date.now() - started),
      ),
    );
    expect(answers.filter((ms) => ms < 300)).toHaveLength(2);
  });
});
