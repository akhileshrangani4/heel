import { describe, expect, it } from "vitest";
import {
  callHash,
  UNREPRESENTABLE_ARGS,
  UNREPRESENTABLE_CALL_HASH,
} from "../../src/core/call-hash.ts";
import { ResponseUnparseableError } from "../../src/gateway/pipeline/ports.ts";
import { fakeNormalize, oneRule, pipelineHarness } from "../helpers/pipeline.ts";

/**
 * Fail-closed rows "Any exception between normalizing the call and
 * executing it" and "A response can't be parsed on a surface where heel
 * knows the shape" (spec: Fail-closed behavior): the call is denied as
 * `internal`, with an audit row when the store can take one, and the error
 * log never carries argument values. A result that can't be filtered never
 * reaches the agent.
 */

const SECRET = "tok_live_never_in_logs_9Kp";
const SEND = { action: "email.send", recipients: ["bob@vendor.com"], body: SECRET };
const ALLOW_SENDS = oneRule("{ action: email.send }");
const INTERNAL = { status: "denied", reason: "internal", rule: null };

/** Never settles, as a filter stuck on a read would. */
function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

describe("fail closed: exceptions inside heel", () => {
  it("denies as internal when the definition throws while normalizing, and keeps the arguments out of the log", async () => {
    const h = pipelineHarness({ owner: ALLOW_SENDS });
    h.provider.normalizeHook = () => {
      throw new Error(`could not parse ${SECRET}`);
    };

    const result = await h.call({ args: SEND });

    expect(result).toEqual(INTERNAL);
    expect(h.provider.executed).toEqual([]);
    expect(h.audit()).toEqual([expect.objectContaining({ kind: "deny", reason: "internal" })]);
    expect(h.logs()).not.toContain(SECRET);
  });

  it("denies a normalizing read that outlives the upstream deadline", async () => {
    const h = pipelineHarness({ owner: ALLOW_SENDS, timeouts: { upstreamMs: 50 } });
    h.provider.normalizeHook = () => never();

    const result = await h.call({ args: SEND });

    expect(result).toMatchObject({ status: "denied", reason: "lookup_unavailable" });
    expect(h.provider.executed).toEqual([]);
  });

  it("denies as internal when the approval store throws mid-decision, and nothing is reserved", async () => {
    const h = pipelineHarness({ owner: ALLOW_SENDS });
    h.approvals.governing = () => {
      throw new Error("approvals table is corrupt");
    };

    const result = await h.call({ args: SEND });

    expect(result).toEqual(INTERNAL);
    expect(h.provider.executed).toEqual([]);
    expect(h.counts()).toEqual([]);
    expect(h.audit()).toEqual([expect.objectContaining({ kind: "deny", reason: "internal" })]);
  });

  it.each([
    ["a non-finite number", { action: "email.send", n: Number.NaN }],
    ["Infinity", { action: "email.send", n: Number.POSITIVE_INFINITY }],
    ["a bigint", { action: "email.send", n: 1n }],
    ["a lone surrogate", { action: "email.send", s: "\uD800" }],
  ])(
    "denies arguments holding %s, which have no canonical form, and audits a marker",
    async (_label, args) => {
      const h = pipelineHarness({ owner: oneRule("{}") });

      const result = await h.call({ args });

      expect(result).toEqual(INTERNAL);
      expect(h.provider.executed).toEqual([]);
      expect(h.audit()).toEqual([
        expect.objectContaining({
          kind: "deny",
          reason: "internal",
          args: UNREPRESENTABLE_ARGS,
          callHash: UNREPRESENTABLE_CALL_HASH,
        }),
      ]);
    },
  );

  it("audits the marker, not the pre-rewrite hash, when a rewrite makes the arguments unrepresentable", async () => {
    const h = pipelineHarness({ owner: ALLOW_SENDS });
    h.provider.normalizeHook = async (base) =>
      fakeNormalize({ ...base, args: { ...SEND, pinned: Number.NaN } });

    const result = await h.call({ args: SEND });

    expect(result).toEqual(INTERNAL);
    const before = callHash({
      agentId: h.agent.agentId,
      account: "gmail-work",
      tool: "send",
      args: SEND,
    });
    expect(h.audit()).toEqual([
      expect.objectContaining({ callHash: UNREPRESENTABLE_CALL_HASH, args: UNREPRESENTABLE_ARGS }),
    ]);
    expect(UNREPRESENTABLE_CALL_HASH).not.toBe(before);
  });

  it("gives the marker a hash no call can have, even one whose arguments are the marker", () => {
    const marker = callHash({
      agentId: "agt_1",
      account: "gmail-work",
      tool: "send",
      args: UNREPRESENTABLE_ARGS,
    });
    expect(UNREPRESENTABLE_CALL_HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(UNREPRESENTABLE_CALL_HASH).not.toBe(marker);
  });
});

describe("fail closed: hiding after the call ran", () => {
  it("withholds the result as internal when the filter throws; the call stays counted", async () => {
    const h = pipelineHarness({ owner: ALLOW_SENDS });
    h.provider.hide = async () => {
      throw new Error("filter bug");
    };

    const result = await h.call({ args: SEND });

    expect(result).toEqual(INTERNAL);
    expect(h.provider.executed).toHaveLength(1);
    expect(h.counts()).toHaveLength(1);
    expect(h.logs()).toContain("result withheld");
  });

  it("withholds the result as response_unparseable when the shape is wrong", async () => {
    const h = pipelineHarness({ owner: ALLOW_SENDS });
    h.provider.hide = async () => {
      throw new ResponseUnparseableError();
    };

    const result = await h.call({ args: SEND });

    expect(result).toEqual({ status: "denied", reason: "response_unparseable", rule: null });
    expect(h.provider.executed).toHaveLength(1);
  });

  it("withholds the result when the filter outlives the upstream deadline", async () => {
    const h = pipelineHarness({ owner: ALLOW_SENDS, timeouts: { upstreamMs: 50 } });
    h.provider.hide = () => never();

    const result = await h.call({ args: SEND });

    expect(result).toEqual(INTERNAL);
    expect(result).not.toHaveProperty("result");
  });
});
