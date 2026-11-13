import { describe, expect, it } from "vitest";
import { YamlValidationError } from "../../src/config/yaml.ts";
import type { CompiledRule, StateCheck } from "../../src/core/rules/compile.ts";
import {
  effectiveDecision,
  type StandingApprovals,
  type StateOutcome,
} from "../../src/core/rules/evaluate.ts";
import { compileFile, facts, OWNER, oneRule, ruleSet, run } from "./helpers.ts";

/** The problems a rules file reports, as `line: message`. */
function loadErrors(yaml: string, layer: "org" | "owner"): string[] {
  try {
    compileFile(yaml, layer);
  } catch (error) {
    if (!(error instanceof YamlValidationError)) throw error;
    return error.issues.map((issue) => `${issue.line}: ${issue.message}`);
  }
  return [];
}

/** A standing-approval lookup that records what it was asked and covers the rules named. */
function standingFor(...ruleNames: string[]): StandingApprovals & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    find(rule) {
      const name = rule.ref.name ?? `#${rule.index}`;
      asked.push(name);
      return ruleNames.includes(name) ? { id: `sa_${name}` } : null;
    },
  };
}

const send = (...recipients: string[]) => facts({ action: "email.send", recipients });

describe("default deny", () => {
  it("I-10: a call that matches no rule is denied", () => {
    const set = ruleSet({ owner: oneRule("{ action: email.send }") });
    const evaluation = run(set, facts({ action: "email.remove" }));
    expect(evaluation.verdict).toEqual({ decision: "deny", rule: null, reason: "no_rule_matched" });
    expect(effectiveDecision(evaluation)).toBe("deny");
  });

  it("I-10: with no rules files at all, every call is denied", () => {
    const evaluation = run(ruleSet({}), facts({ kind: "read" }));
    expect(evaluation.verdict).toMatchObject({ decision: "deny", reason: "no_rule_matched" });
  });

  it("I-10: an owner without a rules file gets org rules alone, then the default deny", () => {
    const set = ruleSet({ org: oneRule("{ action: email.send }", "ask") });
    const evaluation = run(set, facts({ action: "email.remove" }), { owner: "bob" });
    expect(evaluation.verdict).toMatchObject({ decision: "deny", reason: "no_rule_matched" });
  });

  it("denies every call when no valid rule set has loaded since boot", () => {
    const evaluation = run(null, facts({ kind: "read" }));
    expect(evaluation.verdict).toEqual({
      decision: "deny",
      rule: null,
      reason: "rules_unavailable",
    });
  });

  it("applies only the agent owner's file, never another user's", () => {
    const set = ruleSet({ owner: oneRule("{}") });
    expect(run(set, facts(), { owner: OWNER }).verdict.decision).toBe("allow");
    expect(run(set, facts(), { owner: "mallory" }).verdict).toMatchObject({
      decision: "deny",
      reason: "no_rule_matched",
    });
  });
});

describe("first match", () => {
  const narrowFirst = `
rules:
  - name: coworkers
    match: { action: email.send, recipients: { all_domain_in: [company.com] } }
    then: allow
  - name: every-send
    match: { action: email.send }
    then: ask
`;

  it("evaluates the owner's rules top to bottom and stops at the first match", () => {
    const set = ruleSet({ owner: narrowFirst });
    const coworker = run(set, send("a@company.com"));
    expect(coworker.verdict).toMatchObject({ decision: "allow", rule: { index: 1 } });
    const client = run(set, send("ceo@clientco.com"));
    expect(client.verdict).toMatchObject({ decision: "ask", rule: { index: 2 } });
  });

  it("swapping two overlapping rules changes the outcome", () => {
    const broadFirst = `
rules:
  - match: { action: email.send }
    then: ask
  - match: { action: email.send, recipients: { all_domain_in: [company.com] } }
    then: allow
`;
    expect(run(ruleSet({ owner: broadFirst }), send("a@company.com")).verdict).toMatchObject({
      decision: "ask",
      rule: { index: 1 },
    });
  });

  it("carries the deciding rule's name, file and line for audit and the approval page", () => {
    const evaluation = run(ruleSet({ owner: narrowFirst }), send("ceo@clientco.com"));
    if (evaluation.verdict.decision !== "ask") throw new Error("expected ask");
    expect(evaluation.verdict.rule.ref).toEqual({
      name: "every-send",
      file: `rules/${OWNER}.yaml`,
      line: 6,
    });
  });

  it("checks org rules before any owner rule", () => {
    const set = ruleSet({
      org: oneRule("{ action: email.send, recipients: { any_domain_in: [clientco.com] } }", "ask"),
      owner: oneRule("{ action: email.send }", "allow"),
    });
    expect(run(set, send("ceo@clientco.com")).verdict).toMatchObject({
      decision: "ask",
      rule: { layer: "org", index: 1 },
    });
    expect(run(set, send("a@company.com")).verdict).toMatchObject({
      decision: "allow",
      rule: { layer: "owner" },
    });
  });
});

