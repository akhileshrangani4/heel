import { RE2JS, RE2JSException } from "re2js";
import type { RuleRef } from "../call.ts";
import { canonicalHash } from "../canonical.ts";
import { normalizeAddress, parseDomainPattern } from "./address.ts";
import { type FieldRef, TEXT_FIELDS, type TextField } from "./facts.ts";
import type { Check, Condition, Scalar } from "./match.ts";
import {
  type Decision,
  FIXED_MATCH_KEYS,
  type HideEmailInput,
  type LOOKS_LIKE,
  type MatchInput,
  NAMED_KEY_PATTERN,
  PATH_KEY_PATTERN,
  type RuleInput,
  type RulesFileInput,
  ValueCondition,
} from "./schema.ts";

/**
 * Turns a schema-valid rules file into the form the evaluator runs: regexes
 * compiled, addresses and domains normalized, state checks pinned to the
 * services that have them. Pure: the loader supplies line numbers.
 */

export type Layer = "org" | "owner";

/**
 * The state checks heel has, and the only actions and providers each can
 * run on (spec: Counts and state checks). Naming one anywhere else is a load
 * error (I-23).
 */
export const STATE_CHECKS = {
  all_in_thread: { actions: ["email.send"], providers: ["gmail", "outlook"] },
  checks: { actions: ["github.merge"], providers: ["github"] },
} as const satisfies Record<string, { actions: readonly string[]; providers: readonly string[] }>;
export type StateCheck = keyof typeof STATE_CHECKS;

export interface ItemsCheck {
  over: number;
  /** null: this call's items alone. */
  per: "run" | "hour" | null;
}

export interface CompiledRule {
  ref: RuleRef;
  /** 1-based position in its file; `heel rules test` cases name rules by it. */
  index: number;
  layer: Layer;
  /** sha256 of canonical `{match, then}`: standing approvals bind to it and lapse when it changes. */
  hash: string;
  /** The rule's `then`, renamed so a compiled rule is never mistaken for a thenable. */
  decision: Decision;
  watch: boolean;
  /** The plain conditions, ANDed. */
  conditions: readonly Condition<FieldRef>[];
  items: ItemsCheck | null;
  stateChecks: readonly StateCheck[];
  /** Actions and tools this rule names literally; a persistence call needs one (I-70). */
  names: { actions: ReadonlySet<string>; tools: ReadonlySet<string> };
}

export type HideField = "from" | "to" | "subject" | "labels";
export type LooksLike = (typeof LOOKS_LIKE)[number];

export interface CompiledHideEntry {
  file: string;
  line: number;
  conditions: readonly Condition<HideField>[];
  looksLike: readonly LooksLike[];
}

export interface CompiledRulesFile {
  file: string;
  layer: Layer;
  rules: readonly CompiledRule[];
  hide: readonly CompiledHideEntry[];
  /** sha256 of the hide entries as written; hidden-id verdict caches key on it (Q-H2). */
  hideHash: string;
}

export type IssuePath = readonly (string | number)[];

/** A problem found while compiling; the loader turns the path into file:line:col. */
export interface RuleIssue {
  path: IssuePath;
  message: string;
}

export type CompileResult =
  | { ok: true; file: CompiledRulesFile; warnings: readonly RuleIssue[] }
  | { ok: false; errors: readonly RuleIssue[]; warnings: readonly RuleIssue[] };

export interface CompileSource {
  file: string;
  layer: Layer;
  lineOf(path: IssuePath): number;
}

/**
 * What every operator object can hold once Zod has checked it for its field.
 * Zod types optional keys as `?: T | undefined`, hence the explicit undefined.
 */
interface OperatorInput {
  equals?: Scalar | readonly Scalar[] | undefined;
  one_of?: readonly Scalar[] | undefined;
  any_of?: readonly Scalar[] | undefined;
  matches?: string | undefined;
  any_domain_in?: readonly string[] | undefined;
  all_domain_in?: readonly string[] | undefined;
  max?: number | undefined;
  all_in_thread?: true | undefined;
}
type ConditionInput = Scalar | OperatorInput;

