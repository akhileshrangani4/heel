import { normalizeAddress } from "./address.ts";
import type { CompiledHideEntry, CompiledRule, CompiledRulesFile, StateCheck } from "./compile.ts";
import { type RuleFacts, resolveField } from "./facts.ts";
import { allOf, evalCondition, type Outcome } from "./match.ts";
import type { Decision } from "./schema.ts";

/**
 * First-match evaluation (spec: Rules, "Files and layers"): org rules, then
 * the agent owner's rules top to bottom, each standing approval checked just
 * above the rule that asked for it; no match denies (I-10). Pure: counts,
 * state lookups and standing approvals come in through the context.
 *
 * Pause and the hard denies heel applies without rules (credential-printing
 * commands, hidden targets, unexpandable batches) run before this in the
 * pipeline, so global watch, which is applied only here, can't relax them.
 */

/** Every rule file in force: the org file and each user's file, by user name. */
export interface RuleSet {
  org: CompiledRulesFile | null;
  owners: ReadonlyMap<string, CompiledRulesFile>;
}

export type StateOutcome = "pass" | "fail" | "unavailable";

/** D4b fills this in from `standing_approvals`. */
export interface StandingApprovals {
  /**
   * A live standing approval of this agent's that covers this call under
   * `rule`, or null. Asked only when `rule` is an owner rule that matched
   * and would ask, so it can only turn that ask into allow (I-15).
   */
  find(rule: CompiledRule, facts: RuleFacts): { id: string } | null;
}

export const NO_STANDING_APPROVALS: StandingApprovals = { find: () => null };

export interface EvalContext {
  /** The agent owner's user name; their rules file applies. */
  owner: string;
  facts: RuleFacts;
  /** `heel serve --watch` (I-71 as amended). */
  watch: boolean;
  /** A state check's result for this call, under the rule that names it. */
  state(check: StateCheck, rule: CompiledRule): StateOutcome;
  /**
   * Items this agent already used in the window (`run` uses `facts.runId`),
   * from calls whose stored facts match `rule`'s plain conditions; this
   * call's items are added here (I-24).
   */
  counted(rule: CompiledRule, per: "run" | "hour"): number;
  standing: StandingApprovals;
}

export const DENY_REASONS = [
  /** A deny rule matched. */
  "rule",
  /** I-10: nothing matched. */
  "no_rule_matched",
  /** No valid rule set has loaded since boot. */
  "rules_unavailable",
  /** I-70: a persistence call that no rule names. */
  "persistence_unnamed",
  /** An address in the call doesn't parse. */
  "address_unparseable",
  /** A state lookup failed for a rule that would otherwise match. */
  "state_check_unavailable",
] as const;
export type DenyReason = (typeof DENY_REASONS)[number];

export type Verdict =
  | { decision: "allow"; rule: CompiledRule; standingApprovalId: string | null }
  | { decision: "ask"; rule: CompiledRule }
  | { decision: "deny"; rule: CompiledRule | null; reason: DenyReason };

export interface WatchedRule {
  rule: CompiledRule;
  wouldDecide: Decision;
}

export interface Evaluation {
  /** What the rules decide. */
  verdict: Verdict;
  /**
   * Global watch let the call run although `verdict` denies or asks: heel
   * logs it as "would deny" or "would ask" and creates no pending request.
   */
  relaxed: boolean;
  /** `watch: true` rules that matched on the way, in order. They never decide (I-72). */
  watched: readonly WatchedRule[];
}

/** What heel does with the call. */
export function effectiveDecision(evaluation: Evaluation): Decision {
  return evaluation.relaxed ? "allow" : evaluation.verdict.decision;
}

/** The rules that apply to an agent owned by `owner`, in evaluation order. */
export function rulesFor(set: RuleSet, owner: string): readonly CompiledRule[] {
  return [...(set.org?.rules ?? []), ...(set.owners.get(owner)?.rules ?? [])];
}

/** Hide entries for an account: the org file's and the account owner's (spec: Hiding). */
export function hideEntriesFor(set: RuleSet, accountOwner: string): readonly CompiledHideEntry[] {
  return [...(set.org?.hide ?? []), ...(set.owners.get(accountOwner)?.hide ?? [])];
}

