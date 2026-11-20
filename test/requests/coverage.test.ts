import { describe, expect, it } from "vitest";
import { compileRulesText } from "../../src/config/rules.ts";
import { coverage } from "../../src/requests/coverage.ts";

/** What a new account would let the requesting agent do, by heel's own evaluation. */

function ruleSet(text: string) {
  const owner = compileRulesText(text, "owner.yaml", "rules/owner.yaml", "owner").file;
  return { org: null, owners: new Map([["owner", owner]]) };
}

describe("coverage of a requested account", () => {
  it("shows that a rule naming no account covers the new one", () => {
    const set = ruleSet(`rules:
  - name: reads
    match: { kind: read }
    then: allow
  - name: everything-else
    match: {}
    then: ask
`);
    expect(coverage(set, "owner", "bot", { provider: "gmail", alias: "inbox" })).toEqual([
      { call: "a read", verdict: "allow", rule: expect.stringContaining("reads") },
      { call: "anything else", verdict: "ask", rule: expect.stringContaining("everything-else") },
    ]);
  });

  it("matches an MCP account under mcp:<alias>, and says when nothing matches", () => {
    const set = ruleSet(`rules:
  - name: tracker-reads
    match: { provider: "mcp:tracker" }
    then: allow
`);
    expect(
      coverage(set, "owner", "bot", {
        provider: "mcp",
        alias: "tracker",
        url: "https://x.example",
      }),
    ).toEqual([
      { call: "a call", verdict: "allow", rule: expect.stringContaining("tracker-reads") },
    ]);
    expect(
      coverage(set, "owner", "bot", { provider: "mcp", alias: "other", url: "https://x.example" }),
    ).toEqual([{ call: "a call", verdict: "deny", rule: null }]);
  });
});