const FIXED = new Set<string>(FIXED_MATCH_KEYS);
const PATH_KEY = new RegExp(PATH_KEY_PATTERN);
const NAMED_KEY = new RegExp(NAMED_KEY_PATTERN);

/** The fixed keys that read one text field; `kind` is one of them. */
const TEXT_KEYS = TEXT_FIELDS satisfies readonly (TextField & (typeof FIXED_MATCH_KEYS)[number])[];

export function compileRulesFile(input: RulesFileInput, source: CompileSource): CompileResult {
  const errors: RuleIssue[] = [];
  const rules = (input.rules ?? []).map((rule, i) =>
    compileRule(rule, i, source, (path, message) => errors.push({ path, message })),
  );
  const hide = (input.hide ?? []).map((entry, i) =>
    compileHideEntry(entry.email, ["hide", i, "email"], source, (path, message) =>
      errors.push({ path, message }),
    ),
  );
  errors.push(...duplicateNames(input.rules ?? []));
  const warnings = lintRules(rules, input.rules ?? []);
  if (errors.length > 0) return { ok: false, errors, warnings };
  return {
    ok: true,
    warnings,
    file: {
      file: source.file,
      layer: source.layer,
      rules,
      hide,
      hideHash: canonicalHash(input.hide ?? []),
    },
  };
}

type Report = (path: IssuePath, message: string) => void;

function compileRule(
  rule: RuleInput,
  i: number,
  source: CompileSource,
  report: Report,
): CompiledRule {
  const at: IssuePath = ["rules", i];
  if (source.layer === "org" && rule.then === "allow") {
    report([...at, "then"], "org rules can only deny or ask (I-12)");
  }

  const conditions: Condition<FieldRef>[] = [];
  const stateChecks: StateCheck[] = [];
  const match = rule.match;
  const add = (key: string, raw: ConditionInput, field: FieldRef, addresses: boolean) => {
    const compiled = compileCondition(key, raw, field, addresses, [...at, "match", key], report);
    conditions.push(compiled.condition);
    if (compiled.allInThread) stateChecks.push("all_in_thread");
  };

  for (const name of TEXT_KEYS) {
    const raw = match[name];
    if (raw !== undefined) add(name, raw, { kind: "text", name }, false);
  }
  if (match.recipients !== undefined)
    add("recipients", match.recipients, { kind: "recipients" }, true);
  if (match.argv !== undefined) add("argv", match.argv, { kind: "argv" }, false);
  if (match.checks !== undefined) stateChecks.push("checks");

  for (const [key, raw] of Object.entries(match)) {
    if (FIXED.has(key)) continue;
    const field = dottedField(key);
    if (field === null) {
      report(
        [...at, "match", key],
        `unknown match key "${key}"; use ${FIXED_MATCH_KEYS.join(", ")}, args.<path>, body.<path>, query.<name> or flags.<name>`,
      );
      continue;
    }
    const value = ValueCondition.safeParse(raw);
    if (!value.success) {
      report([...at, "match", key], "expected a value or an object of operators");
      continue;
    }
    add(key, value.data, field, false);
  }

  checkStateServices(match, stateChecks, at, report);

  return {
    ref: { name: rule.name ?? null, file: source.file, line: source.lineOf(at) },
    index: i + 1,
    layer: source.layer,
    hash: ruleContentHash(rule),
    decision: rule.then,
    watch: rule.watch ?? false,
    conditions,
    items:
      match.items === undefined ? null : { over: match.items.over, per: match.items.per ?? null },
    stateChecks,
    names: {
      actions: literalStrings(match.action),
      tools: literalStrings(match.tool),
    },
  };
}

