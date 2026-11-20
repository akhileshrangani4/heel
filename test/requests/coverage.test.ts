import { describe, expect, it } from "vitest";
import { compileRulesText } from "../../src/config/rules.ts";
import { compileGrant } from "../../src/grants/compile.ts";
import { coverage } from "../../src/requests/coverage.ts";

/** Which rules and grants would cover a requested account, before the owner connects it. */

function ruleSet(text: string) {
  const owner = compileRulesText(text, "owner.yaml", "rules/owner.yaml", "owner").file;
  return { org: null, owners: new Map([["owner", owner]]) };
}

const NO_EXTRA = { grants: [], mode: "enforce" };

describe("coverage of a requested account", () => {
  it("lists allow and ask rules that name no account, and leaves out deny rules", () => {
    const set = ruleSet(`rules:
  - name: reads
    match: { kind: read }
    then: allow
  - name: no-sends
    match: { action: email.send }
    then: deny
  - name: searches
    match: { tool: { matches: "search.*" } }
    then: allow
  - name: everything-else
    match: {}
    then: ask
`);
    const { rules, mode } = coverage(
      set,
      "owner",
      "bot",
      { provider: "gmail", alias: "inbox" },
      NO_EXTRA,
    );
    expect(rules.map((r) => [r.decision, r.namesIt])).toEqual([
      ["allow", false],
      ["allow", false],
      ["ask", false],
    ]);
    expect(rules.map((r) => r.rule).join(" ")).not.toContain("no-sends");
    expect(mode).toBe("enforce");
  });

  it("counts a rule naming this account or its provider, and skips one naming another", () => {
    const set = ruleSet(`rules:
  - name: this-one
    match: { account: inbox }
    then: allow
  - name: other-one
    match: { account: work }
    then: allow
  - name: tracker
    match: { provider: "mcp:tracker" }
    then: allow
`);
    expect(
      coverage(set, "owner", "bot", { provider: "gmail", alias: "inbox" }, NO_EXTRA).rules.map(
        (r) => [r.rule.includes("this-one"), r.namesIt],
      ),
    ).toEqual([[true, true]]);
    expect(
      coverage(
        set,
        "owner",
        "bot",
        { provider: "mcp", alias: "tracker", url: "https://x.example/" },
        NO_EXTRA,
      ).rules.length,
    ).toBe(1);
  });

  it("includes the agent's grants, and says when the owner's mode is Watch", () => {
    const grant = compileGrant("{ action: email.send }", { id: "grt_1" });
    const result = coverage(
      ruleSet("rules: []\n"),
      "owner",
      "bot",
      { provider: "gmail", alias: "inbox" },
      {
        grants: [{ id: "grt_1", rule: grant.rule }],
        mode: "shadow",
      },
    );
    expect(result.rules).toEqual([{ rule: "grant grt_1", decision: "allow", namesIt: false }]);
    expect(result.mode).toBe("watch");
  });
});
