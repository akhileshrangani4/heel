import { describe, expect, it } from "vitest";
import type { Call } from "../../src/core/call.ts";
import { checkAdapterNames } from "../../src/gateway/pipeline/pipeline.ts";
import type {
  AdapterInput,
  DecisionAdapter,
  ResponseAdapter,
} from "../../src/gateway/pipeline/ports.ts";
import { oneRule, pipelineHarness } from "../helpers/pipeline.ts";

/**
 * Decision adapters in the pipeline: checks beside the rules that can only
 * tighten. The rules still decide first, and only a call they would let run
 * or ask about reaches the adapters.
 */

const SEND = { action: "email.send", recipients: ["bob@vendor.com"] };
const ALLOW_SENDS = oneRule("{ action: email.send }");
const ASK_SENDS = oneRule("{ action: email.send }", "ask");
const DENY_SENDS = oneRule("{ action: email.send }", "deny");

/** An adapter that answers with whatever `answer` returns, and records what it was asked. */
function fakeAdapter(
  name: string,
  answer: (input: AdapterInput) => unknown,
  options: { watch?: boolean } = {},
): DecisionAdapter & { asked: AdapterInput[] } {
  const asked: AdapterInput[] = [];
  return {
    name,
    ...(options.watch !== undefined && { watch: options.watch }),
    asked,
    check: async (input) => {
      asked.push(input);
      return answer(input);
    },
  };
}

const passing = (name = "pass-all") => fakeAdapter(name, () => ({ decision: "pass" }));
const denying = (name = "deny-all", reason = "not what the user asked for") =>
  fakeAdapter(name, () => ({ decision: "deny", reason }));