/** Standing approvals bind to this; renaming or moving a rule keeps it. */
export function ruleContentHash(rule: Pick<RuleInput, "match" | "then">): string {
  // biome-ignore lint/suspicious/noThenProperty: `then` is the rules file's key; the hash covers the file's own shape.
  return canonicalHash({ match: rule.match, then: rule.then });
}

function dottedField(key: string): FieldRef | null {
  if (PATH_KEY.test(key)) {
    const [root, ...path] = key.split(".");
    return { kind: "path", root: root === "body" ? "body" : "args", path };
  }
  if (NAMED_KEY.test(key)) {
    const dot = key.indexOf(".");
    const root = key.slice(0, dot) === "flags" ? "flags" : "query";
    return { kind: "named", root, key: key.slice(dot + 1) };
  }
  return null;
}

function compileCondition<F>(
  key: string,
  raw: ConditionInput,
  field: F,
  addresses: boolean,
  at: IssuePath,
  report: Report,
): { condition: Condition<F>; allInThread: boolean } {
  const ops: OperatorInput = isOperatorInput(raw) ? raw : { equals: raw };
  const checks: Check[] = [];
  const operand = (value: Scalar, path: IssuePath): Scalar => {
    if (!addresses) return value;
    const address = typeof value === "string" ? normalizeAddress(value) : null;
    if (address === null) {
      report(path, `not an email address: ${JSON.stringify(value)}`);
      return String(value);
    }
    return address;
  };

  if (ops.equals !== undefined) {
    const value = ops.equals;
    checks.push({
      op: "equals",
      value: isScalarList(value)
        ? value.map((v, j) => operand(v, [...at, "equals", j]))
        : operand(value, [...at, "equals"]),
    });
  }
  for (const op of ["one_of", "any_of"] as const) {
    const values = ops[op];
    if (values === undefined) continue;
    checks.push({ op, values: new Set(values.map((v, j) => operand(v, [...at, op, j]))) });
  }
  if (ops.matches !== undefined) {
    const regex = compileRegex(ops.matches, [...at, "matches"], report);
    if (regex !== null) checks.push({ op: "matches", source: ops.matches, regex });
  }
  for (const op of ["any_domain_in", "all_domain_in"] as const) {
    const values = ops[op];
    if (values === undefined) continue;
    const domains = values.flatMap((text, j) => {
      const pattern = parseDomainPattern(text);
      if (pattern === null) report([...at, op, j], `not a domain: ${JSON.stringify(text)}`);
      return pattern === null ? [] : [pattern];
    });
    checks.push({ op, domains });
  }
  if (ops.max !== undefined) checks.push({ op: "max", n: ops.max });

  const allInThread = ops.all_in_thread === true;
  // Count what was written, not what compiled, so a bad operand reports once.
  const written = Object.values(ops).some((value) => value !== undefined);
  if (!written) report(at, `${key} needs at least one operator`);
  return { condition: { key, field, addresses, checks }, allInThread };
}

function isOperatorInput(raw: ConditionInput): raw is OperatorInput {
  return typeof raw === "object" && raw !== null;
}

function isScalarList(value: Scalar | readonly Scalar[]): value is readonly Scalar[] {
  return Array.isArray(value);
}

/**
 * Patterns use RE2 syntax and match the whole value (anchored), so a rule
 * can't hang heel on a crafted input and `prod` never matches `nonprod`.
 */
function compileRegex(source: string, at: IssuePath, report: Report): RE2JS | null {
  try {
    return RE2JS.compile(source);
  } catch (error) {
    if (!(error instanceof RE2JSException)) throw error;
    report(at, `invalid RE2 pattern: ${error.message}`);
    return null;
  }
}

/**
 * I-23: a state check only exists on the services that have it, so the rule
 * must pin `action` (and `provider`, if it names one) to those with literal
 * values. A rule that leaves either open could reach a call heel has no
 * lookup for. Operators on one key are ANDed, so a `matches` beside the
 * literals can only narrow them further.
 */
