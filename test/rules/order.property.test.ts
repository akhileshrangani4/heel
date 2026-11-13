import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type Evaluation,
  effectiveDecision,
  type StandingApprovals,
} from "../../src/core/rules/evaluate.ts";
import type { RuleFacts } from "../../src/core/rules/facts.ts";
import type { Decision } from "../../src/core/rules/schema.ts";
import { facts, ruleSet, run } from "./helpers.ts";

/**
 * Properties of first-match evaluation over random rule files. Matches are
 * drawn from a small vocabulary so rules overlap often; files are emitted as
 * JSON, which YAML 1.2 reads unchanged.
 */

const ACCOUNTS = ["gmail-work", "gmail-personal"] as const;
const ACTIONS = ["email.send", "email.remove"] as const;
const RECIPIENTS = ["a@company.com", "b@company.com", "ceo@clientco.com"] as const;

const FRAGMENTS: readonly Record<string, unknown>[] = [
  { account: "gmail-work" },
  { account: "gmail-personal" },
  { action: "email.send" },
  { action: "email.remove" },
  { recipients: { any_domain_in: ["clientco.com"] } },
  { recipients: { all_domain_in: ["company.com"] } },
  { recipients: { max: 1 } },
  { agent: { one_of: ["inbox-bot", "ci-bot"] } },
];

const match = fc
  .subarray([...FRAGMENTS], { maxLength: 2 })
  .map((parts) => Object.assign({}, ...parts) as Record<string, unknown>);

interface GenRule {
  name?: string;
  match: Record<string, unknown>;
  decision: Decision;
  watch: boolean;
}

const rule = (decisions: readonly Decision[]) =>
  fc.record({ match, decision: fc.constantFrom(...decisions), watch: fc.boolean() });
const ownerRules = fc.array(rule(["allow", "ask", "deny"]), { maxLength: 6 });
const orgRules = fc.array(rule(["ask", "deny"]), { maxLength: 3 });

const callFacts = fc
  .record({
    account: fc.constantFrom(...ACCOUNTS),
    action: fc.constantFrom(...ACTIONS),
    recipients: fc.subarray([...RECIPIENTS]),
  })
  .map((fields): RuleFacts => facts(fields));

/** A generated rule in the rules file's own shape. */
function ruleEntry(r: GenRule) {
  // biome-ignore lint/suspicious/noThenProperty: `then` is the README's rules grammar.
  return { name: r.name, match: r.match, then: r.decision, watch: r.watch };
}

/** The rules file for generated rules; every file in this suite goes through here. */
function rulesFile(rules: readonly GenRule[]): string {
  return JSON.stringify({ rules: rules.map(ruleEntry) });
}

/** Rules named `<prefix><position>` so a verdict can be traced across reorderings. */
function file(rules: readonly GenRule[], prefix: string): string {
  return rulesFile(rules.map((r, i) => ({ ...r, name: `${prefix}${i}` })));
}

/** Standing approvals that cover every rule named in `names`. */
function standingOn(names: ReadonlySet<string>): StandingApprovals {
  return {
    find: (r) => {
      const name = r.ref.name;
      return name !== null && names.has(name) ? { id: name } : null;
    },
  };
}

/** What decided, independent of where the rule sits in its file. */
function outcome(evaluation: Evaluation) {
  const { verdict } = evaluation;
  return {
    decision: verdict.decision,
    rule: verdict.rule?.ref.name ?? null,
    reason: verdict.decision === "deny" ? verdict.reason : null,
    relaxed: evaluation.relaxed,
  };
}

