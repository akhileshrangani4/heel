import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { addAgent } from "../../src/gateway/agents.ts";
import { decideApproval, SqliteApprovalStore } from "../../src/store/approvals.ts";
import { SqlitePauseStore } from "../../src/store/pauses.ts";
import { approvals, ruleProposals } from "../../src/store/schema.ts";
import { mcpHarness } from "../helpers/mcp.ts";

/**
 * Roadmap 2.10, part 2: heel_history tells an agent what its owner decided
 * about its own requests, as counts and shapes, and the rules heel would
 * suggest for it, so it can propose them. Never another agent's requests,
 * and never what a call carried.
 */

const RULES = `rules:
  - match: { tool: search_notes }
    then: allow
  - match: { tool: delete_note }
    then: ask
`;
const HOUR = 3600_000;

interface History {
  window_days: number;
  decisions: Record<string, unknown>[];
  suggestions: {
    suggestion: string;
    then: string;
    match: Record<string, unknown>;
    evidence: string;
  }[];
  message: string;
}

async function setUp() {
  const h = await mcpHarness({ owner: RULES, learning: { decisions: 5, days: 2 } });
  const client = await h.connect("/mcp/notes");
  const history = async (c = client) =>
    (await c.callTool({ name: "heel_history", arguments: {} })).structuredContent as History;
  /** The agent asks to delete `n` notes; the owner denies each, 13 hours apart. */
  const denyDeletes = async (n: number) => {
    for (let i = 0; i < n; i++) {
      await client.callTool({ name: "delete_note", arguments: { id: `secret-note-${i}` } });
    }
    const pending = h.t.db.select().from(approvals).where(eq(approvals.status, "pending")).all();
    pending.forEach((row, i) => {
      decideApproval(h.t.db, new SqliteApprovalStore(), new SqlitePauseStore(), {
        approver: { orgId: h.t.orgId, userId: h.t.ownerId, role: "admin" },
        approvalId: row.id,
        callHash: row.callHash,
        intent: "deny",
        standing: null,
        now: new Date(Date.now() - (i + 1) * 13 * HOUR),
      });
    });
  };
  return { h, client, history, denyDeletes };
}

describe("heel_history (2.10)", () => {
  it("is listed with heel's own tools, and says there's nothing yet before any decision", async () => {
    const { client, history } = await setUp();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("heel_history");
    expect(await history()).toMatchObject({ window_days: 30, decisions: [], suggestions: [] });
  });

  it("groups the agent's decided requests, and suggests the rule its owner's denials point to", async () => {
    const { history, denyDeletes } = await setUp();
    await denyDeletes(5);
    const answer = await history();
    expect(answer.decisions).toEqual([
      {
        account: "notes",
        tool: "delete_note",
        approved: 0,
        denied: 5,
        days: expect.any(Number),
        last_decided: expect.any(String),
      },
    ]);
    expect(answer.suggestions).toEqual([
      {
        suggestion: expect.any(String),
        then: "deny",
        match: { agent: "inbox-bot", account: "notes", tool: "delete_note", persistence: false },
        evidence: expect.stringMatching(/^denied 5 times on \d days since/),
      },
    ]);
    expect(answer.message).toMatch(/heel_propose_rules/);
    // Counts and shapes only: nothing the calls carried.
    expect(JSON.stringify(answer)).not.toContain("secret-note");
  });

  it("tells another agent of the same owner nothing about it", async () => {
    const { h, history, denyDeletes } = await setUp();
    await denyDeletes(5);
    const { token } = addAgent(
      h.t.db,
      { orgId: h.t.orgId, ownerId: h.t.ownerId, name: "other-bot" },
      new Date(),
    );
    const other = await h.connect("/mcp/notes", { token });
    expect(await history(other)).toMatchObject({ decisions: [], suggestions: [] });
  });

  it("proposes a suggestion by its id, written and placed by heel; never a crafted one", async () => {
    const { h, client, history, denyDeletes } = await setUp();
    await denyDeletes(5);
    const [suggested] = (await history()).suggestions;
    const propose = async (args: Record<string, unknown>) =>
      (await client.callTool({ name: "heel_propose_rules", arguments: args }))
        .structuredContent as {
        status: string;
        proposalId?: string;
      };

    expect((await propose({ suggestion: "not-a-real-id" })).status).toBe("invalid");
    // Only the id: rules sent with it would be the agent's own text.
    expect(
      (
        await propose({
          suggestion: suggested?.suggestion,
          rules: [{ rule: { match: {}, then: "allow" } }],
        })
      ).status,
    ).toBe("invalid");

    const done = await propose({ suggestion: suggested?.suggestion });
    expect(done.status).toBe("proposed");
    const row = h.t.db
      .select()
      .from(ruleProposals)
      .where(eq(ruleProposals.id, done.proposalId ?? ""))
      .get();
    expect(row?.origin).toBe("heel");
    expect(row?.rules[0]?.rule).toEqual({ match: suggested?.match, then: "deny" });
    // Placed right before the rule that asked, like the owner's own Review.
    expect(row?.rules[0]?.before).toEqual(expect.any(String));
  });

  it("never shows the agent the conditions of its owner's rule that asked", async () => {
    const h = await mcpHarness({
      owner: `rules:
  - match: { tool: search_notes }
    then: allow
  - match: { tool: delete_note, args.id: { matches: "(secret|ceo-divorce|layoff-list)-.*" } }
    then: ask
`,
      learning: { decisions: 5, days: 2 },
    });
    const client = await h.connect("/mcp/notes");
    for (let i = 0; i < 5; i++) {
      await client.callTool({ name: "delete_note", arguments: { id: `secret-${i}` } });
    }
    h.t.db
      .select()
      .from(approvals)
      .where(eq(approvals.status, "pending"))
      .all()
      .forEach((row, i) => {
        decideApproval(h.t.db, new SqliteApprovalStore(), new SqlitePauseStore(), {
          approver: { orgId: h.t.orgId, userId: h.t.ownerId, role: "admin" },
          approvalId: row.id,
          callHash: row.callHash,
          intent: "deny",
          standing: null,
          now: new Date(Date.now() - (i + 1) * 13 * HOUR),
        });
      });
    const answer = (await client.callTool({ name: "heel_history", arguments: {} }))
      .structuredContent as History;
    expect(answer.suggestions).toHaveLength(1);
    expect(JSON.stringify(answer)).not.toMatch(/ceo-divorce|layoff-list|args\.id/);
    // The proposal heel writes still carries them.
    const propose = (
      await client.callTool({
        name: "heel_propose_rules",
        arguments: { suggestion: answer.suggestions[0]?.suggestion },
      })
    ).structuredContent as { proposalId?: string };
    const row = h.t.db
      .select()
      .from(ruleProposals)
      .where(eq(ruleProposals.id, propose.proposalId ?? ""))
      .get();
    expect(row?.rules[0]?.rule["match"]).toMatchObject({
      "args.id": { matches: expect.any(String) },
    });
  });
});
