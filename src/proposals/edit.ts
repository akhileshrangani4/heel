import { createHash } from "node:crypto";
import { isMap, isSeq, parse, parseDocument } from "yaml";
import { compileRulesText } from "../config/rules.ts";
import { formatYamlIssue, YamlValidationError } from "../config/yaml.ts";

/**
 * Editing an owner's rules file from the web app (roadmap 2.9), mostly
 * without YAML: change a rule's decision, remove a rule or a hide entry, or,
 * for those who want it, replace the whole text. heel makes the change on the
 * YAML document, so comments and layout stay, and checks the result loads
 * before anyone can save it. Pure, apart from hashing.
 */

export type RulesEdit =
  | { kind: "decision"; index: number; decision: "allow" | "ask" | "deny" }
  | { kind: "remove-rule"; index: number }
  | { kind: "remove-hide"; index: number }
  | { kind: "replace"; text: string };

export interface RulesFileView {
  rules: { index: number; name: string | null; decision: string; rule: Record<string, unknown> }[];
  hide: { index: number; entry: Record<string, unknown> }[];
  /** Null when the file loads; otherwise every problem, by line. */
  problems: string[] | null;
}

/** The file's text, hashed: what a passkey signs, so only that exact text changes. */
export function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Every problem the text has, as `heel rules check` would list them, or null when it loads. */
export function rulesProblems(text: string, display: string): string[] | null {
  try {
    compileRulesText(text, display, display, "owner");
    return null;
  } catch (error) {
    if (!(error instanceof YamlValidationError)) throw error;
    return error.issues.map(formatYamlIssue);
  }
}

/** The rules and hide entries a file holds, in order, as plain objects. */
export function viewRules(text: string, display: string): RulesFileView {
  let parsed: unknown = null;
  try {
    parsed = parse(text);
  } catch {
    parsed = null;
  }
  const file = (parsed ?? {}) as { rules?: unknown; hide?: unknown };
  const asObject = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const rules = (Array.isArray(file.rules) ? file.rules : []).map((raw, index) => {
    const rule = asObject(raw);
    return {
      index,
      name: typeof rule["name"] === "string" ? rule["name"] : null,
      decision: typeof rule["then"] === "string" ? rule["then"] : "?",
      rule,
    };
  });
  const hide = (Array.isArray(file.hide) ? file.hide : []).map((raw, index) => ({
    index,
    entry: asObject(raw),
  }));
  return { rules, hide, problems: rulesProblems(text, display) };
}

/** The text after an edit, or why it can't be made. The result may still have problems: check it. */
export function applyEdit(
  text: string,
  edit: RulesEdit,
): { ok: true; text: string } | { ok: false; problem: string } {
  if (edit.kind === "replace") return { ok: true, text: edit.text };
  const doc = parseDocument(text);
  if (doc.errors.length > 0 || !isMap(doc.contents)) {
    return {
      ok: false,
      problem: "The file doesn't read as a rules file; edit it directly to fix it first.",
    };
  }
  const list = doc.get(edit.kind === "remove-hide" ? "hide" : "rules", true);
  if (!isSeq(list) || edit.index < 0 || edit.index >= list.items.length) {
    return { ok: false, problem: "That rule isn't in the file any more. Reload the page." };
  }
  if (edit.kind === "decision") {
    const rule = list.items[edit.index];
    if (!isMap(rule)) return { ok: false, problem: "That rule doesn't read as a rule." };
    rule.set("then", edit.decision);
  } else {
    list.items.splice(edit.index, 1);
  }
  return { ok: true, text: doc.toString() };
}
