import { describe, expect, it } from "vitest";
import { REASON_MAX_CHARS, takeReason, withReason } from "../../src/gateway/mcp/names.ts";

/** heel_reason: the agent's own words, shown to the approver and kept out of the call. */

describe("withReason", () => {
  it("adds heel_reason beside the tool's own properties and leaves the rest alone", () => {
    const schema = withReason({
      type: "object",
      properties: { to: { type: "string" } },
      required: ["to"],
      additionalProperties: false,
    });
    expect(Object.keys(schema.properties ?? {})).toEqual(["to", "heel_reason"]);
    expect(schema.required).toEqual(["to"]);
    expect(schema["additionalProperties"]).toBe(false);
  });

  it("works on a schema with no properties", () => {
    expect(Object.keys(withReason({ type: "object" }).properties ?? {})).toEqual(["heel_reason"]);
  });
});

describe("takeReason", () => {
  it("returns the arguments untouched when there's no reason", () => {
    const args = { id: "n1" };
    expect(takeReason(args)).toEqual({ args, reason: undefined });
  });

  it("trims the reason and removes it from the arguments", () => {
    expect(takeReason({ id: "n1", heel_reason: "  because  " })).toEqual({
      args: { id: "n1" },
      reason: "because",
    });
  });

  it("drops a blank or non-string reason without forwarding it", () => {
    expect(takeReason({ id: "n1", heel_reason: "   " })).toEqual({
      args: { id: "n1" },
      reason: undefined,
    });
    expect(takeReason({ id: "n1", heel_reason: { nested: true } })).toEqual({
      args: { id: "n1" },
      reason: undefined,
    });
  });

  it(`caps a reason at ${REASON_MAX_CHARS} characters`, () => {
    const { reason } = takeReason({ heel_reason: "x".repeat(REASON_MAX_CHARS + 50) });
    expect(reason).toHaveLength(REASON_MAX_CHARS);
  });
});
