import { describe, expect, it } from "vitest";
import { type RulesCase, RulesCasesFile, runCase } from "../../src/core/rules/cases.ts";
import type { RuleSet } from "../../src/core/rules/evaluate.ts";
import { OWNER, ruleSet } from "./helpers.ts";

/** One case, validated the way `heel rules test` validates a cases file. */
function caseOf(input: Record<string, unknown>): RulesCase {
  const [testCase] = RulesCasesFile.parse({ cases: [{ name: "case", ...input }] }).cases;
  if (testCase === undefined) throw new Error("unreachable: one case in, one case out");
  return testCase;
}

const org = `
rules:
  - name: no-rivals
    match: { recipients: { any_domain_in: [rival.com] } }
    then: deny
`;
const owner = `
rules:
  - name: trial
    match: { action: email.send }
    then: deny
    watch: true
  - name: coworkers
    match: { action: email.send, recipients: { all_domain_in: [company.com] } }
    then: allow
  - name: removals-per-run
    match: { action: email.remove, items: { over: 20, per: run } }
    then: ask
  - match: { action: email.remove }
    then: allow
  - name: merge-green
    match: { action: github.merge, checks: passing }
    then: allow
`;
const set = ruleSet({ org, owner });
const send = { agent: "inbox-bot", account: "gmail-work", action: "email.send" };

describe("runCase", () => {
  it("passes when the decision and the deciding rule match, by position or by name", () => {
    for (const rule of [2, "coworkers"]) {
      const result = runCase(
        set,
        caseOf({
          call: { ...send, recipients: ["a@company.com"] },
          expect: { decision: "allow", rule },
        }),
        OWNER,
      );
      expect(result).toEqual({
        name: "case",
        outcome: "pass",
        actual: `allow by rule 2 "coworkers" (rules/${OWNER}.yaml:7); watched rule 1 "trial" (rules/${OWNER}.yaml:3)`,
      });
    }
  });

  it("names org rules as org:<n> and the default deny as default", () => {
    const rival = caseOf({
      call: { ...send, recipients: ["x@rival.com"] },
      expect: { decision: "deny", rule: "org:1", reason: "rule" },
    });
    expect(runCase(set, rival, OWNER).outcome).toBe("pass");
    const fallthrough = caseOf({
      call: { ...send, recipients: ["x@vendor.com"] },
      expect: { decision: "deny", rule: "default", reason: "no_rule_matched" },
    });
    expect(runCase(set, fallthrough, OWNER).outcome).toBe("pass");
  });

  it("fails with what it expected and what it got", () => {
    const result = runCase(
      set,
      caseOf({
        call: { ...send, recipients: ["x@vendor.com"] },
        expect: { decision: "allow", rule: 2 },
      }),
      OWNER,
    );
    expect(result).toEqual({
      name: "case",
      outcome: "fail",
      expected: "allow, rule 2",
      actual: `deny by default; watched rule 1 "trial" (rules/${OWNER}.yaml:3)`,
    });
  });

  it("fails when the decision matches but another rule decided", () => {
    const result = runCase(
      set,
      caseOf({
        call: { ...send, recipients: ["x@rival.com"] },
        expect: { decision: "deny", rule: "default" },
      }),
      OWNER,
    );
    expect(result.outcome).toBe("fail");
  });

  it("checks the watched rules in order", () => {
    const call = { ...send, recipients: ["a@company.com"] };
    expect(
      runCase(set, caseOf({ call, expect: { decision: "allow", watched: ["trial"] } }), OWNER)
        .outcome,
    ).toBe("pass");
    expect(
      runCase(set, caseOf({ call, expect: { decision: "allow", watched: [] } }), OWNER).outcome,
    ).toBe("fail");
  });

  it("feeds counts from the case into item limits", () => {
    const removal = {
      agent: "inbox-bot",
      account: "gmail-work",
      action: "email.remove",
      run: "r1",
    };
    const at20 = caseOf({ call: removal, counts: { run: 19 }, expect: { decision: "allow" } });
    const at21 = caseOf({
      call: removal,
      counts: { run: 20 },
      expect: { decision: "ask", rule: "removals-per-run" },
    });
    expect(runCase(set, at20, OWNER).outcome).toBe("pass");
    expect(runCase(set, at21, OWNER).outcome).toBe("pass");
  });

  it("feeds state results from the case, accepting passing and failing as spellings", () => {
    const merge = { agent: "ci-bot", account: "github", action: "github.merge", repo: "acme/web" };
    const green = caseOf({
      call: merge,
      state: { checks: "passing" },
      expect: { decision: "allow" },
    });
    const red = caseOf({
      call: merge,
      state: { checks: "failing" },
      expect: { decision: "deny", rule: "default" },
    });
    const down = caseOf({
      call: merge,
      state: { checks: "unavailable" },
      expect: { decision: "deny", reason: "state_check_unavailable" },
    });
    for (const testCase of [green, red, down])
      expect(runCase(set, testCase, OWNER).outcome).toBe("pass");
  });

  it("can't run a case that reaches a state check it gives no result for", () => {
    const merge = { agent: "ci-bot", account: "github", action: "github.merge", repo: "acme/web" };
    expect(runCase(set, caseOf({ call: merge, expect: { decision: "allow" } }), OWNER)).toEqual({
      name: "case",
      outcome: "error",
      message: `the call reaches rule 5 "merge-green" (rules/${OWNER}.yaml:15), which needs state.checks; give pass, fail or unavailable`,
    });
  });

  it("can't run a case for a user with no rules file, instead of passing every expected deny", () => {
    const testCase = caseOf({ user: "bob", call: send, expect: { decision: "deny" } });
    expect(runCase(set, testCase, OWNER)).toMatchObject({
      outcome: "error",
      message: 'no rules file for user "bob"',
    });
  });

  it("needs a user when several have rules files", () => {
    const alice = set.owners.get(OWNER);
    if (alice === undefined) throw new Error("the owner file compiled above");
    const two: RuleSet = {
      org: null,
      owners: new Map([
        [OWNER, alice],
        ["bob", alice],
      ]),
    };
    const testCase = caseOf({ call: send, expect: { decision: "deny" } });
    expect(runCase(two, testCase, null)).toMatchObject({ outcome: "error" });
    expect(runCase(two, { ...testCase, user: "bob" }, null).outcome).toBe("pass");
  });

  it("runs org rules alone when no user has a rules file", () => {
    const orgOnly = ruleSet({ org });
    const testCase = caseOf({
      call: { ...send, recipients: ["x@rival.com"] },
      expect: { decision: "deny", rule: "no-rivals" },
    });
    expect(runCase(orgOnly, testCase, null).outcome).toBe("pass");
  });

  it("rejects a case file with unknown keys", () => {
    expect(() => caseOf({ call: send, expect: { decision: "deny" }, extra: true })).toThrow();
    expect(() =>
      caseOf({ call: { ...send, acount: "x" }, expect: { decision: "deny" } }),
    ).toThrow();
  });
});
