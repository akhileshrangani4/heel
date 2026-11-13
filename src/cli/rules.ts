import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { type LoadedRules, loadRuleSet, rulesPaths } from "../config/rules.ts";
import {
  formatYamlIssue,
  parseYamlDocument,
  validateYaml,
  type YamlIssue,
  YamlValidationError,
} from "../config/yaml.ts";
import { type CaseResult, type RulesCase, RulesCasesFile, runCase } from "../core/rules/cases.ts";
import type { RuleSet } from "../core/rules/evaluate.ts";
import { renderRulesJsonSchema } from "../core/rules/schema.ts";
import { hasErrnoCode } from "../util/errno.ts";
import {
  type CliIo,
  CONFIG_OPTION,
  configFrom,
  EXIT,
  onePositional,
  parseOrUsage,
  UsageError,
} from "./common.ts";

/**
 * `heel rules check|test|schema` (spec: Rules, "Loading, testing and
 * reload"). They read the rules files from `$HEEL_HOME` directly, so they
 * work with heel stopped and never touch a provider or the database.
 */

export const RULES_USAGE = `  heel rules check                        validate org-rules.yaml and rules/<user>.yaml
  heel rules test <cases.yaml> [--user <user>]
                                          run offline cases against the rules
  heel rules schema                       print the rules JSON Schema for editors
`;

export async function rulesCommand(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({
      args,
      options: { ...CONFIG_OPTION, user: { type: "string" } },
      allowPositionals: true,
      strict: true,
    }),
  );
  const [subcommand, ...rest] = positionals;
  if (subcommand !== "test" && values.user !== undefined) {
    throw new UsageError("--user applies only to `heel rules test`");
  }
  switch (subcommand) {
    case "schema":
      if (rest.length > 0) throw new UsageError(`unexpected argument "${rest[0]}"`);
      io.stdout.write(renderRulesJsonSchema());
      return EXIT.ok;
    case "check": {
      if (rest.length > 0) throw new UsageError(`unexpected argument "${rest[0]}"`);
      const loaded = loadOrReport(io, configFrom(io, values.config).home);
      if (loaded === null) return EXIT.dataErr;
      io.stdout.write(formatCheckReport(loaded));
      return EXIT.ok;
    }
    case "test": {
      const casesPath = resolve(onePositional(rest, "cases file"));
      const loaded = loadOrReport(io, configFrom(io, values.config).home);
      if (loaded === null) return EXIT.dataErr;
      const defaultUser = pickDefaultUser(loaded.set, values.user);
      if (defaultUser.ok === false) {
        io.stderr.write(`heel: ${defaultUser.message}\n`);
        return EXIT.dataErr;
      }
      const cases = readCases(io, casesPath);
      if (cases === null) return EXIT.dataErr;
      const results = cases.map((testCase) => runCase(loaded.set, testCase, defaultUser.user));
      io.stdout.write(formatCaseResults(results));
      return results.every((result) => result.outcome === "pass") ? EXIT.ok : EXIT.failed;
    }
    default:
      throw new UsageError(
        subcommand === undefined
          ? "missing rules subcommand"
          : `unknown rules subcommand "${subcommand}"`,
      );
  }
}

/** The loaded rules, or null after printing every problem to stderr. */
function loadOrReport(io: CliIo, home: string): LoadedRules | null {
  try {
    return loadRuleSet(rulesPaths(home));
  } catch (error) {
    if (!(error instanceof YamlValidationError)) throw error;
    io.stderr.write(formatInvalid("rules are invalid", error.issues));
    return null;
  }
}

function readCases(io: CliIo, path: string): RulesCase[] | null {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) throw error;
    io.stderr.write(`heel: cases file not found: ${path}\n`);
    return null;
  }
  try {
    return validateYaml(parseYamlDocument(source, path), RulesCasesFile).cases;
  } catch (error) {
    if (!(error instanceof YamlValidationError)) throw error;
    io.stderr.write(formatInvalid("cases file is invalid", error.issues));
    return null;
  }
}

type DefaultUser = { ok: true; user: string | null } | { ok: false; message: string };

/**
 * Pure: whose rules a case runs against when it names no user. `--user`
 * wins; otherwise the only user with a rules file, so a single-user install
 * needs no flag. With several, each case must name its user.
 */
export function pickDefaultUser(set: RuleSet, flag: string | undefined): DefaultUser {
  if (flag !== undefined) {
    return set.owners.has(flag)
      ? { ok: true, user: flag }
      : { ok: false, message: `no rules file for user "${flag}" (rules/${flag}.yaml)` };
  }
  const users = [...set.owners.keys()];
  return { ok: true, user: users.length === 1 ? (users[0] ?? null) : null };
}

function formatInvalid(what: string, issues: readonly YamlIssue[]): string {
  const plural = issues.length === 1 ? "problem" : "problems";
  return `heel: ${what} (${issues.length} ${plural}):\n${issues.map((issue) => `  ${formatYamlIssue(issue)}\n`).join("")}`;
}

/** Pure: what `heel rules check` prints for a valid set. */
export function formatCheckReport(loaded: LoadedRules): string {
  const lines: string[] = [];
  if (loaded.files.length === 0) {
    lines.push("No rules files: every call is denied.");
  }
  for (const file of loaded.files) {
    const who = file.layer === "org" ? "org" : `user ${file.user ?? "?"}`;
    lines.push(
      `ok    ${file.file} (${who}): ${count(file.rules, "rule")}, ${count(file.hide, "hide entry", "hide entries")}`,
    );
  }
  for (const warning of loaded.warnings) lines.push(`warn  ${formatYamlIssue(warning)}`);
  return `${lines.join("\n")}\n`;
}

/** Pure: what `heel rules test` prints, one line per case and a summary. */
export function formatCaseResults(results: readonly CaseResult[]): string {
  const lines = results.map(formatCaseLine);
  const passed = results.filter((result) => result.outcome === "pass").length;
  const failed = results.filter((result) => result.outcome === "fail").length;
  const errored = results.length - passed - failed;
  const summary = [`${passed} passed`, `${failed} failed`];
  if (errored > 0) summary.push(`${errored} could not run`);
  return `${lines.join("\n")}\n\n${summary.join(", ")}\n`;
}

function formatCaseLine(result: CaseResult): string {
  switch (result.outcome) {
    case "pass":
      return `ok    ${result.name}: ${result.actual}`;
    case "fail":
      return `FAIL  ${result.name}\n        expected: ${result.expected}\n        got:      ${result.actual}`;
    case "error":
      return `ERROR ${result.name}: ${result.message}`;
  }
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
