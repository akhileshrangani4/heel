import { describe, expect, it } from "vitest";
import type { CompiledRule } from "../../src/core/rules/compile.ts";
import { effectiveDecision, type StandingApprovals } from "../../src/core/rules/evaluate.ts";
import { facts, oneRule, ruleSet, run } from "./helpers.ts";

const send = (...recipients: string[]) => facts({ action: "email.send", recipients });
const watchedNames = (evaluation: ReturnType<typeof run>) =>
  evaluation.watched.map(({ rule, wouldDecide }) => `${rule.ref.name}:${wouldDecide}`);

describe("per-rule watch: true", () => {
  it("I-72: a watched allow never lets a call through", () => {
    const owner = "rules:\n  - name: try-allow\n    match: {}\n    then: allow\n    watch: true\n";
    const evaluation = run(ruleSet({ owner }), send("a@company.com"));
    expect(evaluation.verdict).toEqual({ decision: "deny", rule: null, reason: "no_rule_matched" });
    expect(effectiveDecision(evaluation)).toBe("deny");
    expect(watchedNames(evaluation)).toEqual(["try-allow:allow"]);
  });

  it("I-72: a watched deny never blocks a call", () => {
    const owner = `
rules:
  - name: try-deny
    match: { action: email.send }
    then: deny
    watch: true
  - name: sends
    match: { action: email.send }
    then: allow
`;
    const evaluation = run(ruleSet({ owner }), send("a@company.com"));
    expect(evaluation.verdict).toMatchObject({
      decision: "allow",
      rule: { ref: { name: "sends" } },
    });
    expect(watchedNames(evaluation)).toEqual(["try-deny:deny"]);
  });

  it("I-72: a watched ask creates no request and consults no standing approval", () => {
    const owner = `
rules:
  - name: try-ask
    match: { action: email.send }
    then: ask
    watch: true
  - match: {}
    then: allow
`;
    const asked: string[] = [];
    const standing: StandingApprovals = {
      find(rule: CompiledRule) {
        asked.push(rule.ref.name ?? "");
        return { id: "sa_1" };
      },
    };
    const evaluation = run(ruleSet({ owner }), send("a@company.com"), { standing });
    expect(evaluation.verdict).toMatchObject({ decision: "allow", standingApprovalId: null });
    expect(asked).toEqual([]);
    expect(watchedNames(evaluation)).toEqual(["try-ask:ask"]);
  });

  it("I-72: a watched org deny never decides either", () => {
    const org = "rules:\n  - name: org-trial\n    match: {}\n    then: deny\n    watch: true\n";
    const evaluation = run(ruleSet({ org, owner: oneRule("{}") }), send("a@company.com"));
    expect(evaluation.verdict.decision).toBe("allow");
    expect(watchedNames(evaluation)).toEqual(["org-trial:deny"]);
  });

  it("I-72: a watched rule whose state lookup fails doesn't deny the call", () => {
    const owner = `
rules:
  - name: try-merge
    match: { action: github.merge, checks: passing }
    then: allow
    watch: true
  - match: { action: github.merge }
    then: ask
`;
    const evaluation = run(
      ruleSet({ owner }),
      facts({ action: "github.merge", repo: "acme/web" }),
      {
        state: () => "unavailable",
      },
    );
    expect(evaluation.verdict.decision).toBe("ask");
    expect(evaluation.watched).toEqual([]);
  });

  it("records only the watched rules that matched, in evaluation order", () => {
    const org = "rules:\n  - name: org-w\n    match: {}\n    then: ask\n    watch: true\n";
    const owner = `
rules:
  - name: w-removes
    match: { action: email.remove }
    then: deny
    watch: true
  - name: w-sends
    match: { action: email.send }
    then: deny
    watch: true
  - name: sends
    match: { action: email.send }
    then: ask
  - name: w-after
    match: {}
    then: deny
    watch: true
`;
    const evaluation = run(ruleSet({ org, owner }), send("a@company.com"));
    expect(evaluation.verdict).toMatchObject({ decision: "ask", rule: { ref: { name: "sends" } } });
    // Evaluation stops at the deciding rule, so a watched rule below it isn't reached.
    expect(watchedNames(evaluation)).toEqual(["org-w:ask", "w-sends:deny"]);
  });
});

