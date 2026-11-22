import { describe, expect, it } from "vitest";
import { MontyWorker } from "../../src/codemode/monty.ts";
import { revokeAgent } from "../../src/gateway/agents.ts";
import { decideApproval, SqliteApprovalStore } from "../../src/store/approvals.ts";
import { SqlitePauseStore } from "../../src/store/pauses.ts";
import { approvals, backgroundScripts, parkedScripts } from "../../src/store/schema.ts";
import { mcpHarness } from "../helpers/mcp.ts";

/**
 * Code mode round 2, C6 (Avi's design): background scripts run with no
 * request held open, one per agent; a call that asks parks them, and
 * approving resumes them with no call from the agent; denying ends them; a
 * revoked agent's script stops at its next call.
 */

const RULES = `rules:
  - match: { tool: search_notes }
    then: allow
  - match: { tool: delete_note }
    then: ask
`;

interface Answer {
  status: string;
  script?: string;
  stdout?: string;
  output?: unknown;
  calls?: { tool: string; decision: string }[];
  error?: string | null;
  approvalId?: string;
}

async function setUp() {
  const h = await mcpHarness({ owner: RULES, codeWorker: () => new MontyWorker(), parking: true });
  const client = await h.connect("/mcp");
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })).structuredContent as Answer;
  const status = (id: string) => call("heel_status", { script_id: id });
  /** Waits until the script leaves `running` (or reaches `want`). */
  const settled = async (id: string, want?: string): Promise<Answer> => {
    for (let i = 0; i < 200; i++) {
      const s = await status(id);
      if (want === undefined ? s.status !== "running" : s.status === want) return s;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`script ${id} never settled`);
  };
  const decide = (intent: "approve" | "deny") => {
    const row = h.t.db.select().from(approvals).get();
    if (row === undefined) throw new Error("no approval");
    decideApproval(h.t.db, new SqliteApprovalStore(), new SqlitePauseStore(), {
      approver: { orgId: h.t.orgId, userId: h.t.ownerId, role: "admin" },
      approvalId: row.id,
      callHash: row.callHash,
      intent,
      standing: null,
      now: new Date(),
    });
    // What the approval page does once the decision has committed.
    h.mcp.background?.approvalDecided(row.id);
  };
  return { h, call, status, settled, decide };
}

const ASKS = [
  "import notes",
  'notes.search_notes(query="q")',
  'print("before")',
  'notes.delete_note(id="n1")',
  'print("after")',
  '"done"',
].join("\n");

