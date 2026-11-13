import { compileRulesText } from "../../src/config/rules.ts";
import type { CompiledRulesFile, Layer } from "../../src/core/rules/compile.ts";
import {
  type EvalContext,
  type Evaluation,
  effectiveDecision,
  evaluate,
  NO_STANDING_APPROVALS,
  type RuleSet,
} from "../../src/core/rules/evaluate.ts";
import type { RuleFacts } from "../../src/core/rules/facts.ts";
import type { Decision } from "../../src/core/rules/schema.ts";

/** The user whose rules file the helpers build; agents in these tests belong to them. */
export const OWNER = "alice";

export function displayFor(layer: Layer): string {
  return layer === "org" ? "org-rules.yaml" : `rules/${OWNER}.yaml`;
}

/** Compiles one rules file from YAML text; throws YamlValidationError when it's invalid. */
export function compileFile(yaml: string, layer: Layer): CompiledRulesFile {
  const display = displayFor(layer);
  return compileRulesText(yaml, `/heel/${display}`, display, layer).file;
}

export function ruleSet(files: { org?: string; owner?: string }): RuleSet {
  return {
    org: files.org === undefined ? null : compileFile(files.org, "org"),
    owners: new Map(
      files.owner === undefined ? [] : [[OWNER, compileFile(files.owner, "owner")] as const],
    ),
  };
}

/** A rules file holding one rule. `match` is YAML flow text, e.g. `{ action: email.send }`. */
export function oneRule(match: string, then: Decision = "allow"): string {
  return `rules:\n  - match: ${match}\n    then: ${then}\n`;
}

export function facts(overrides: Partial<RuleFacts> = {}): RuleFacts {
  return { agent: "inbox-bot", account: "gmail-work", items: 1, ...overrides };
}

/**
 * Evaluates with nothing counted and no standing approvals. A state lookup
 * the test didn't supply fails the test, so none happens by accident.
 */
export function run(
  set: RuleSet | null,
  callFacts: RuleFacts,
  ctx: Partial<Omit<EvalContext, "facts">> = {},
): Evaluation {
  return evaluate(set, {
    owner: OWNER,
    facts: callFacts,
    watch: false,
    state: (check) => {
      throw new Error(`unexpected state lookup: ${check}`);
    },
    counted: () => 0,
    standing: NO_STANDING_APPROVALS,
    ...ctx,
  });
}

/** What heel does with the call under a one-rule owner file that allows on `match`. */
export function allowedBy(match: string, callFacts: RuleFacts): boolean {
  return effectiveDecision(run(ruleSet({ owner: oneRule(match) }), callFacts)) === "allow";
}
