import { z } from "zod";
import type { CliFields, HttpFields } from "../call.ts";
import type { CompiledRule, StateCheck } from "./compile.ts";
import {
  DENY_REASONS,
  evaluate,
  NO_STANDING_APPROVALS,
  type RuleSet,
  type StateOutcome,
  type Verdict,
} from "./evaluate.ts";
import type { RuleFacts } from "./facts.ts";
import { DECISIONS } from "./schema.ts";

/**
 * `heel rules test cases.yaml` (spec: Rules, "Loading, testing and reload"):
 * offline cases run against the pure evaluator with no provider access.
 * State-check results and prior counts come from the case. Pure.
 */

const StateResult = z.enum(["pass", "passing", "fail", "failing", "unavailable"]);
type StateResultInput = z.output<typeof StateResult>;

const count = z.int().nonnegative();

const CaseCall = z.strictObject({
  agent: z.string().min(1),
  account: z.string().min(1),
  provider: z.string().min(1).optional(),
  tool: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  kind: z.enum(["read", "write"]).optional(),
  recipients: z.array(z.string()).optional(),
  repo: z.string().min(1).optional(),
  items: count.default(1),
  /** The run id the agent sent. */
  run: z.string().min(1).optional(),
  args: z.unknown().optional(),
  persistence: z.boolean().optional(),
  http: z
    .strictObject({
      method: z.string().min(1),
      path: z.string().min(1),
      path_template: z.string().min(1).optional(),
      query: z.record(z.string(), z.union([z.string(), z.array(z.string())])).default({}),
      body: z.unknown().optional(),
    })
    .optional(),
  cli: z
    .strictObject({
      command: z.string().min(1),
      verb: z.string().min(1).optional(),
      subcommand: z.string().min(1).optional(),
      flags: z.record(z.string(), z.union([z.string(), z.literal(true)])).default({}),
      argv: z.array(z.string()),
    })
    .optional(),
});
type CaseCallInput = z.output<typeof CaseCall>;

/**
 * Which rule decided: a number is that rule's position in the user's file,
 * `org:<n>` a position in org-rules.yaml, `default` the default deny, and
 * any other string a rule's `name`.
 */
const RuleId = z.union([z.int().positive(), z.string().min(1)]);
type RuleIdInput = z.output<typeof RuleId>;

const Case = z.strictObject({
  name: z.string().min(1),
  /** Whose rules apply; defaults to `heel rules test --user`. */
  user: z.string().min(1).optional(),
  call: CaseCall,
  /** Items this agent already used before this call. */
  counts: z.strictObject({ run: count.optional(), hour: count.optional() }).optional(),
  state: z
    .strictObject({ checks: StateResult.optional(), all_in_thread: StateResult.optional() })
    .optional(),
  expect: z.strictObject({
    decision: z.enum(DECISIONS),
    rule: RuleId.optional(),
    reason: z.enum(DENY_REASONS).optional(),
    /** The `watch: true` rules that matched on the way, in order. */
    watched: z.array(RuleId).optional(),
  }),
});
export type RulesCase = z.output<typeof Case>;

export const RulesCasesFile = z.strictObject({ cases: z.array(Case).min(1) });

export type CaseResult =
  | { name: string; outcome: "pass"; actual: string }
  | { name: string; outcome: "fail"; expected: string; actual: string }
  /** The case can't be run as written, e.g. it reaches a state check it gives no result for. */
  | { name: string; outcome: "error"; message: string };

/** The case asks for something its own input doesn't supply. */
class CaseInputError extends Error {
  override readonly name = "CaseInputError";
}

/**
 * Runs one case. `defaultUser` is the user whose rules apply when the case
 * names none; null when there is no single obvious one.
 */
export function runCase(set: RuleSet, testCase: RulesCase, defaultUser: string | null): CaseResult {
  try {
    const owner = caseOwner(set, testCase.user ?? defaultUser);
    const evaluation = evaluate(set, {
      owner,
      facts: caseFacts(testCase.call),
      watch: false,
      state: (check, rule) => caseState(testCase, check, rule),
      counted: (_rule, per) => testCase.counts?.[per] ?? 0,
      standing: NO_STANDING_APPROVALS,
    });
    const actual = describeVerdict(
      evaluation.verdict,
      evaluation.watched.map((w) => w.rule),
    );
    const { expect } = testCase;
    const { verdict } = evaluation;
    const pass =
      verdict.decision === expect.decision &&
      (expect.rule === undefined || verdictRuleIs(verdict, expect.rule)) &&
      (expect.reason === undefined ||
        (verdict.decision === "deny" && verdict.reason === expect.reason)) &&
      (expect.watched === undefined ||
        (expect.watched.length === evaluation.watched.length &&
          expect.watched.every((id, i) => ruleIs(evaluation.watched[i]?.rule ?? null, id))));
    return pass
      ? { name: testCase.name, outcome: "pass", actual }
      : { name: testCase.name, outcome: "fail", expected: describeExpect(testCase), actual };
  } catch (error) {
    if (!(error instanceof CaseInputError)) throw error;
    return { name: testCase.name, outcome: "error", message: error.message };
  }
}

