import { describeRule } from "../core/rules/cases.ts";
import type { CompiledRule } from "../core/rules/compile.ts";
import { type RuleSet, rulesFor } from "../core/rules/evaluate.ts";
import { type RuleFacts, resolveField } from "../core/rules/facts.ts";
import { evalCondition } from "../core/rules/match.ts";
import type { ConnectionRequestDetails } from "../store/schema.ts";
import { mcpProvider } from "../vault/connect.ts";
import type { ServiceAction } from "./actions.ts";

/**
 * Which of the owner's rules, and the requesting agent's grants, would cover
 * a new account. Approving a connection loosens things: a rule that names no
 * account covers the new one at once. The request page lists these before
 * the passkey. Pure.
 *
 * A rule covers the account when its account and provider conditions, if it
 * has any, hold for it. Its other conditions (the action, the tool, the
 * arguments) only narrow which calls it lets through, so the page says "for
 * calls it matches" rather than guessing a verdict from a made-up call.
 * Rules that only deny are left out: they can't let anything through.
 */

export interface CoveringRule {
  /** As `heel rules test` names a rule, or "grant <id>". */
  rule: string;
  decision: "allow" | "ask";
  /** True when it names this account or provider; false when it names no account at all. */
  namesIt: boolean;
}

/**
 * What happens to one kind of call once the account is connected. `depends`
 * when the deciding rule looks at something only a real call has (its
 * arguments, action, recipients or counts), so the page can't say for sure.
 */
export type ActionOutcome = "allow" | "ask" | "deny" | "depends";

export interface ActionDecision extends ServiceAction {
  outcome: ActionOutcome;
  /** The deciding rule, as `heel rules test` names it; null when no rule matches (denied). */
  rule: string | null;
  /** The deciding rule names this account, provider or agent. */
  namesIt: boolean;
}

/**
 * Per action for a built-in service; one outcome for every call when heel
 * has no definition to tell calls apart (an MCP server is never `kind: read`, I-20).
 */
export type ActionCoverage =
  | { kind: "actions"; actions: readonly ActionDecision[] }
  | { kind: "opaque"; outcome: ActionOutcome; rule: string | null; namesIt: boolean };

export interface Coverage {
  rules: CoveringRule[];
  /** The owner's rollout mode. Watch lets calls through that rules would deny or ask about. */
  mode: "enforce" | "watch";
  actions: ActionCoverage;
}

/** Conditions that decide whether a rule can apply to this agent on this account at all. */
const SCOPE_KEYS: ReadonlySet<string> = new Set(["account", "provider", "agent"]);

function covers(rule: CompiledRule, facts: { agent: string; account: string; provider: string }) {
  const scoped = rule.conditions.filter(
    (c) => c.field.kind === "text" && SCOPE_KEYS.has(c.field.name),
  );
  const holds = scoped.every(
    (c) => evalCondition(c, resolveField({ ...facts, items: 1 }, c.field)) === true,
  );
  return { holds, namesIt: scoped.length > 0 };
}

/** Fields every call on the account has before it's made; `tool` and `kind` only with a definition. */
const ACCOUNT_KEYS: ReadonlySet<string> = new Set(["account", "provider", "agent", "kind"]);
const TOOL_KEYS: ReadonlySet<string> = new Set([...ACCOUNT_KEYS, "tool"]);

/**
 * A rule against what's known before any call: a definite false on a known
 * field means it never applies; a condition on anything else (arguments,
 * action, recipients, counts, state checks) means it depends on the call.
 */
function staticOutcome(
  rule: CompiledRule,
  facts: RuleFacts,
  known: ReadonlySet<string>,
): "match" | "no_match" | "depends" {
  let depends = rule.items !== null || rule.stateChecks.length > 0;
  for (const condition of rule.conditions) {
    if (condition.field.kind === "text" && known.has(condition.field.name)) {
      if (evalCondition(condition, resolveField(facts, condition.field)) !== true) {
        return "no_match";
      }
    } else {
      depends = true;
    }
  }
  return depends ? "depends" : "match";
}

/** The first rule that decides what's known, in evaluation order, then grants as `evaluate` applies them. */
function decideKnown(
  rules: readonly CompiledRule[],
  grants: readonly { id: string; rule: CompiledRule }[],
  facts: RuleFacts,
  known: ReadonlySet<string>,
): { outcome: ActionOutcome; rule: string | null; namesIt: boolean } {
  const scope = { agent: facts.agent, account: facts.account, provider: facts.provider ?? "" };
  let outcome: ActionOutcome = "deny";
  let decider: CompiledRule | null = null;
  for (const rule of rules) {
    if (rule.watch) continue;
    const found = staticOutcome(rule, facts, known);
    if (found === "no_match") continue;
    outcome = found === "depends" ? "depends" : rule.decision;
    decider = rule;
    break;
  }
  // Grants answer only an owner rule's ask or a call no rule covers (evaluate.ts, grantable).
  if ((outcome === "ask" && decider?.layer === "owner") || decider === null) {
    const grant = grants.find((g) => staticOutcome(g.rule, facts, known) === "match");
    if (grant !== undefined) {
      return {
        outcome: "allow",
        rule: `grant ${grant.id}`,
        namesIt: covers(grant.rule, scope).namesIt,
      };
    }
  }
  return decider === null
    ? { outcome, rule: null, namesIt: false }
    : { outcome, rule: describeRule(decider), namesIt: covers(decider, scope).namesIt };
}

export function coverage(
  set: RuleSet | null,
  owner: string,
  agent: string,
  details: ConnectionRequestDetails,
  extra: {
    grants: readonly { id: string; rule: CompiledRule }[];
    mode: string;
    /** The service's own actions (requests/actions.ts); null when heel has no definition for it. */
    actions?: readonly ServiceAction[] | null;
  },
): Coverage {
  const facts = {
    agent,
    account: details.alias,
    // An MCP account is stored, and matched by rules, as `mcp:<alias>`.
    provider: details.provider === "mcp" ? mcpProvider(details.alias) : details.provider,
  };
  const rules: CoveringRule[] = [];
  for (const rule of set === null ? [] : rulesFor(set, owner)) {
    // Deny rules can't let anything through; watch rules never decide.
    if (rule.decision === "deny" || rule.watch) continue;
    const { holds, namesIt } = covers(rule, facts);
    if (holds) rules.push({ rule: describeRule(rule), decision: rule.decision, namesIt });
  }
  for (const grant of extra.grants) {
    const { holds, namesIt } = covers(grant.rule, facts);
    if (holds) rules.push({ rule: `grant ${grant.id}`, decision: "allow", namesIt });
  }
  const ordered = set === null ? [] : rulesFor(set, owner);
  const base: RuleFacts = { ...facts, items: 1 };
  const listed = extra.actions ?? null;
  const actions: ActionCoverage =
    listed === null
      ? { kind: "opaque", ...decideKnown(ordered, extra.grants, base, ACCOUNT_KEYS) }
      : {
          kind: "actions",
          actions: listed.map((action) => ({
            ...action,
            ...decideKnown(
              ordered,
              extra.grants,
              { ...base, tool: action.tool, kind: action.read ? "read" : "write" },
              TOOL_KEYS,
            ),
          })),
        };
  return { rules, mode: extra.mode === "enforce" ? "enforce" : "watch", actions };
}