describe("background scripts (C6)", () => {
  it("runs without a request held open, and its agent reads what it printed and returned", async () => {
    const { call, settled } = await setUp();
    const started = await call("run_code", {
      code: 'import notes\nnotes.search_notes(query="q")\nprint("hi")\n42',
      background: true,
    });
    expect(started.status).toBe("running");
    expect(started.script).toMatch(/^scr_/);
    const done = await settled(started.script ?? "");
    expect(done).toMatchObject({ status: "completed", stdout: "hi\n", output: 42 });
    expect(done.calls?.map((c) => c.tool)).toEqual(["search_notes"]);
  });

  it("keeps one per agent, naming the one in the way", async () => {
    const { call, settled } = await setUp();
    const first = await call("run_code", { code: ASKS, background: true });
    await settled(first.script ?? "", "parked");
    const second = await call("run_code", { code: "1", background: true });
    expect(second.status).toBe("busy");
    expect(second.error).toContain(first.script ?? "");
  });

  it("parks at an ask, and approving carries it on by itself, from that call", async () => {
    const { h, call, settled, decide } = await setUp();
    const started = await call("run_code", { code: ASKS, background: true });
    const parked = await settled(started.script ?? "", "parked");
    expect(parked.approvalId).toEqual(expect.any(String));
    expect(h.upstream.calls.map((c) => c.name)).toEqual(["search_notes"]);
    // The agent can't race heel's own resume.
    const parkedId = h.t.db.select().from(parkedScripts).get()?.id ?? "";
    const raced = await call("run_code", { resume: parkedId });
    expect(raced.error).toMatch(/heel resumes this background script by itself/);

    decide("approve");
    const done = await settled(started.script ?? "");
    expect(done).toMatchObject({ status: "completed", output: "done" });
    // What it printed and called before it parked is kept, and the parked call shows once.
    expect(done.stdout).toBe("before\nafter\n");
    expect(done.calls?.map((c) => [c.tool, c.decision])).toEqual([
      ["search_notes", "allow"],
      ["delete_note", "allow"],
    ]);
    expect(h.upstream.calls.map((c) => c.name)).toEqual(["search_notes", "delete_note"]);
  });

  it("ends when the approval it waits on runs out, though nobody decided it", async () => {
    const { h, call, status, settled } = await setUp();
    const started = await call("run_code", { code: ASKS, background: true });
    await settled(started.script ?? "", "parked");
    // Approvals expire lazily: nothing marks the row; the agent's next read notices.
    h.t.db
      .update(approvals)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .run();
    const done = await status(started.script ?? "");
    expect(done).toMatchObject({ status: "stopped" });
    expect(done.error).toMatch(/expired/);
    expect(done.stdout).toBe("before\n");
    expect(h.t.db.select().from(parkedScripts).all()).toEqual([]);
  });

  it("the approval page's Stop the script ends its record, and each stop says why", async () => {
    const { h, call, settled } = await setUp();
    const started = await call("run_code", { code: ASKS, background: true });
    await settled(started.script ?? "", "parked");
    h.mcp.background?.stopWaitingOn(h.t.db.select().from(approvals).get()?.id ?? "");
    const stopped = await settled(started.script ?? "", "stopped");
    expect(stopped.error).toBe("stopped by its owner");

    const again = await call("run_code", { code: ASKS, background: true });
    await settled(again.script ?? "", "parked");
    h.mcp.background?.stopAgent(
      h.t.orgId,
      h.t.db.select().from(backgroundScripts).all()[1]?.agentId ?? "",
    );
    expect((await settled(again.script ?? "", "stopped")).error).toMatch(/revoked/);
  });

  it("ends when the call it waits on is denied: no code runs because someone pressed Deny", async () => {
    const { h, call, settled, decide } = await setUp();
    const started = await call("run_code", { code: ASKS, background: true });
    await settled(started.script ?? "", "parked");
    decide("deny");
    const done = await settled(started.script ?? "", "stopped");
    expect(done.error).toMatch(/denied/);
    expect(h.upstream.calls.map((c) => c.name)).toEqual(["search_notes"]);
    expect(h.t.db.select().from(parkedScripts).all()).toEqual([]);
  });

  it("doesn't resume for an agent revoked while it waited", async () => {
    const { h, call, settled, decide } = await setUp();
    const started = await call("run_code", { code: ASKS, background: true });
    await settled(started.script ?? "", "parked");
    revokeAgent(h.t.db, h.t.orgId, "inbox-bot", new Date());
    decide("approve");
    const row = h.t.db.select().from(backgroundScripts).get();
    expect(row?.status).toBe("stopped");
    expect(h.upstream.calls.map((c) => c.name)).toEqual(["search_notes"]);
  });

  it("the owner stops a parked one; heel's restart ends one left running", async () => {
    const { h, call, settled } = await setUp();
    const started = await call("run_code", { code: ASKS, background: true });
    await settled(started.script ?? "", "parked");
    expect(h.mcp.background?.stop(started.script ?? "", h.t.orgId)).toBe(true);
    expect((await settled(started.script ?? "", "stopped")).status).toBe("stopped");
    expect(h.t.db.select().from(parkedScripts).all()).toEqual([]);

    h.t.db.update(backgroundScripts).set({ status: "running" }).run();
    h.mcp.background?.recover();
    expect(h.t.db.select().from(backgroundScripts).get()?.status).toBe("ended");
  });

  it("stops a script at its next call once its agent is revoked mid-run", async () => {
    const { h, call, settled } = await setUp();
    // The first call's upstream answer is where the revoke lands.
    h.upstream.hooks.push((name) => {
      if (name === "search_notes") revokeAgent(h.t.db, h.t.orgId, "inbox-bot", new Date());
    });
    const started = await call("run_code", {
      code: 'import notes\nnotes.search_notes(query="a")\nnotes.search_notes(query="b")',
      background: true,
    });
    const row = async () => {
      for (let i = 0; i < 200; i++) {
        const r = h.t.db.select().from(backgroundScripts).get();
        if (r !== undefined && r.status !== "running") return r;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("never settled");
    };
    expect((await row()).status).toBe("error");
    // The second call never reached the upstream.
    expect(h.upstream.calls.map((c) => c.arguments)).toEqual([{ query: "a" }]);
    void started;
    void settled;
  });
});
