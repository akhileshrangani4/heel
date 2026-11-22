import { describe, expect, it } from "vitest";
import { MontyWorker } from "../../src/codemode/monty.ts";
import { decideApproval, SqliteApprovalStore } from "../../src/store/approvals.ts";
import { SqlitePauseStore } from "../../src/store/pauses.ts";
import { approvals, parkedScripts } from "../../src/store/schema.ts";
import { mcpHarness } from "../helpers/mcp.ts";

/**
 * Code mode round 2, C2: a call that asks parks the script instead of ending
 * it. Nothing after the call runs until the approval is decided and the agent
 * resumes; the parked call then goes through the pipeline again, so the
 * approval decides it (I-59).
 */

const RULES = `rules:
  - match: { tool: search_notes }
    then: allow
  - match: { tool: delete_note }
    then: ask
`;

const SCRIPT = [
  "import notes",
  'found = notes.search_notes(query="q3")',
  'print("before")',
  "try:",
  '    notes.delete_note(id="n1")',
  '    print("deleted")',
  "except PermissionError as e:",
  '    print("refused:", e)',
  'print("after")',
  '"done"',
].join("\n");

interface RunAnswer {
  status: string;
  approvalId?: string;
  resume?: string;
  notParked?: string;
  stdout: string;
  output?: unknown;
  calls: { tool: string; decision: string }[];
  error: string | null;
}

async function setUp() {
  const h = await mcpHarness({ owner: RULES, codeWorker: () => new MontyWorker(), parking: true });
  const client = await h.connect("/mcp");
  const run = async (args: Record<string, unknown>) =>
    (await client.callTool({ name: "run_code", arguments: args })).structuredContent as RunAnswer;
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
  };
  return { h, run, decide };
}

describe("a script that asks is parked, and resumes after the decision (C2)", () => {
  it("parks at the ask, runs nothing after it, and carries on from that call once approved", async () => {
    const { h, run, decide } = await setUp();
    const first = await run({ code: SCRIPT });
    expect(first).toMatchObject({ status: "pending", stdout: "before\n" });
    expect(first.resume).toMatch(/^pks_/);
    expect(first.approvalId).toEqual(expect.any(String));
    expect(h.upstream.calls.map((c) => c.name)).toEqual(["search_notes"]);
    // The snapshot is stored sealed, not as Monty's raw bytes.
    const [row] = h.t.db.select().from(parkedScripts).all();
    expect(row?.snapshot.includes(Buffer.from("search_notes"))).toBe(false);

    // Still waiting: the same answer, and nothing runs.
    const early = await run({ resume: first.resume });
    expect(early).toMatchObject({ status: "pending", resume: first.resume });
    expect(h.upstream.calls.map((c) => c.name)).toEqual(["search_notes"]);

    decide("approve");
    const done = await run({ resume: first.resume });
    expect(done).toMatchObject({ status: "completed", stdout: "deleted\nafter\n" });
    expect(done.calls.map((c) => [c.tool, c.decision])).toEqual([["delete_note", "allow"]]);
    expect(h.upstream.calls).toEqual([
      { name: "search_notes", arguments: { query: "q3" } },
      { name: "delete_note", arguments: { id: "n1" } },
    ]);

    // Once only.
    const again = await run({ resume: first.resume });
    expect(again.status).toBe("error");
    expect(again.error).toMatch(/already ran, expired, or isn't yours/);
    expect(h.t.db.select().from(parkedScripts).all()).toEqual([]);
  });

  it("raises PermissionError at the parked call when it's denied, which the script may catch", async () => {
    const { h, run, decide } = await setUp();
    const first = await run({ code: SCRIPT });
    decide("deny");
    const done = await run({ resume: first.resume });
    expect(done.status).toBe("completed");
    expect(done.stdout).toMatch(/^refused: .*\nafter\n$/);
    expect(h.upstream.calls.map((c) => c.name)).toEqual(["search_notes"]);
  });

  it("won't resume another agent's script, or take code and resume together", async () => {
    const { run } = await setUp();
    const first = await run({ code: SCRIPT });
    expect((await run({ resume: "pks_notmine" })).error).toMatch(/no parked script/);
    expect((await run({ code: "1", resume: first.resume })).error).toMatch(/either code or resume/);
  });

  it("refuses to resume once the agent's accounts changed", async () => {
    const { h, run, decide } = await setUp();
    const first = await run({ code: SCRIPT });
    decide("approve");
    h.t.db.update(parkedScripts).set({ modulesHash: "changed" }).run();
    const answer = await run({ resume: first.resume });
    expect(answer.error).toMatch(/accounts changed/);
    expect(h.upstream.calls.map((c) => c.name)).toEqual(["search_notes"]);
  });

  it("refuses a parked script whose sealed bytes were changed", async () => {
    const { h, run, decide } = await setUp();
    const first = await run({ code: SCRIPT });
    decide("approve");
    const [row] = h.t.db.select().from(parkedScripts).all();
    const tampered = Buffer.from(row?.snapshot ?? Buffer.alloc(0));
    tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 0xff;
    h.t.db.update(parkedScripts).set({ snapshot: tampered }).run();
    const answer = await run({ resume: first.resume });
    expect(answer.error).toMatch(/can't be resumed/);
    expect(h.upstream.calls.map((c) => c.name)).toEqual(["search_notes"]);
  });
});
