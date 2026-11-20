import { describeRule } from "../core/rules/cases.ts";
import type { CompiledRule } from "../core/rules/compile.ts";
import { type RuleSet, rulesFor } from "../core/rules/evaluate.ts";
import { resolveField } from "../core/rules/facts.ts";
import { evalCondition } from "../core/rules/match.ts";
import type { ConnectionRequestDetails } from "../store/schema.ts";
import { mcpProvider } from "../vault/connect.ts";

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

export interface Coverage {
  rules: CoveringRule[];
  /** The owner's rollout mode. Watch lets calls through that rules would deny or ask about. */
  mode: "enforce" | "watch";
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

export function coverage(
  set: RuleSet | null,
  owner: string,
  agent: string,
  details: ConnectionRequestDetails,
  extra: { grants: readonly { id: string; rule: CompiledRule }[]; mode: string },
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
  return { rules, mode: extra.mode === "enforce" ? "enforce" : "watch" };
}
