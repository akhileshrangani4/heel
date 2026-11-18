import { describe, expect, it } from "vitest";
import { parseStoredFacts, storedFacts } from "../../src/core/counts.ts";

/** Count events keep every field a count condition can name, so history matches like the call did. */

describe("stored facts", () => {
  it("keep calendar and provider fields through a round trip", () => {
    const facts = storedFacts({
      agent: "bot",
      account: "slack",
      items: 1,
      calendar: "team@example.com",
      fields: { channel: "C0123", external: true, amount: 500 },
    });
    expect(parseStoredFacts(JSON.parse(JSON.stringify(facts)))).toEqual(facts);
  });

  it("refuse a provider field heel doesn't know", () => {
    expect(parseStoredFacts({ agent: "bot", account: "x", fields: { nope: 1 } })).toBeNull();
  });
});
