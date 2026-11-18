import { describe, expect, it } from "vitest";
import { JevAdapter, jevState } from "../../src/adapters/jev.ts";
import { hintsFromAnswers, JEV_QUESTIONS, parseHints } from "../../src/core/hints.ts";
import { runApprovalHints } from "../../src/gateway/approval-hints.ts";
import type { ApprovalAdapter, ApprovalHintInput } from "../../src/gateway/pipeline/ports.ts";
import { hintsFor, recentCalls } from "../../src/store/hints.ts";
import { approvalHarness, pendingId, SEND } from "../helpers/approvals.ts";
import { captureLogger } from "../helpers/log.ts";
import { oneRule } from "../helpers/pipeline.ts";

const OTHER = { firstCall: false, truncated: false };
const FIRST = { firstCall: true, truncated: false };
const CLEAR = {
  contains_secret: 0.02,
  contains_personal_data: 0.03,
  asks_for_money_or_access: 0.05,
};

describe("the hints truth table", () => {
  it("warns about each risk Jev is sure of", () => {
    expect(
      hintsFromAnswers({ ...CLEAR, asks_for_money_or_access: 0.92, like_recent_calls: 0.5 }, OTHER),
    ).toEqual([{ tone: "warn", text: "Asks someone for money, a payment or account access." }]);
  });

  it("says nothing about a risk it isn't sure of", () => {
    expect(
      hintsFromAnswers({ ...CLEAR, contains_secret: 0.5, like_recent_calls: 0.5 }, OTHER),
    ).toEqual([]);
  });

  it("calls a call routine only when every risk is clearly absent and it's like recent work", () => {
    expect(hintsFromAnswers({ ...CLEAR, like_recent_calls: 0.9 }, OTHER)).toEqual([
      { tone: "ok", text: "Looks routine for this agent." },
    ]);
    expect(
      hintsFromAnswers({ ...CLEAR, contains_secret: 0.4, like_recent_calls: 0.9 }, OTHER),
    ).toEqual([]);
  });

  it("notes a call unlike recent work, and a first call without asking Jev", () => {
    expect(hintsFromAnswers({ ...CLEAR, like_recent_calls: 0.1 }, OTHER)).toEqual([
      { tone: "note", text: "Unlike this agent's recent calls." },
    ]);
    expect(hintsFromAnswers(CLEAR, FIRST)).toEqual([
      { tone: "note", text: "This agent's first call: nothing to compare it with." },
    ]);
  });

  it("never calls cut arguments routine, and says only part was checked", () => {
    expect(
      hintsFromAnswers(
        { ...CLEAR, like_recent_calls: 0.95 },
        { firstCall: false, truncated: true },
      ),
    ).toEqual([{ tone: "note", text: "Long arguments: only the first part was checked." }]);
  });

  it("treats a missing answer as unknown, never as clear", () => {
    expect(hintsFromAnswers({ like_recent_calls: 0.95 }, OTHER)).toEqual([]);
  });
});

describe("what an approval adapter may return", () => {
  it("accepts hints and refuses anything else", () => {
    expect(parseHints([{ tone: "warn", text: "x" }])).toEqual({
      status: "ok",
      hints: [{ tone: "warn", text: "x" }],
    });
    for (const bad of [
      null,
      "allow",
      { decision: "allow" },
      [{ tone: "allow", text: "x" }],
      [{ tone: "ok" }],
    ]) {
      expect(parseHints(bad).status).toBe("unavailable");
    }
  });
});

function input(overrides: Partial<ApprovalHintInput> = {}): ApprovalHintInput {
  return {
    approvalId: "apr_1",
    agentName: "inbox-bot",
    call: {
      orgId: "org",
      agentId: "agt",
      ownerId: "usr",
      surface: "mcp",
      account: "gmail-work",
      provider: "gmail",
      tool: "send",
      action: "email.send",
      args: { to: ["sam@customer.com"], body: "Please wire $4,000 today." },
      items: 1,
    } as ApprovalHintInput["call"],
    recentCalls: [
      { account: "gmail-work", tool: "search", action: "email.read", outcome: "allowed" },
    ],
    ...overrides,
  };
}

function fakeTypeSafe(answers: Record<string, unknown>, status = 200) {
  const requests: {
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    requests.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    });
    return new Response(JSON.stringify({ model: "jev-1.14.0", answers }), { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, requests };
}

const noul = (value: number) => ({ type: "noul", noul: value });