describe("global watch (heel serve --watch)", () => {
  const owner = `
rules:
  - name: no-clients
    match: { action: email.send, recipients: { any_domain_in: [clientco.com] } }
    then: deny
  - name: vendor-ask
    match: { action: email.send, recipients: { any_domain_in: [vendor.com] } }
    then: ask
  - name: coworkers
    match: { action: email.send, recipients: { all_domain_in: [company.com] } }
    then: allow
`;
  const watching = { watch: true } as const;

  it("I-71: lets an owner deny run and logs it as a would-be deny", () => {
    const evaluation = run(ruleSet({ owner }), send("ceo@clientco.com"), watching);
    expect(evaluation.verdict).toMatchObject({ decision: "deny", reason: "rule" });
    expect(evaluation.relaxed).toBe(true);
    expect(effectiveDecision(evaluation)).toBe("allow");
  });

  it("I-71: lets an owner ask run, so no pending request is created", () => {
    const evaluation = run(ruleSet({ owner }), send("bob@vendor.com"), watching);
    expect(evaluation.verdict.decision).toBe("ask");
    expect(evaluation.relaxed).toBe(true);
    expect(effectiveDecision(evaluation)).toBe("allow");
  });

  it("I-71: lets the default deny run", () => {
    const evaluation = run(ruleSet({ owner }), facts({ action: "email.remove" }), watching);
    expect(evaluation.verdict).toMatchObject({ decision: "deny", reason: "no_rule_matched" });
    expect(effectiveDecision(evaluation)).toBe("allow");
  });

  it("I-71: never relaxes an org deny or an org ask", () => {
    const deny = run(
      ruleSet({ org: oneRule("{ action: email.send }", "deny"), owner }),
      send("a@company.com"),
      watching,
    );
    expect(deny.relaxed).toBe(false);
    expect(effectiveDecision(deny)).toBe("deny");
    const ask = run(
      ruleSet({ org: oneRule("{ action: email.send }", "ask"), owner }),
      send("a@company.com"),
      watching,
    );
    expect(ask.relaxed).toBe(false);
    expect(effectiveDecision(ask)).toBe("ask");
  });

  it("I-71: never relaxes a persistence call no rule names", () => {
    const forwarding = facts({ action: "email.forwarding.create", persistence: true });
    const evaluation = run(ruleSet({ owner }), forwarding, watching);
    expect(evaluation.verdict).toMatchObject({ reason: "persistence_unnamed" });
    expect(effectiveDecision(evaluation)).toBe("deny");
  });

  it("I-71: never relaxes the fail-closed denies", () => {
    const unparseable = run(ruleSet({ owner }), send("not an address"), watching);
    expect(unparseable.verdict).toMatchObject({ reason: "address_unparseable" });
    expect(effectiveDecision(unparseable)).toBe("deny");

    const merge = oneRule("{ action: github.merge, checks: passing }");
    const unavailable = run(ruleSet({ owner: merge }), facts({ action: "github.merge" }), {
      ...watching,
      state: () => "unavailable",
    });
    expect(unavailable.verdict).toMatchObject({ reason: "state_check_unavailable" });
    expect(effectiveDecision(unavailable)).toBe("deny");

    const noRules = run(null, send("a@company.com"), watching);
    expect(noRules.verdict).toMatchObject({ reason: "rules_unavailable" });
    expect(effectiveDecision(noRules)).toBe("deny");
  });

  it("marks an allowed call as not relaxed", () => {
    const evaluation = run(ruleSet({ owner }), send("a@company.com"), watching);
    expect(evaluation.verdict.decision).toBe("allow");
    expect(evaluation.relaxed).toBe(false);
  });

  it("relaxes nothing when global watch is off", () => {
    const evaluation = run(ruleSet({ owner }), send("ceo@clientco.com"));
    expect(evaluation.relaxed).toBe(false);
    expect(effectiveDecision(evaluation)).toBe("deny");
  });
});