describe("evaluation order (property)", () => {
  it("I-13: heel never allows a call an org deny matches, whatever sits around it", () => {
    fc.assert(
      fc.property(
        orgRules,
        ownerRules,
        callFacts,
        fc.boolean(),
        fc.boolean(),
        (org, owner, call, watch, approveAll) => {
          // An org deny that matches this call by construction, below random org rules.
          const deny: GenRule = {
            match: { account: call.account },
            decision: "deny",
            watch: false,
          };
          const set = ruleSet({ org: file([...org, deny], "g"), owner: file(owner, "o") });
          const everything = new Set(owner.map((_, i) => `o${i}`));
          const evaluation = run(set, call, {
            watch,
            standing: approveAll ? standingOn(everything) : standingOn(new Set()),
          });
          expect(evaluation.verdict.rule?.layer).toBe("org");
          expect(evaluation.relaxed).toBe(false);
          expect(effectiveDecision(evaluation)).not.toBe("allow");
        },
      ),
    );
  });

  it("swapping two overlapping rules with different decisions changes the outcome", () => {
    const distinctPair = fc
      .tuple(
        fc.constantFrom<Decision>("allow", "ask", "deny"),
        fc.constantFrom<Decision>("allow", "ask", "deny"),
      )
      .filter(([a, b]) => a !== b);
    fc.assert(
      fc.property(ownerRules, callFacts, distinctPair, (prefix, call, [first, second]) => {
        // Keep the random prefix from matching, so the pair decides.
        const other = ACCOUNTS.find((account) => account !== call.account);
        const inert = prefix.map((r) => ({ ...r, match: { ...r.match, account: other } }));
        const a: GenRule = { match: { account: call.account }, decision: first, watch: false };
        const b: GenRule = { match: {}, decision: second, watch: false };
        const ab = run(ruleSet({ owner: file([...inert, a, b], "o") }), call);
        const ba = run(ruleSet({ owner: file([...inert, b, a], "o") }), call);
        expect(ab.verdict.decision).toBe(first);
        expect(ba.verdict.decision).toBe(second);
      }),
    );
  });

  it("I-72: marking a rule watch: true decides exactly as if the rule were gone", () => {
    fc.assert(
      fc.property(
        orgRules,
        ownerRules.filter((rules) => rules.length > 0),
        fc.nat(),
        callFacts,
        fc.boolean(),
        (org, owner, pick, call, watch) => {
          const i = pick % owner.length;
          const target = owner[i];
          if (target === undefined) throw new Error("unreachable: index is in range");
          // Name rules once so both variants keep the same names for the survivors.
          const named = owner.map((r, n) => ({ ...r, name: `o${n}` }));
          const watched = named.map((r, n) => (n === i ? { ...r, watch: true } : r));
          const removed = named.filter((_, n) => n !== i);
          const standing = standingOn(new Set(named.map((r) => r.name)));
          const orgFile = file(org, "g");
          const withWatch = run(ruleSet({ org: orgFile, owner: rulesFile(watched) }), call, {
            watch,
            standing,
          });
          const without = run(ruleSet({ org: orgFile, owner: rulesFile(removed) }), call, {
            watch,
            standing,
          });
          expect(outcome(withWatch)).toEqual(outcome(without));
        },
      ),
    );
  });

  it("I-10: a rule set of watch rules alone denies every call", () => {
    const watchOnly = (rules: readonly GenRule[]) => rules.map((r) => ({ ...r, watch: true }));
    fc.assert(
      fc.property(orgRules, ownerRules, callFacts, (org, owner, call) => {
        const set = ruleSet({ org: file(watchOnly(org), "g"), owner: file(watchOnly(owner), "o") });
        const evaluation = run(set, call);
        expect(evaluation.verdict).toEqual({
          decision: "deny",
          rule: null,
          reason: "no_rule_matched",
        });
        expect(effectiveDecision(evaluation)).toBe("deny");
      }),
    );
  });

  it("I-71: global watch relaxes only owner-rule and default-deny outcomes", () => {
    fc.assert(
      fc.property(orgRules, ownerRules, callFacts, (org, owner, call) => {
        const set = ruleSet({ org: file(org, "g"), owner: file(owner, "o") });
        const strict = run(set, call);
        const watching = run(set, call, { watch: true });
        // Global watch changes whether the call runs, never what the rules decide.
        expect(watching.verdict).toEqual(strict.verdict);
        const { verdict } = watching;
        const ownerOrDefault = verdict.rule === null || verdict.rule.layer === "owner";
        const relaxable =
          verdict.decision !== "allow" &&
          ownerOrDefault &&
          (verdict.decision === "ask" ||
            verdict.reason === "rule" ||
            verdict.reason === "no_rule_matched");
        expect(watching.relaxed).toBe(relaxable);
        expect(effectiveDecision(watching)).toBe(relaxable ? "allow" : verdict.decision);
      }),
    );
  });
});
