import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  type CompiledRulesFile,
  compileRulesFile,
  type Layer,
  type RuleIssue,
} from "../core/rules/compile.ts";
import type { RuleSet } from "../core/rules/evaluate.ts";
import { RulesFile } from "../core/rules/schema.ts";
import { hasErrnoCode } from "../util/errno.ts";
import {
  issueAt,
  type ParsedYaml,
  parseYamlDocument,
  validateYaml,
  type YamlIssue,
  YamlValidationError,
} from "./yaml.ts";

/**
 * Finds, parses, validates and compiles the rules files (spec: Rules, "Files
 * and layers"): `$HEEL_HOME/org-rules.yaml` and one
 * `$HEEL_HOME/rules/<user>.yaml` per user. Either may be absent: no org file
 * means no org rules, and a user without a file has no rules of their own,
 * so their agents' calls fall through to the default deny.
 */

export const ORG_RULES_FILE = "org-rules.yaml";
export const OWNER_RULES_DIR = "rules";
const OWNER_SUFFIX = ".yaml";

export interface RulesPaths {
  /** `$HEEL_HOME`; rule refs name files relative to it. */
  home: string;
  orgFile: string;
  ownersDir: string;
}

export function rulesPaths(home: string): RulesPaths {
  return { home, orgFile: join(home, ORG_RULES_FILE), ownersDir: join(home, OWNER_RULES_DIR) };
}

/** One file that loaded, for `heel rules check` to summarize. */
export interface LoadedFileSummary {
  /** Relative to `$HEEL_HOME`, e.g. `rules/alice.yaml`. */
  file: string;
  layer: Layer;
  /** The user whose agents these rules govern; absent for the org file. */
  user?: string;
  rules: number;
  hide: number;
}

export interface LoadedRules {
  set: RuleSet;
  files: readonly LoadedFileSummary[];
  /** Problems that don't stop the set loading, e.g. a run limit with no hourly limit below it. */
  warnings: readonly YamlIssue[];
}

/**
 * Loads every rules file into one set. Every file is read and checked before
 * anything is returned, so a caller swapping sets never sees half of an
 * edit. A problem in any file throws one YamlValidationError listing every
 * problem in every file, each with its path, line and column.
 */
export function loadRuleSet(paths: RulesPaths): LoadedRules {
  const errors: YamlIssue[] = [];
  const warnings: YamlIssue[] = [];
  const files: LoadedFileSummary[] = [];

  const load = (path: string, layer: Layer, user?: string): CompiledRulesFile | null => {
    try {
      const source = readRulesFile(path);
      if (source === null) return null;
      const display = displayName(paths.home, path);
      const compiled = compileRulesText(source, path, display, layer);
      warnings.push(...compiled.warnings);
      files.push({
        file: display,
        layer,
        ...(user === undefined ? {} : { user }),
        rules: compiled.file.rules.length,
        hide: compiled.file.hide.length,
      });
      return compiled.file;
    } catch (error) {
      if (error instanceof YamlValidationError) errors.push(...error.issues);
      else if (error instanceof RulesReadError) errors.push(error.issue);
      else throw error;
      return null;
    }
  };

  const org = load(paths.orgFile, "org");
  const owners = new Map<string, CompiledRulesFile>();
  for (const entry of ownerEntries(paths.ownersDir, errors)) {
    if (entry.kind === "misnamed") {
      warnings.push(fileIssue(entry.path, `ignored: rules files end in ${OWNER_SUFFIX}`));
      continue;
    }
    const compiled = load(entry.path, "owner", entry.user);
    if (compiled !== null) owners.set(entry.user, compiled);
  }

  if (errors.length > 0) throw new YamlValidationError(errors);
  return { set: { org, owners }, files, warnings };
}

/**
 * Parses, validates and compiles one rules file's text. `path` locates
 * problems for the person fixing them; `display` (relative to `$HEEL_HOME`)
 * is the name rule refs carry into audit and onto the approval page, so
 * heel's install path never reaches an agent.
 */
export function compileRulesText(
  source: string,
  path: string,
  display: string,
  layer: Layer,
): { file: CompiledRulesFile; warnings: YamlIssue[] } {
  const parsed = parseYamlDocument(source, path);
  const input = validateYaml(parsed, RulesFile);
  const result = compileRulesFile(input, {
    file: display,
    layer,
    lineOf: (issuePath) => parsed.locate(issuePath).line,
  });
  const warnings = result.warnings.map((issue) => located(parsed, issue));
  if (!result.ok) {
    throw new YamlValidationError(result.errors.map((issue) => located(parsed, issue)));
  }
  return { file: result.file, warnings };
}

function located(parsed: ParsedYaml, issue: RuleIssue): YamlIssue {
  return issueAt(parsed, issue.path, issue.message);
}

type OwnerEntry = { kind: "file"; path: string; user: string } | { kind: "misnamed"; path: string };

/**
 * The owner files, sorted by name so loads and messages are deterministic.
 * Hidden files and editor leftovers (`alice.yaml~`, `.alice.yaml.swp`) are
 * skipped silently. A `.yml` file is reported: its author meant it to count,
 * and heel would otherwise ignore it without a word.
 */
function ownerEntries(dir: string, errors: YamlIssue[]): OwnerEntry[] {
  let dirents: Dirent[];
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) return [];
    errors.push(fileIssue(dir, readMessage(error)));
    return [];
  }
  const entries: OwnerEntry[] = [];
  for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
    const name = dirent.name;
    if (name.startsWith(".") || !(dirent.isFile() || dirent.isSymbolicLink())) continue;
    const path = join(dir, name);
    if (name.endsWith(".yml")) entries.push({ kind: "misnamed", path });
    else if (name.endsWith(OWNER_SUFFIX)) {
      entries.push({ kind: "file", path, user: name.slice(0, -OWNER_SUFFIX.length) });
    }
  }
  return entries;
}

/** A rules file exists but can't be read. */
class RulesReadError extends Error {
  readonly issue: YamlIssue;

  constructor(issue: YamlIssue) {
    super(issue.message);
    this.name = "RulesReadError";
    this.issue = issue;
  }
}

/** The file's text, or null when it doesn't exist. Any other read failure is a load error. */
function readRulesFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) return null;
    throw new RulesReadError(fileIssue(path, readMessage(error)));
  }
}

function readMessage(error: unknown): string {
  const code = error instanceof Error && "code" in error ? String(error.code) : String(error);
  return `can't be read (${code})`;
}

function fileIssue(file: string, message: string): YamlIssue {
  return { file, line: 1, col: 1, path: "", message };
}

/** A path relative to `$HEEL_HOME` with `/` separators, e.g. `rules/alice.yaml`. */
function displayName(home: string, path: string): string {
  return relative(home, path).split(sep).join("/");
}
