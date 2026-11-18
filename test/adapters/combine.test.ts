import { describe, expect, it } from "vitest";
import {
  ADAPTER_NAME,
  type AdapterOutcome,
  combineAdapters,
  MAX_ADAPTER_DETAIL,
  parseAdapterVerdict,
  parseResponseVerdict,
} from "../../src/core/adapters.ts";

/**
 * The adapter chain's pure core: what an adapter's answer means and how the
 * chain's answers combine. An adapter can only tighten.
 */

const outcome = (
  adapter: string,
  verdict: AdapterOutcome["verdict"],
  watch = false,
): AdapterOutcome => ({ adapter, watch, verdict });

describe("parseAdapterVerdict", () => {
  it("reads pass and deny", () => {
    expect(parseAdapterVerdict({ decision: "pass" })).toEqual({ decision: "pass" });
    expect(parseAdapterVerdict({ decision: "deny", reason: "  off-intent  " })).toEqual({
      decision: "deny",
      reason: "off-intent",
    });
    expect(parseAdapterVerdict({ decision: "deny" })).toEqual({ decision: "deny", reason: "" });
  });

  it("never reads an allow: an adapter can't loosen a call", () => {
    expect(parseAdapterVerdict({ decision: "allow" })).toEqual({ decision: "unavailable" });
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "pass"],
    ["an array", [{ decision: "pass" }]],
    ["no decision", {}],
    ["an unknown decision", { decision: "maybe" }],
  ])("reads %s as unavailable", (_label, value) => {
    expect(parseAdapterVerdict(value)).toEqual({ decision: "unavailable" });
  });

  it("caps the reason it keeps", () => {
    const verdict = parseAdapterVerdict({ decision: "deny", reason: "x".repeat(1_000) });
    expect(verdict).toEqual({ decision: "deny", reason: "x".repeat(MAX_ADAPTER_DETAIL) });
  });
});

describe("parseResponseVerdict", () => {
  it("passes only on pass", () => {
    expect(parseResponseVerdict({ decision: "pass" })).toEqual({ decision: "pass" });
    expect(parseResponseVerdict({ decision: "withhold", reason: "pii" })).toEqual({
      decision: "withhold",
      reason: "pii",
    });
    expect(parseResponseVerdict({ decision: "allow" })).toEqual({
      decision: "withhold",
      reason: "",
    });
    expect(parseResponseVerdict(undefined)).toEqual({ decision: "withhold", reason: "" });
  });
});

describe("combineAdapters", () => {
  it("passes when every adapter passes, and when there are none", () => {
    expect(combineAdapters([])).toEqual({ deny: null, wouldDeny: [] });
    expect(
      combineAdapters([outcome("a", { decision: "pass" }), outcome("b", { decision: "pass" })]),
    ).toEqual({ deny: null, wouldDeny: [] });
  });

  it("denies on any deny, and names the first denying adapter in chain order", () => {
    const result = combineAdapters([
      outcome("a", { decision: "pass" }),
      outcome("b", { decision: "deny", reason: "off-intent" }),
      outcome("c", { decision: "deny", reason: "" }),
    ]);
    expect(result.deny).toEqual({ adapter: "b", reason: "adapter_denied", detail: "off-intent" });
  });

  it("denies when an adapter couldn't answer: never read as a pass", () => {
    const result = combineAdapters([
      outcome("a", { decision: "pass" }),
      outcome("b", { decision: "unavailable" }),
    ]);
    expect(result.deny).toEqual({ adapter: "b", reason: "adapter_unavailable", detail: null });
  });

  it("records a watching adapter's deny without deciding", () => {
    const result = combineAdapters([
      outcome("a", { decision: "deny", reason: "" }, true),
      outcome("b", { decision: "unavailable" }, true),
      outcome("c", { decision: "pass" }),
    ]);
    expect(result.deny).toBeNull();
    expect(result.wouldDeny).toEqual([
      { adapter: "a", reason: "adapter_denied", detail: null },
      { adapter: "b", reason: "adapter_unavailable", detail: null },
    ]);
  });
});

describe("adapter names", () => {
  it("accepts lowercase names and refuses anything else", () => {
    for (const name of ["intent", "openfga", "slack-vote", "a1_b"]) {
      expect(ADAPTER_NAME.test(name)).toBe(true);
    }
    for (const name of ["", "Intent", "1st", "has space", "x".repeat(41)]) {
      expect(ADAPTER_NAME.test(name)).toBe(false);
    }
  });
});