describe("org ceiling", () => {
  it("I-12: an org rule that allows is a load error at its line", () => {
    const org = `
rules:
  - match: { action: email.send }
    then: deny
  - match: { kind: read }
    then: allow
`;
    expect(loadErrors(org, "org")).toEqual(["6: org rules can only deny or ask (I-12)"]);
  });

  it("I-12: an org allow is a load error even as a watch rule", () => {
    const org = "rules:\n  - match: {}\n    then: allow\n    watch: true\n";
    expect(loadErrors(org, "org")).toEqual(["3: org rules can only deny or ask (I-12)"]);
  });

  it("allows deny and ask in org rules, and allow in owner rules", () => {
    expect(loadErrors(oneRule("{}", "deny"), "org")).toEqual([]);
    expect(loadErrors(oneRule("{}", "ask"), "org")).toEqual([]);
    expect(loadErrors(oneRule("{}", "allow"), "owner")).toEqual([]);
  });

  it("I-13: an org deny beats owner allows, standing approvals and both watch modes", () => {
    const set = ruleSet({
      org: oneRule("{ recipients: { any_domain_in: [rival.com] } }", "deny"),
      owner: `
rules:
  - name: watched-allow
    match: { action: email.send }
    then: allow
    watch: true
  - name: sends
    match: { action: email.send }
    then: ask
  - match: {}
    then: allow
`,
    });
    const standing = standingFor("sends");
    const evaluation = run(set, send("spy@rival.com"), { standing, watch: true });
    expect(evaluation.verdict).toMatchObject({
      decision: "deny",
      reason: "rule",
      rule: { layer: "org" },
    });
    expect(evaluation.relaxed).toBe(false);
    expect(effectiveDecision(evaluation)).toBe("deny");
    expect(standing.asked).toEqual([]);
  });

  it("I-13: an org ask is never satisfied by a standing approval", () => {
    const set = ruleSet({
      org: "rules:\n  - name: org-sends\n    match: { action: email.send }\n    then: ask\n",
    });
    const standing = standingFor("org-sends");
    const evaluation = run(set, send("a@company.com"), { standing });
    expect(evaluation.verdict).toMatchObject({ decision: "ask", rule: { layer: "org" } });
    expect(standing.asked).toEqual([]);
  });
});

describe("standing approvals", () => {
  const owner = `
rules:
  - name: no-rivals
    match: { action: email.send, recipients: { any_domain_in: [rival.com] } }
    then: deny
  - name: sends
    match: { action: email.send }
    then: ask
`;

  it("turn their parent rule's ask into allow", () => {
    const evaluation = run(ruleSet({ owner }), send("bob@vendor.com"), {
      standing: standingFor("sends"),
    });
    expect(evaluation.verdict).toMatchObject({
      decision: "allow",
      rule: { ref: { name: "sends" } },
      standingApprovalId: "sa_sends",
    });
  });

  it("can't get past a deny above their parent rule", () => {
    const standing = standingFor("sends");
    const evaluation = run(ruleSet({ owner }), send("spy@rival.com"), { standing });
    expect(evaluation.verdict).toMatchObject({
      decision: "deny",
      rule: { ref: { name: "no-rivals" } },
    });
    expect(standing.asked).toEqual([]);
  });

  it("are looked up only for the rule that matched and asks", () => {
    const standing = standingFor();
    run(ruleSet({ owner }), send("bob@vendor.com"), { standing });
    expect(standing.asked).toEqual(["sends"]);
    run(ruleSet({ owner }), facts({ action: "email.remove" }), { standing });
    expect(standing.asked).toEqual(["sends"]);
  });
});

