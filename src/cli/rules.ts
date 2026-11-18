import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { adminCall } from "../admin/client.ts";
import { compileRulesText, type LoadedRules, loadRuleSet, rulesPaths } from "../config/rules.ts";
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
import { actionsFor, DraftingError, lineDiff, requestDraft } from "../drafting/draft.ts";
import { hasErrnoCode } from "../util/errno.ts";
import { Secret } from "../vault/secret.ts";
import { loadSecret } from "../vault/secret-file.ts";
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
  heel rules draft "<words>" [--user <user>] [--cases <cases.yaml>]
                                          draft rules with the configured model; prints
                                          the draft and a diff, never saves it
  heel rules test <cases.yaml> [--user <user>]
                                          run offline cases against the rules
  heel rules schema                       print the rules JSON Schema for editors
`;

export async function rulesCommand(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({
      args,
      options: { ...CONFIG_OPTION, user: { type: "string" }, cases: { type: "string" } },
      allowPositionals: true,
      strict: true,
    }),
  );
  const [subcommand, ...rest] = positionals;
  if (subcommand !== "test" && subcommand !== "draft" && values.user !== undefined) {
    throw new UsageError("--user applies only to `heel rules test` and `heel rules draft`");
  }
  if (subcommand !== "draft" && values.cases !== undefined) {
    throw new UsageError("--cases applies only to `heel rules draft`");
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
    case "draft":
      return draftCommand(io, rest.join(" "), values);
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

/** The environment variable that carries the drafting API key; it beats `api_key_file`. */
export const DRAFTING_API_KEY_ENV = "HEEL_DRAFTING_API_KEY";

/**
 * `heel rules draft "<words>"` (D13b; spec: Teams, "Rule drafting"): asks
 * the configured model for a rules file, validates it, and prints it with a
 * diff against the person's current file and, with `--cases`, the cases'
 * results against it. It never writes a file (I-17).
 */
async function draftCommand(
  io: CliIo,
  description: string,
  values: { config?: string | undefined; user?: string | undefined; cases?: string | undefined },
): Promise<number> {
  if (description.trim() === "")
    throw new UsageError('describe the rule: heel rules draft "<words>"');
  const config = configFrom(io, values.config);
  if (config.drafting === null) {
    io.stderr.write("heel: drafting is off; add a drafting: section to heel.yaml\n");
    return EXIT.config;
  }
  const loaded = loadOrReport(io, config.home);
  if (loaded === null) return EXIT.dataErr;
  const users = [...loaded.set.owners.keys()];
  const user = values.user ?? (users.length === 1 ? users[0] : undefined);
  if (user === undefined) {
    io.stderr.write("heel: name whose rules to draft with --user <user>\n");
    return EXIT.usage;
  }
  const env = io.env;
  const fromEnv = env[DRAFTING_API_KEY_ENV];
  const apiKey =
    fromEnv !== undefined && fromEnv !== ""
      ? new Secret(fromEnv)
      : config.drafting.apiKeyFile === null
        ? null
        : loadSecret(env, DRAFTING_API_KEY_ENV, config.drafting.apiKeyFile);

  // The person's accounts, from heel if it is running; their names and providers only.
  let accounts: { alias: string; provider: string }[] = [];
  try {
    const response = await adminCall(config.adminSocketPath, { method: "account.list" });
    if (response.ok) {
      accounts = (response.result as { alias: string; provider: string; owner: string }[])
        .filter((a) => a.owner === user)
        .map((a) => ({ alias: a.alias, provider: a.provider }));
    }
  } catch {
    io.stderr.write("heel: heel isn't running, so the draft won't know your accounts\n");
  }

  let draft: string;
  try {
    draft = await requestDraft(
      { baseUrl: config.drafting.baseUrl, model: config.drafting.model, apiKey },
      {
        description,
        schema: renderRulesJsonSchema(),
        accounts,
        actions: actionsFor(accounts.map((a) => a.provider)),
      },
      io.fetch ?? fetch,
      AbortSignal.timeout(120_000),
    );
  } catch (error) {
    if (!(error instanceof DraftingError)) throw error;
    io.stderr.write(`heel: ${error.message}\n`);
    return EXIT.unavailable;
  }

  const display = `rules/${user}.yaml`;
  io.stdout.write(`Draft for ${display}:\n\n${draft}\n`);
  let compiled: ReturnType<typeof compileRulesText>;
  try {
    compiled = compileRulesText(draft, `${display} (draft)`, display, "owner");
  } catch (error) {
    if (!(error instanceof YamlValidationError)) throw error;
    io.stderr.write(formatInvalid("the draft isn't a valid rules file", error.issues));
    return EXIT.dataErr;
  }
  for (const warning of compiled.warnings) io.stdout.write(`warn  ${formatYamlIssue(warning)}\n`);
  const path = join(config.home, display);
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  io.stdout.write(
    `\nChanges from ${current === "" ? "an empty file" : display}:\n${lineDiff(current, draft)}`,
  );

  let passed = true;
  if (values.cases !== undefined) {
    const cases = readCases(io, resolve(values.cases));
    if (cases === null) return EXIT.dataErr;
    const owners = new Map(loaded.set.owners);
    owners.set(user, compiled.file);
    const results = cases.map((testCase) => runCase({ ...loaded.set, owners }, testCase, user));
    io.stdout.write(`\nCases against the draft:\n${formatCaseResults(results)}`);
    passed = results.every((result) => result.outcome === "pass");
  }
  io.stdout.write(`\nNot saved. If it's right, save it as ${display} yourself.\n`);
  return passed ? EXIT.ok : EXIT.failed;
}