describe("the Jev adapter", () => {
  it("asks every question about the call and the agent's recent work", async () => {
    const ts = fakeTypeSafe({
      contains_secret: noul(0.01),
      contains_personal_data: noul(0.02),
      asks_for_money_or_access: noul(0.95),
      like_recent_calls: noul(0.2),
    });
    const adapter = new JevAdapter({ apiKey: "ts-key", model: "jev-latest", fetch: ts.fetch });
    const hints = await adapter.hints(input(), AbortSignal.timeout(1000));
    expect(hints).toEqual([
      { tone: "warn", text: "Asks someone for money, a payment or account access." },
      { tone: "note", text: "Unlike this agent's recent calls." },
    ]);
    const [request] = ts.requests;
    expect(request?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(request?.headers["authorization"]).toBe("Bearer ts-key");
    expect(request?.body["model"]).toBe("jev-latest");
    expect(request?.body["questions"]).toEqual(JEV_QUESTIONS);
    expect(request?.body["state"]).toEqual(jevState(input()));
  });

  it("doesn't ask about recent work on an agent's first call", async () => {
    const ts = fakeTypeSafe({
      contains_secret: noul(0.01),
      contains_personal_data: noul(0.01),
      asks_for_money_or_access: noul(0.01),
    });
    const adapter = new JevAdapter({ apiKey: "k", model: "jev-latest", fetch: ts.fetch });
    await adapter.hints(input({ recentCalls: [] }), AbortSignal.timeout(1000));
    expect(Object.keys(ts.requests[0]?.body["questions"] as object)).not.toContain(
      "like_recent_calls",
    );
  });

  it("treats an error or a malformed answer as a failure, never as a no", async () => {
    const down = fakeTypeSafe({}, 503);
    await expect(
      new JevAdapter({ apiKey: "k", model: "m", fetch: down.fetch }).hints(
        input(),
        AbortSignal.timeout(1000),
      ),
    ).rejects.toThrow("503");
    const odd = fakeTypeSafe({ contains_secret: { type: "choice", choice: "yes" } });
    await expect(
      new JevAdapter({ apiKey: "k", model: "m", fetch: odd.fetch }).hints(
        input(),
        AbortSignal.timeout(1000),
      ),
    ).rejects.toThrow("Noul");
  });

  it("cuts very long arguments and says so", () => {
    const state = jevState(
      input({ call: { ...input().call, args: { body: "x".repeat(50_000) } } }),
    );
    expect(typeof state.call.arguments).toBe("string");
    expect(String(state.call.arguments)).toContain("(cut:");
  });
});

describe("running approval adapters on a new request", () => {
  async function pending() {
    const h = approvalHarness({ owner: oneRule("{ action: email.send }", "ask") });
    const approvalId = pendingId(await h.call({ args: SEND }));
    return { h, approvalId };
  }

  it("stores each adapter's hints and leaves the request pending", async () => {
    const { h, approvalId } = await pending();
    const seen: ApprovalHintInput[] = [];
    const adapter: ApprovalAdapter = {
      name: "test",
      hints: async (i) => {
        seen.push(i);
        return [{ tone: "ok", text: "Looks routine for this agent." }];
      },
    };
    await runApprovalHints(
      {
        db: h.t.db,
        orgId: h.t.orgId,
        adapters: [adapter],
        log: captureLogger().logger,
        now: () => h.clock.now,
      },
      approvalId,
    );
    expect(hintsFor(h.t.db, approvalId)).toEqual([
      {
        adapter: "test",
        result: { status: "ok", hints: [{ tone: "ok", text: "Looks routine for this agent." }] },
      },
    ]);
    expect(seen[0]?.call.action).toBe("email.send");
    expect(h.status(approvalId)).toBe("pending");
  });

  it("sends nothing for a request decided before the adapters ran", async () => {
    const { h, approvalId } = await pending();
    h.decide(approvalId, "deny");
    let asked = false;
    const adapter: ApprovalAdapter = {
      name: "test",
      hints: async () => {
        asked = true;
        return [];
      },
    };
    await runApprovalHints(
      {
        db: h.t.db,
        orgId: h.t.orgId,
        adapters: [adapter],
        log: captureLogger().logger,
        now: () => h.clock.now,
      },
      approvalId,
    );
    expect(asked).toBe(false);
    expect(hintsFor(h.t.db, approvalId)).toEqual([]);
  });

  it("counts each earlier call once, and leaves out only this request", async () => {
    const h = approvalHarness({ owner: oneRule("{ action: email.send }", "ask") });
    const first = pendingId(await h.call({ args: SEND }));
    h.decide(first, "approve");
    await h.call({ args: SEND }); // runs: approved, then executed
    const second = pendingId(await h.call({ args: { ...SEND, subject: "Q4" } }));
    const recent = recentCalls(h.t.db, h.t.orgId, h.agent.agentId, second);
    // The first call counts once (its ask; approved and executed are follow-ups), and this ask not at all.
    expect(recent.map((c) => c.outcome)).toEqual(["ask"]);
  });

  it("stores 'unavailable' when an adapter throws, times out or returns a verdict", async () => {
    const { h, approvalId } = await pending();
    const adapters: ApprovalAdapter[] = [
      { name: "a-throws", hints: async () => Promise.reject(new Error("boom")) },
      {
        name: "b-slow",
        hints: (_i, signal) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason)),
          ),
      },
      { name: "c-allows", hints: async () => ({ decision: "allow" }) },
    ];
    await runApprovalHints(
      {
        db: h.t.db,
        orgId: h.t.orgId,
        adapters,
        log: captureLogger().logger,
        now: () => h.clock.now,
        timeoutMs: 20,
      },
      approvalId,
    );
    expect(hintsFor(h.t.db, approvalId).map((s) => [s.adapter, s.result.status])).toEqual([
      ["a-throws", "unavailable"],
      ["b-slow", "unavailable"],
      ["c-allows", "unavailable"],
    ]);
    expect(h.status(approvalId)).toBe("pending");
  });
});