export function evaluate(set: RuleSet | null, ctx: EvalContext): Evaluation {
  const watched: WatchedRule[] = [];
  const done = (verdict: Verdict): Evaluation => ({
    verdict,
    relaxed: ctx.watch && relaxable(verdict),
    watched,
  });

  if (set === null) return done({ decision: "deny", rule: null, reason: "rules_unavailable" });
  const { facts } = ctx;
  if (facts.recipients?.some((address) => normalizeAddress(address) === null)) {
    return done({ decision: "deny", rule: null, reason: "address_unparseable" });
  }

  const rules = rulesFor(set, ctx.owner);
  if (facts.persistence === true && !rules.some((rule) => !rule.watch && names(rule, facts))) {
    return done({ decision: "deny", rule: null, reason: "persistence_unnamed" });
  }

  for (const rule of rules) {
    // A broad rule can deny a persistence call but never admit it (I-70).
    if (facts.persistence === true && rule.decision !== "deny" && !names(rule, facts)) continue;
    const outcome = ruleOutcome(rule, ctx);
    if (rule.watch) {
      if (outcome === "match") watched.push({ rule, wouldDecide: rule.decision });
      continue;
    }
    switch (outcome) {
      case "no_match":
        continue;
      case "unparseable":
        return done({ decision: "deny", rule, reason: "address_unparseable" });
      case "unavailable":
        return done({ decision: "deny", rule, reason: "state_check_unavailable" });
      case "match":
        return done(decide(rule, ctx));
    }
  }
  return done({ decision: "deny", rule: null, reason: "no_rule_matched" });
}

function decide(rule: CompiledRule, ctx: EvalContext): Verdict {
  switch (rule.decision) {
    case "allow":
      return { decision: "allow", rule, standingApprovalId: null };
    case "deny":
      return { decision: "deny", rule, reason: "rule" };
    case "ask": {
      // Org asks are approved once by an admin and never stand (Q-A7).
      const standing = rule.layer === "owner" ? ctx.standing.find(rule, ctx.facts) : null;
      return standing === null
        ? { decision: "ask", rule }
        : { decision: "allow", rule, standingApprovalId: standing.id };
    }
  }
}

/**
 * Global watch relaxes only outcomes of the owner's own rules and the
 * default deny. Org rules are the admin's ceiling, and the fail-closed
 * denies mean heel couldn't decide safely; both still hold (Q-W1).
 */
function relaxable(verdict: Verdict): boolean {
  if (verdict.decision === "allow") return false;
  if (verdict.decision === "ask") return verdict.rule.layer === "owner";
  if (verdict.reason === "no_rule_matched") return true;
  return verdict.reason === "rule" && verdict.rule?.layer === "owner";
}

function names(rule: CompiledRule, facts: RuleFacts): boolean {
  return (
    (facts.action !== undefined && rule.names.actions.has(facts.action)) ||
    (facts.tool !== undefined && rule.names.tools.has(facts.tool))
  );
}

/** The rule's plain conditions on one call's facts; D3 also filters count history with it. */
export function plainMatch(rule: CompiledRule, facts: RuleFacts): Outcome {
  return allOf(
    rule.conditions.map((condition) =>
      evalCondition(condition, resolveField(facts, condition.field)),
    ),
  );
}

type RuleOutcome = "match" | "no_match" | "unparseable" | "unavailable";

/**
 * Conditions are ANDed, so a definite false anywhere means no match. Only
 * when nothing is false does an unreadable address or a failed lookup
 * matter, and then the call is denied rather than the condition read as
 * false, which would let a broader rule below match (spec: Counts and state
 * checks). State lookups run last, so heel reads a provider only for a rule
 * that would otherwise match.
 */
function ruleOutcome(rule: CompiledRule, ctx: EvalContext): RuleOutcome {
  const plain = plainMatch(rule, ctx.facts);
  if (plain === false) return "no_match";
  if (!itemsHold(rule, ctx)) return "no_match";
  if (plain === "unparseable") return "unparseable";
  let unavailable = false;
  for (const check of rule.stateChecks) {
    const result = ctx.state(check, rule);
    if (result === "fail") return "no_match";
    if (result === "unavailable") unavailable = true;
  }
  return unavailable ? "unavailable" : "match";
}

/** `items: { over: N, per? }` holds when the items counted exceed N (I-24, I-25, I-26). */
function itemsHold(rule: CompiledRule, ctx: EvalContext): boolean {
  const { items } = rule;
  if (items === null) return true;
  const { facts } = ctx;
  if (items.per === null) return facts.items > items.over;
  // A call without a run id never matches a per-run limit (I-26).
  if (items.per === "run" && facts.runId === undefined) return false;
  return ctx.counted(rule, items.per) + facts.items > items.over;
}
