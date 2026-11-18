import { parse } from "yaml";
import { compileRulesText } from "../config/rules.ts";
import { YamlValidationError } from "../config/yaml.ts";
import type { CompiledRule } from "../core/rules/compile.ts";

/**
 * Intent grants (A4b; Nov 17 decision 3): the owner states a task, and a
 * person signs, once, a narrow set of allows for one agent that the rules
 * engine then enforces. A model may draft the `match` from the task's text
 * (see `GrantProposer`), but it never decides a live call: the grant is
 * policy a person signed, evaluated like any rule.
 *
 * A grant is one `match` in the rules language with `then: allow`. It sits
 * after the org's rules and before the owner's own: the org ceiling still
 * holds, and the owner's signature is what lets it run ahead of their file.
 * Like a standing approval it lives in SQLite, never in YAML, and it ends at
 * its expiry or when revoked.
 */

/** A grant's `match`, as written: a YAML flow or block mapping. */
export type GrantMatch = string;

/** Drafts grants from a task description. heel ships none; one plugs in here. */
export interface GrantProposer {
  propose(task: string): Promise<readonly GrantMatch[]>;
}

export class GrantError extends Error {
  override readonly name = "GrantError";
}

const MAX_MATCH_LENGTH = 4_000;

/**
 * Compiles one grant into a rule the evaluator places above the owner's
 * rules. Throws `GrantError` with a message for the person when the match
 * isn't valid, or when it would match every call of the agent (a grant must
 * say what it allows).
 */
export function compileGrant(match: GrantMatch, ref: { id: string }): CompiledRule {
  if (match.length > MAX_MATCH_LENGTH) throw new GrantError("That match is too long.");
  let parsed: unknown;
  try {
    parsed = parse(match);
  } catch {
    throw new GrantError("That match isn't valid YAML.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new GrantError("A match is a mapping, such as { action: email.send }.");
  }
  if (Object.keys(parsed).length === 0) {
    throw new GrantError("A grant must say what it allows; an empty match allows everything.");
  }
  const text = `rules:\n  - match: ${JSON.stringify(parsed)}\n    then: allow\n`;
  let rules: readonly CompiledRule[];
  try {
    rules = compileRulesText(text, `grant ${ref.id}`, "grants", "owner").file.rules;
  } catch (error) {
    if (error instanceof YamlValidationError) {
      throw new GrantError(`That match isn't valid: ${error.message}`);
    }
    throw error;
  }
  const [rule] = rules;
  if (rule === undefined || rules.length !== 1)
    throw new GrantError("A grant is exactly one match.");
  return { ...rule, ref: { name: `grant ${ref.id}`, file: "grants", line: 0 } };
}