/**
 * A named user must have a rules file: a typo would otherwise run every
 * case against no rules at all and pass any case expecting a deny. With no
 * user named, an install with no owner files runs org rules alone.
 */
function caseOwner(set: RuleSet, user: string | null): string {
  if (user !== null) {
    if (!set.owners.has(user)) throw new CaseInputError(`no rules file for user "${user}"`);
    return user;
  }
  if (set.owners.size > 0) {
    throw new CaseInputError(
      `several users have rules files (${[...set.owners.keys()].join(", ")}); name one with --user or the case's user`,
    );
  }
  // No owner rules exist, so any name that has no file selects org rules alone.
  return "";
}

export function caseFacts(call: CaseCallInput): RuleFacts {
  return {
    agent: call.agent,
    account: call.account,
    items: call.items,
    ...(call.provider !== undefined && { provider: call.provider }),
    ...(call.tool !== undefined && { tool: call.tool }),
    ...(call.action !== undefined && { action: call.action }),
    ...(call.kind !== undefined && { kind: call.kind }),
    ...(call.recipients !== undefined && { recipients: call.recipients }),
    ...(call.repo !== undefined && { repo: call.repo }),
    ...(call.run !== undefined && { runId: call.run }),
    ...(call.args !== undefined && { args: call.args }),
    ...(call.persistence !== undefined && { persistence: call.persistence }),
    ...(call.http !== undefined && { http: httpFacts(call.http) }),
    ...(call.cli !== undefined && { cli: cliFacts(call.cli) }),
  };
}

function httpFacts(http: NonNullable<CaseCallInput["http"]>): HttpFields {
  return {
    method: http.method,
    path: http.path,
    query: http.query,
    ...(http.path_template !== undefined && { pathTemplate: http.path_template }),
    ...(http.body !== undefined && { body: http.body }),
  };
}

function cliFacts(cli: NonNullable<CaseCallInput["cli"]>): CliFields {
  return {
    command: cli.command,
    flags: cli.flags,
    argv: cli.argv,
    ...(cli.verb !== undefined && { verb: cli.verb }),
    ...(cli.subcommand !== undefined && { subcommand: cli.subcommand }),
  };
}

const STATE_OUTCOMES: Record<StateResultInput, StateOutcome> = {
  pass: "pass",
  passing: "pass",
  fail: "fail",
  failing: "fail",
  unavailable: "unavailable",
};

function caseState(testCase: RulesCase, check: StateCheck, rule: CompiledRule): StateOutcome {
  const given = testCase.state?.[check];
  if (given === undefined) {
    throw new CaseInputError(
      `the call reaches ${describeRule(rule)}, which needs state.${check}; give pass, fail or unavailable`,
    );
  }
  return STATE_OUTCOMES[given];
}

const ORG_RULE_ID = /^org:([1-9][0-9]*)$/;

function verdictRuleIs(verdict: Verdict, id: RuleIdInput): boolean {
  if (id === "default") return verdict.decision === "deny" && verdict.reason === "no_rule_matched";
  return ruleIs(verdict.rule, id);
}

function ruleIs(rule: CompiledRule | null, id: RuleIdInput): boolean {
  if (rule === null) return false;
  if (typeof id === "number") return rule.layer === "owner" && rule.index === id;
  const org = ORG_RULE_ID.exec(id);
  if (org !== null) return rule.layer === "org" && rule.index === Number(org[1]);
  return rule.ref.name === id;
}

export function describeRule(rule: CompiledRule): string {
  const position = rule.layer === "org" ? `org:${rule.index}` : `rule ${rule.index}`;
  const name = rule.ref.name === null ? "" : ` "${rule.ref.name}"`;
  return `${position}${name} (${rule.ref.file}:${rule.ref.line})`;
}

function describeVerdict(verdict: Verdict, watched: readonly CompiledRule[]): string {
  let text: string;
  if (verdict.decision === "deny" && verdict.rule === null) {
    text = verdict.reason === "no_rule_matched" ? "deny by default" : `deny (${verdict.reason})`;
  } else if (verdict.decision === "deny" && verdict.reason !== "rule") {
    text = `deny (${verdict.reason}) at ${describeRule(verdict.rule ?? unreachable())}`;
  } else {
    text = `${verdict.decision} by ${describeRule(verdict.rule ?? unreachable())}`;
  }
  return watched.length === 0 ? text : `${text}; watched ${watched.map(describeRule).join(", ")}`;
}

function describeExpect(testCase: RulesCase): string {
  const { decision, rule, reason, watched } = testCase.expect;
  const parts: string[] = [decision];
  if (rule !== undefined) parts.push(`rule ${String(rule)}`);
  if (reason !== undefined) parts.push(`reason ${reason}`);
  if (watched !== undefined) parts.push(`watched [${watched.map(String).join(", ")}]`);
  return parts.join(", ");
}

function unreachable(): never {
  throw new Error("a verdict that isn't a rule-less deny always names its rule");
}
