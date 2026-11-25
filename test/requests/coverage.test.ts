import { describe, expect, it } from "vitest";
import { compileRulesText } from "../../src/config/rules.ts";
import { compileGrant } from "../../src/grants/compile.ts";
import { serviceActions } from "../../src/requests/actions.ts";
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

describe("what each of a service's actions would do", () => {
  const STARTER = `rules:
  - name: reads
    match: { kind: read }
    then: allow
  - name: everything-else-asks
    match: {}
    then: ask
`;

  it("groups GitHub's real tools: reads run, everything else asks", () => {
    const { actions } = coverage(
      ruleSet(STARTER),
      "owner",
      "bot",
      { provider: "github", alias: "github" },
      { ...NO_EXTRA, actions: serviceActions("github") },
    );
    if (actions.kind !== "actions") throw new Error("expected actions");
    const by = (outcome: string) =>
      actions.actions.filter((a) => a.outcome === outcome).map((a) => a.tool);
    expect(by("allow")).toContain("list_pull_requests");
    expect(by("allow")).not.toContain("merge_pull_request");
    expect(by("ask")).toContain("merge_pull_request");
    expect(actions.actions.find((a) => a.tool === "merge_pull_request")?.risk).toBe(
      "can't be undone",
    );
    expect(actions.actions.every((a) => a.namesIt === false)).toBe(true);
  });

  it("says it depends when the deciding rule looks at the call itself, and denies with no rule", () => {
    const set = ruleSet(`rules:
  - name: vendor-mail
    match: { action: email.send, recipients: { all_domain_in: [vendor.com] } }
    then: allow
`);
    const { actions } = coverage(
      set,
      "owner",
      "bot",
      { provider: "gmail", alias: "inbox" },
      { ...NO_EXTRA, actions: serviceActions("gmail") },
    );
    if (actions.kind !== "actions") throw new Error("expected actions");
    expect(new Set(actions.actions.map((a) => a.outcome))).toEqual(new Set(["depends"]));
    const none = coverage(
      ruleSet("rules: []\n"),
      "owner",
      "bot",
      { provider: "gmail", alias: "inbox" },
      { ...NO_EXTRA, actions: serviceActions("gmail") },
    ).actions;
    if (none.kind !== "actions") throw new Error("expected actions");
    expect(none.actions.every((a) => a.outcome === "deny" && a.rule === null)).toBe(true);
  });

  it("an MCP server can't be read-only (I-20), so the starter rules ask for every call", () => {
    const { actions } = coverage(
      ruleSet(STARTER),
      "owner",
      "bot",
      { provider: "mcp", alias: "tracker", url: "https://x.example/" },
      NO_EXTRA,
    );
    expect(actions).toMatchObject({ kind: "opaque", outcome: "ask" });
  });
});
