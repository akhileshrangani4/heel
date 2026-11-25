import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MontyWorker } from "../../src/codemode/monty.ts";
import { MAX_HELD_PER_AGENT } from "../../src/gateway/mcp/server.ts";
import { DEFAULT_APPROVAL_WAIT } from "../../src/gateway/mcp/wait.ts";
import { rejectRequest } from "../../src/requests/connection.ts";
import { decideApproval, SqliteApprovalStore } from "../../src/store/approvals.ts";
import { newId } from "../../src/store/ids.ts";
import { SqlitePauseStore } from "../../src/store/pauses.ts";
import { accounts, agentRequests, approvals } from "../../src/store/schema.ts";
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

  it("a cancel that two sessions' calls could both mean stops neither", async () => {
    const h = await mcpHarness({ owner: RULES, approvalWait: wait(5_000) });
    const one = await h.connect("/mcp/notes");
    const two = await h.connect("/mcp/notes");
    const controller = new AbortController();
    const first = one.callTool(
      { name: "delete_note", arguments: { id: "one" } },
      { signal: controller.signal },
    );
    const second = two.callTool({ name: "delete_note", arguments: { id: "two" } });
    while (h.t.db.select().from(approvals).all().length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    controller.abort();
    await expect(first).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The other session's call is still waiting: approving it runs it and answers it.
    const row = h.t.db
      .select()
      .from(approvals)
      .all()
      .find((r) => JSON.stringify(r.call).includes('"two"'));
    if (row === undefined) throw new Error("no approval for the second call");
    decideApproval(h.t.db, new SqliteApprovalStore(), new SqlitePauseStore(), {
      approver: { orgId: h.t.orgId, userId: h.t.ownerId, role: "admin" },
      approvalId: row.id,
      callHash: row.callHash,
      intent: "approve",
      standing: null,
      now: new Date(),
    });
    expect((await second).isError).toBeFalsy();
    expect(h.upstream.calls).toEqual([{ name: "delete_note", arguments: { id: "two" } }]);
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

/**
 * `heel_accounts` with `wait: true` (2.12): the setup prompt tells the agent
 * to keep calling it until nothing waits, so an answer must say whether
 * something changed. One that ends its window with nothing changed used to
 * look exactly like a real answer, and an agent read it as returning early.
 */
describe("heel_accounts with wait: true", () => {
  interface Answer {
    wait?: { outcome: string; message: string; waitedSeconds?: number };
    accounts: { alias: string; status: string }[];
    waiting: { connections: { alias: string }[] };
  }
  const answerOf = (result: unknown) => (result as { structuredContent: Answer }).structuredContent;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** A harness whose agent has asked for a GitHub connection, and a client for it. */
  async function asked(windowMs: number) {
    const h = await mcpHarness({ owner: RULES, approvalWait: wait(windowMs) });
    const client = await h.connect("/mcp/notes");
    await client.callTool({
      name: "heel_request_connection",
      arguments: { service: "github", alias: "gh", why: "issues" },
    });
    const row = h.t.db.select().from(agentRequests).get();
    if (row === undefined) throw new Error("no request");
    return { h, client, row };
  }

  /** Calls heel_accounts with wait, noting when it answers. */
  function callWaiting(client: Awaited<ReturnType<typeof asked>>["client"]) {
    const state = { answered: false };
    const started = Date.now();
    const answer = client
      .callTool({ name: "heel_accounts", arguments: { wait: true } })
      .then((result) => {
        state.answered = true;
        return { answer: answerOf(result), ms: Date.now() - started };
      });
    return { state, answer };
  }

  it("holds while a connection request waits, and answers once the owner decides it", async () => {
    const { h, client, row } = await asked(5_000);
    const { state, answer } = callWaiting(client);
    await sleep(300);
    expect(state.answered).toBe(false);
    rejectRequest(h.t.db, row, h.t.ownerId, new Date());
    const { answer: result } = await answer;
    expect(result.waiting.connections).toEqual([]);
    expect(result.wait).toMatchObject({ outcome: "changed" });
  });

  it("says plainly when nothing changed before its window ended, so the agent calls again", async () => {
    const { client } = await asked(400);
    const { answer } = callWaiting(client);
    const { answer: result, ms } = await answer;
    expect(ms).toBeGreaterThanOrEqual(350);
    // Still waiting, and the answer says this isn't the owner's decision.
    expect(result.waiting.connections.map((c) => c.alias)).toEqual(["gh"]);
    expect(result.wait).toMatchObject({
      outcome: "nothing_changed",
      message: expect.stringMatching(
        /hasn't decided yet.*call heel_accounts with \{"wait": true\} again/i,
      ),
    });
  });

  it("answers when the request expires while it waits", async () => {
    const { h, client, row } = await asked(5_000);
    h.t.db
      .update(agentRequests)
      .set({ expiresAt: new Date(Date.now() + 200) })
      .where(eq(agentRequests.id, row.id))
      .run();
    const { answer } = callWaiting(client);
    const { answer: result, ms } = await answer;
    expect(ms).toBeLessThan(2_000);
    expect(result.waiting.connections).toEqual([]);
    expect(result.wait).toMatchObject({ outcome: "changed" });
  });

  it("answers when an account connects some other way while its request still waits", async () => {
    const { h, client } = await asked(5_000);
    const { state, answer } = callWaiting(client);
    await sleep(200);
    expect(state.answered).toBe(false);
    // As `heel connect github --as gh` does from the owner's terminal: the request stays open.
    h.t.db
      .insert(accounts)
      .values({
        id: newId("account"),
        orgId: h.t.orgId,
        ownerId: h.t.ownerId,
        alias: "gh",
        provider: "github",
        settings: {},
        status: "active",
        createdAt: new Date(),
      })
      .run();
    const { answer: result, ms } = await answer;
    expect(ms).toBeLessThan(2_000);
    expect(result.accounts.map((a) => a.alias)).toContain("gh");
    expect(result.wait).toMatchObject({ outcome: "changed" });
  });

  it("answers at once, and says so, when nothing it asked for waits", async () => {
    const h = await mcpHarness({ owner: RULES, approvalWait: wait(5_000) });
    const client = await h.connect("/mcp/notes");
    const { answer } = callWaiting(client);
    const { answer: result, ms } = await answer;
    expect(ms).toBeLessThan(1_000);
    expect(result.wait).toMatchObject({ outcome: "nothing_waiting" });
  });

  it("tells the agent to pause before calling again when heel can't hold the call", async () => {
    const { client } = await asked(0);
    const { answer } = callWaiting(client);
    const { answer: result } = await answer;
    expect(result.wait).toMatchObject({
      outcome: "nothing_changed",
      waitedSeconds: 0,
      message: expect.stringMatching(/wait a minute/i),
    });
  });

  it("adds nothing about waiting when the agent didn't ask to wait", async () => {
    const { client } = await asked(5_000);
    const result = answerOf(await client.callTool({ name: "heel_accounts", arguments: {} }));
    expect(result.wait).toBeUndefined();
  });
});