describe("state checks", () => {
  const owner = `
rules:
  - name: merge-green
    match: { action: github.merge, repo: { one_of: [acme/web] }, checks: passing }
    then: allow
  - name: merge-ask
    match: { action: github.merge }
    then: ask
  - match: {}
    then: allow
`;
  const merge = (repo: string) => facts({ account: "github", action: "github.merge", repo });

  function lookups(result: StateOutcome) {
    const calls: { check: StateCheck; rule: string | null }[] = [];
    return {
      calls,
      state: (check: StateCheck, rule: CompiledRule) => {
        calls.push({ check, rule: rule.ref.name });
        return result;
      },
    };
  }

  it("pass lets the rule decide", () => {
    const { state, calls } = lookups("pass");
    expect(run(ruleSet({ owner }), merge("acme/web"), { state }).verdict).toMatchObject({
      decision: "allow",
      rule: { ref: { name: "merge-green" } },
    });
    expect(calls).toEqual([{ check: "checks", rule: "merge-green" }]);
  });

  it("fail makes the rule not match, so evaluation goes on", () => {
    const { state } = lookups("fail");
    expect(run(ruleSet({ owner }), merge("acme/web"), { state }).verdict).toMatchObject({
      decision: "ask",
      rule: { ref: { name: "merge-ask" } },
    });
  });

  it("a failed lookup denies the call instead of falling through to a broader rule", () => {
    const { state } = lookups("unavailable");
    expect(run(ruleSet({ owner }), merge("acme/web"), { state }).verdict).toMatchObject({
      decision: "deny",
      reason: "state_check_unavailable",
      rule: { ref: { name: "merge-green" } },
    });
  });

  it("runs only for a rule whose plain conditions already match", () => {
    const { state, calls } = lookups("pass");
    run(ruleSet({ owner }), merge("acme/docs"), { state });
    expect(calls).toEqual([]);
  });

  it("I-23: a state check on a service with no built-in definition is a load error", () => {
    expect(
      loadErrors(oneRule("{ provider: notion, action: github.merge, checks: passing }"), "owner"),
    ).toEqual(["2: checks is a state check heel has only on github (I-23)"]);
    expect(
      loadErrors(
        oneRule("{ action: linear.comment, recipients: { all_in_thread: true } }"),
        "owner",
      ),
    ).toEqual([
      "2: all_in_thread is a state check heel has only for action email.send; name that action in this rule (I-23)",
    ]);
  });

  it("I-23: a state check on a rule that doesn't pin the service is a load error", () => {
    expect(loadErrors(oneRule("{ tool: merge_pull_request, checks: passing }"), "owner")).toEqual([
      "2: checks is a state check heel has only for action github.merge; name that action in this rule (I-23)",
    ]);
    expect(
      loadErrors(oneRule('{ action: { matches: "github\\\\..*" }, checks: passing }'), "owner"),
    ).toEqual([
      "2: checks is a state check heel has only for action github.merge; name that action in this rule (I-23)",
    ]);
    expect(
      loadErrors(
        oneRule(
          "{ action: { one_of: [email.send, slack.post] }, recipients: { all_in_thread: true } }",
        ),
        "owner",
      ),
    ).toHaveLength(1);
  });

  it("loads state checks pinned to the services that have them", () => {
    expect(
      loadErrors(oneRule("{ action: github.merge, provider: github, checks: passing }"), "owner"),
    ).toEqual([]);
    expect(
      loadErrors(
        oneRule(
          "{ action: email.send, provider: { one_of: [gmail, outlook] }, recipients: { all_in_thread: true } }",
        ),
        "owner",
      ),
    ).toEqual([]);
  });
});