describe("decision adapters", () => {
  it("deny a call the rules allow: nothing runs, nothing is counted, and the row names the adapter", async () => {
    const intent = denying("intent");
    const h = pipelineHarness({ owner: ALLOW_SENDS, adapters: [passing(), intent] });

    const result = await h.call({ args: SEND });

    expect(result).toEqual({
      status: "denied",
      reason: "adapter_denied",
      rule: null,
      adapter: "intent",
    });
    expect(h.provider.executed).toHaveLength(0);
    expect(h.counts()).toHaveLength(0);
    const rows = h.audit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "deny", reason: "adapter_denied", adapter: "intent" });
    // The adapter's explanation goes to the log, never to the agent or the audit row.
    expect(JSON.stringify(result)).not.toContain("not what the user asked for");
  });

  it("let a call the rules allow run when every adapter passes", async () => {
    const a = passing("a");
    const b = passing("b");
    const h = pipelineHarness({ owner: ALLOW_SENDS, adapters: [a, b] });

    const result = await h.call({ args: SEND });

    expect(result).toMatchObject({ status: "allowed", result: { ran: "send" } });
    expect(h.provider.executed).toHaveLength(1);
    expect(a.asked).toHaveLength(1);
    expect(b.asked).toHaveLength(1);
    expect(a.asked[0]).toMatchObject({
      tentative: "allow",
      rule: { file: expect.any(String), line: expect.any(Number) },
      call: { action: "email.send", recipients: ["bob@vendor.com"] },
    });
    expect(a.asked[0]?.callHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("I-10: a pass is not an allow: a call no rule matches is still denied", async () => {
    const adapter = passing();
    const h = pipelineHarness({ owner: oneRule("{ action: email.read }"), adapters: [adapter] });

    const result = await h.call({ args: SEND });

    expect(result).toMatchObject({ status: "denied", reason: "no_rule_matched" });
    expect(h.provider.executed).toHaveLength(0);
  });

  it("are never consulted on a call the rules deny, so its data never leaves heel", async () => {
    const adapter = passing();
    const h = pipelineHarness({ owner: DENY_SENDS, adapters: [adapter] });

    const result = await h.call({ args: SEND });

    expect(result).toMatchObject({ status: "denied", reason: "rule" });
    expect(adapter.asked).toHaveLength(0);
    expect(h.stages).not.toContain("adapters");
  });

  it("are never consulted on a paused call", async () => {
    const adapter = passing();
    const h = pipelineHarness({ owner: ALLOW_SENDS, adapters: [adapter] });
    h.pauses.paused.global = true;

    const result = await h.call({ args: SEND });

    expect(result.status).toBe("paused");
    expect(adapter.asked).toHaveLength(0);
  });

  it.each([
    ["throws", () => Promise.reject(new Error("service down"))],
    ["answers allow", () => ({ decision: "allow" })],
    ["answers nothing", () => undefined],
  ])("deny the call when an adapter %s (fail closed)", async (_label, answer) => {
    const h = pipelineHarness({
      owner: ALLOW_SENDS,
      adapters: [fakeAdapter("flaky", answer as (input: AdapterInput) => unknown)],
    });

    const result = await h.call({ args: SEND });

    expect(result).toMatchObject({
      status: "denied",
      reason: "adapter_unavailable",
      adapter: "flaky",
    });
    expect(h.provider.executed).toHaveLength(0);
  });

  it("deny the call when an adapter misses its deadline", async () => {
    const slow = fakeAdapter("slow", () => new Promise(() => {}));
    const h = pipelineHarness({
      owner: ALLOW_SENDS,
      adapters: [slow],
      timeouts: { adapterMs: 20 },
    });

    const result = await h.call({ args: SEND });

    expect(result).toMatchObject({
      status: "denied",
      reason: "adapter_unavailable",
      adapter: "slow",
    });
    expect(h.provider.executed).toHaveLength(0);
  });

  it("are consulted before a person is asked: a deny creates no request and notifies no one", async () => {
    const adapter = denying();
    const h = pipelineHarness({ owner: ASK_SENDS, adapters: [adapter] });

    const result = await h.call({ args: SEND });

    expect(result).toMatchObject({ status: "denied", reason: "adapter_denied" });
    expect(adapter.asked[0]?.tentative).toBe("ask");
    expect(h.approvals.rows).toHaveLength(0);
    expect(h.notified).toHaveLength(0);
  });

  it("let an ask become a pending request when they pass", async () => {
    const h = pipelineHarness({ owner: ASK_SENDS, adapters: [passing()] });

    const result = await h.call({ args: SEND });

    expect(result.status).toBe("pending");
    expect(h.notified).toHaveLength(1);
  });

  it("I-54: re-check an approved call when it is re-sent; a deny then keeps the approval unused", async () => {
    let verdict: "pass" | "deny" = "pass";
    const adapter = fakeAdapter("toggle", () => ({ decision: verdict }));
    const h = pipelineHarness({ owner: ASK_SENDS, adapters: [adapter] });

    const pending = await h.call({ args: SEND });
    if (pending.status !== "pending") throw new Error("expected a pending request");
    h.approvals.set(pending.approvalId, "approved");

    verdict = "deny";
    const blocked = await h.call({ args: SEND });
    expect(blocked).toMatchObject({
      status: "denied",
      reason: "adapter_denied",
      adapter: "toggle",
    });
    expect(h.approvals.get(pending.approvalId).status).toBe("approved");
    expect(h.provider.executed).toHaveLength(0);

    verdict = "pass";
    const ran = await h.call({ args: SEND });
    expect(ran).toMatchObject({ status: "allowed", via: { kind: "approval" } });
    expect(h.approvals.get(pending.approvalId).status).toBe("executed");
    expect(h.provider.executed).toHaveLength(1);
  });

  it("in watch mode log what they would deny and decide nothing", async () => {
    const h = pipelineHarness({
      owner: ALLOW_SENDS,
      adapters: [fakeAdapter("shadow", () => ({ decision: "deny" }), { watch: true })],
    });

    const result = await h.call({ args: SEND });

    expect(result.status).toBe("allowed");
    const rows = h.audit();
    expect(rows.map((row) => row.kind)).toEqual(["would_deny", "allow"]);
    expect(rows[0]).toMatchObject({ reason: "adapter_denied", adapter: "shadow", rule: null });
  });

  it("I-71: global watch relaxes the rules' deny but never an adapter's", async () => {
    const adapter = denying("intent");
    const h = pipelineHarness({ owner: DENY_SENDS, watch: true, adapters: [adapter] });

    const result = await h.call({ args: SEND });

    expect(result).toMatchObject({ status: "denied", reason: "adapter_denied", adapter: "intent" });
    expect(adapter.asked[0]).toMatchObject({ tentative: "allow" });
    expect(h.provider.executed).toHaveLength(0);
  });

  it("run outside the decision transaction, which then starts again", async () => {
    const h = pipelineHarness({ owner: ALLOW_SENDS, adapters: [passing()] });

    await h.call({ args: SEND });

    expect(h.stages).toEqual([
      "account",
      "pause",
      "normalize",
      "pause",
      "approval",
      "decide",
      "adapters",
      "pause",
      "approval",
      "decide",
      "execute",
    ]);
  });

  it("are told which outcome and rule they are checking, call by call", async () => {
    const adapter = passing();
    const h = pipelineHarness({
      owner: `rules:
  - match: { action: email.send, items: { over: 1, per: hour } }
    then: ask
  - match: { action: email.send }
    then: allow
`,
      adapters: [adapter],
    });

    // Counts include the current call (I-24): the first fits the limit, the second is over it.
    expect((await h.call({ args: SEND })).status).toBe("allowed");
    expect((await h.call({ args: SEND })).status).toBe("pending");
    expect(adapter.asked.map((input) => input.tentative)).toEqual(["allow", "ask"]);
  });

  it("must have valid names, each used once per chain", () => {
    expect(() => checkAdapterNames("decision", ["intent", "openfga"])).not.toThrow();
    expect(() => checkAdapterNames("decision", ["Intent"])).toThrow(/invalid/);
    expect(() => checkAdapterNames("decision", ["intent", "intent"])).toThrow(/twice/);
    expect(() => pipelineHarness({ adapters: [passing("x"), passing("x")] })).toThrow(/twice/);
  });
});

describe("response adapters", () => {
  function responseAdapter(
    name: string,
    answer: (call: Call, result: unknown) => unknown,
  ): ResponseAdapter & { seen: unknown[] } {
    const seen: unknown[] = [];
    return {
      name,
      seen,
      check: async (call, result) => {
        seen.push(result);
        return answer(call, result);
      },
    };
  }

  it("see only what hiding left, and pass it through", async () => {
    const adapter = responseAdapter("dlp", () => ({ decision: "pass" }));
    const h = pipelineHarness({ owner: ALLOW_SENDS, responseAdapters: [adapter] });
    h.provider.hide = async () => ({ ran: "send", hidden: 1 });

    const result = await h.call({ args: SEND });

    expect(result).toMatchObject({ status: "allowed", result: { ran: "send", hidden: 1 } });
    expect(adapter.seen).toEqual([{ ran: "send", hidden: 1 }]);
    expect(h.stages.slice(-3)).toEqual(["execute", "hide", "respond"]);
  });

  it("withhold a result: the call ran and stays counted, and the agent gets nothing of it", async () => {
    const h = pipelineHarness({
      owner: ALLOW_SENDS,
      responseAdapters: [
        responseAdapter("first", () => ({ decision: "pass" })),
        responseAdapter("dlp", () => ({ decision: "withhold", reason: "contains a card number" })),
      ],
    });

    const result = await h.call({ args: SEND });

    expect(result).toEqual({
      status: "denied",
      reason: "response_withheld",
      rule: null,
      adapter: "dlp",
      executed: true,
    });
    expect(h.provider.executed).toHaveLength(1);
    expect(h.counts()).toHaveLength(1);
  });

  it("withhold the result when one throws", async () => {
    const h = pipelineHarness({
      owner: ALLOW_SENDS,
      responseAdapters: [responseAdapter("broken", () => Promise.reject(new Error("down")))],
    });

    const result = await h.call({ args: SEND });

    expect(result).toMatchObject({
      status: "denied",
      reason: "response_withheld",
      adapter: "broken",
    });
  });
});