function checkStateServices(
  match: MatchInput,
  stateChecks: readonly StateCheck[],
  at: IssuePath,
  report: Report,
): void {
  for (const check of new Set(stateChecks)) {
    const service = STATE_CHECKS[check];
    const path = check === "checks" ? [...at, "match", "checks"] : [...at, "match", "recipients"];
    const actions = literalStrings(match.action);
    const allowed = new Set<string>(service.actions);
    const supported = (set: ReadonlySet<string>, values: ReadonlySet<string>) =>
      values.size > 0 && [...values].every((value) => set.has(value));
    if (!supported(allowed, actions)) {
      report(
        path,
        `${check} is a state check heel has only for action ${service.actions.join(", ")}; name that action in this rule (I-23)`,
      );
    }
    if (match.provider !== undefined) {
      const providers = new Set<string>(service.providers);
      if (!supported(providers, literalStrings(match.provider))) {
        report(
          path,
          `${check} is a state check heel has only on ${service.providers.join(", ")} (I-23)`,
        );
      }
    }
  }
}

type TextInput = MatchInput["action"];

/** The values a text condition names literally (shorthand, equals, one_of, any_of). */
function literalStrings(condition: TextInput): ReadonlySet<string> {
  if (condition === undefined) return new Set();
  if (typeof condition === "string") return new Set([condition]);
  const values = [
    ...(condition.equals === undefined ? [] : [condition.equals]),
    ...(condition.one_of ?? []),
    ...(condition.any_of ?? []),
  ];
  return new Set(values);
}

function duplicateNames(rules: readonly RuleInput[]): RuleIssue[] {
  const seen = new Set<string>();
  const issues: RuleIssue[] = [];
  rules.forEach((rule, i) => {
    if (rule.name === undefined) return;
    if (seen.has(rule.name)) {
      issues.push({
        path: ["rules", i, "name"],
        message: `rule name "${rule.name}" is already used in this file`,
      });
    }
    seen.add(rule.name);
  });
  return issues;
}

/**
 * Warnings for `heel rules check`. A `per: run` limit does nothing for calls
 * without a run id (I-26), so the README pairs each with an hourly limit on
 * the same action below it (Q-C2).
 */
function lintRules(rules: readonly CompiledRule[], inputs: readonly RuleInput[]): RuleIssue[] {
  const warnings: RuleIssue[] = [];
  rules.forEach((rule, i) => {
    if (rule.items?.per !== "run") return;
    const action = canonicalHash(inputs[i]?.match.action ?? null);
    const pairedBelow = rules.slice(i + 1).some((other, j) => {
      const otherInput = inputs[i + 1 + j];
      return (
        other.items?.per === "hour" && canonicalHash(otherInput?.match.action ?? null) === action
      );
    });
    if (!pairedBelow) {
      warnings.push({
        path: ["rules", i, "match", "items", "per"],
        message:
          "a per: run limit doesn't apply to calls without a run id; add a per: hour rule for the same action below it",
      });
    }
  });
  return warnings;
}

function compileHideEntry(
  entry: HideEmailInput,
  at: IssuePath,
  source: CompileSource,
  report: Report,
): CompiledHideEntry {
  const conditions: Condition<HideField>[] = [];
  const add = (field: HideField, raw: ConditionInput | undefined, addresses: boolean) => {
    if (raw === undefined) return;
    conditions.push(
      compileCondition(field, raw, field, addresses, [...at, field], report).condition,
    );
  };
  add("from", entry.from, true);
  add("to", entry.to, true);
  add("subject", entry.subject, false);
  add("labels", entry.labels, false);
  const looksLike =
    entry.looks_like === undefined
      ? []
      : typeof entry.looks_like === "string"
        ? [entry.looks_like]
        : [...new Set(entry.looks_like)];
  if (conditions.length === 0 && looksLike.length === 0) {
    report(at, "a hide entry needs at least one of from, to, subject, labels or looks_like");
  }
  return { file: source.file, line: source.lineOf(at), conditions, looksLike };
}