describe("item counts", () => {
  const owner = `
rules:
  - name: run-limit
    match: { action: email.remove, items: { over: 20, per: run } }
    then: ask
  - name: hour-limit
    match: { action: email.remove, items: { over: 100, per: hour } }
    then: ask
  - name: batch-limit
    match: { action: email.remove, items: { over: 500 } }
    then: ask
  - name: removes
    match: { action: email.remove }
    then: allow
`;
  const remove = (items: number, runId?: string) =>
    facts({ action: "email.remove", items, ...(runId === undefined ? {} : { runId }) });
  const counted =
    (run: number, hour: number) =>
    (_rule: CompiledRule, per: "run" | "hour"): number =>
      per === "run" ? run : hour;
  const decidedBy = (evaluation: ReturnType<typeof run>) =>
    evaluation.verdict.rule?.ref.name ?? null;

  it("a count includes the call being checked", () => {
    expect(decidedBy(run(ruleSet({ owner }), remove(1, "r1"), { counted: counted(20, 20) }))).toBe(
      "run-limit",
    );
    expect(decidedBy(run(ruleSet({ owner }), remove(1, "r1"), { counted: counted(19, 19) }))).toBe(
      "removes",
    );
  });

  it("counts items, not calls", () => {
    expect(decidedBy(run(ruleSet({ owner }), remove(21, "r1")))).toBe("run-limit");
  });

  it("a call without a run id never matches a per-run limit, and falls to the hourly one", () => {
    const evaluation = run(ruleSet({ owner }), remove(1), { counted: counted(500, 100) });
    expect(decidedBy(evaluation)).toBe("hour-limit");
  });

  it("a limit without per looks at this call's items alone", () => {
    const set = ruleSet({
      owner: oneRule("{ action: email.remove, items: { over: 500 } }", "ask"),
    });
    const counted = (_rule: CompiledRule, per: "run" | "hour"): number => {
      throw new Error(`unexpected count lookup per ${per}`);
    };
    expect(run(set, remove(501, "r1"), { counted }).verdict.decision).toBe("ask");
    expect(run(set, remove(500, "r1"), { counted }).verdict).toMatchObject({
      decision: "deny",
      reason: "no_rule_matched",
    });
  });

  it("asks the store for the window of the rule being checked", () => {
    const asked: [string | null, string][] = [];
    run(ruleSet({ owner }), remove(1, "r1"), {
      counted: (rule, per) => {
        asked.push([rule.ref.name, per]);
        return 0;
      },
    });
    expect(asked).toEqual([
      ["run-limit", "run"],
      ["hour-limit", "hour"],
    ]);
  });
});

describe("persistence calls", () => {
  const forwarding = facts({
    action: "email.forwarding.create",
    tool: "create_forwarding_address",
    persistence: true,
  });

  it("are denied under a broad allow that doesn't name them", () => {
    expect(run(ruleSet({ owner: oneRule("{ account: gmail-work }") }), forwarding).verdict).toEqual(
      {
        decision: "deny",
        rule: null,
        reason: "persistence_unnamed",
      },
    );
  });

  it("run when a rule names the action", () => {
    expect(
      run(ruleSet({ owner: oneRule("{ action: email.forwarding.create }") }), forwarding).verdict
        .decision,
    ).toBe("allow");
  });

  it("run when a rule names the tool", () => {
    expect(
      run(
        ruleSet({ owner: oneRule("{ tool: { one_of: [create_forwarding_address] } }") }),
        forwarding,
      ).verdict.decision,
    ).toBe("allow");
  });

  it("skip a broad ask above the rule that names them", () => {
    const owner = `
rules:
  - match: { account: gmail-work }
    then: ask
  - match: { action: email.forwarding.create }
    then: allow
`;
    expect(run(ruleSet({ owner }), forwarding).verdict).toMatchObject({
      decision: "allow",
      rule: { index: 2 },
    });
  });

  it("can still be denied by a broad deny", () => {
    const owner = `
rules:
  - match: { account: gmail-work }
    then: deny
  - match: { action: email.forwarding.create }
    then: allow
`;
    expect(run(ruleSet({ owner }), forwarding).verdict).toMatchObject({
      decision: "deny",
      reason: "rule",
      rule: { index: 1 },
    });
  });

  it("aren't admitted by a watch rule that names them", () => {
    const owner = `
rules:
  - match: { action: email.forwarding.create }
    then: allow
    watch: true
  - match: {}
    then: allow
`;
    expect(run(ruleSet({ owner }), forwarding).verdict).toMatchObject({
      decision: "deny",
      reason: "persistence_unnamed",
    });
  });
});
