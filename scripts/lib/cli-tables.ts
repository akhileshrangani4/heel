/**
 * Pure parsing for `pnpm gen:cli-tables`: reads gh's `gh help reference` and
 * kubectl's `--help` pages into the command tree, and classifies the probes
 * that confirm each flag's arity against the real binary. The script owns the
 * process spawning; everything here is text in, data out.
 */
import type {
  CommandDef,
  CommandTable,
  FlagDef,
  FlagKind,
} from "../../src/definitions/cli/cobra.ts";

/** A flag as a help page lists it, before probing confirms its arity. */
export interface ListedFlag {
  readonly long: string;
  readonly short: string;
  /**
   * gh: the value placeholder (`string`, `[HOST/]OWNER/REPO`), absent for a
   * bool. kubectl: the default shown after `=` (`false`, `''`, `[]`).
   */
  readonly placeholder?: string;
}

export interface ListedCommand {
  /** Canonical names below the root. */
  readonly path: readonly string[];
  readonly aliases: readonly string[];
  readonly flags: readonly ListedFlag[];
}

const GH_HEADING = /^(#{2,}) gh (.+)$/;
const GH_FLAG_LINE = /^ +(?:-(\S), +)?--([A-Za-z0-9][\w.-]*)(?: (\S+))?(?: {2,}|$)/;

/**
 * The commands in `gh help reference`, skipping alias commands ("Alias for
 * …"), which exist only through the user's config, never as built-ins.
 */
export function parseGhReference(text: string): ListedCommand[] {
  const commands: ListedCommand[] = [];
  const sections = splitGhSections(text);
  for (const { heading, body } of sections) {
    const path = ghCommandPath(heading);
    if (path.length === 0) continue;
    if (body.some((line) => line.startsWith("Alias for "))) continue;
    commands.push({ path, aliases: ghAliases(path, body), flags: ghFlags(body) });
  }
  return commands;
}

function splitGhSections(text: string): { heading: string; body: string[] }[] {
  const sections: { heading: string; body: string[] }[] = [];
  for (const line of text.split("\n")) {
    const heading = GH_HEADING.exec(line);
    if (heading !== null) {
      sections.push({ heading: heading[2] as string, body: [] });
      continue;
    }
    sections.at(-1)?.body.push(line);
  }
  return sections;
}

/** `pr merge [<number> | <url>] [flags]` → ["pr", "merge"]. */
export function ghCommandPath(heading: string): string[] {
  const path: string[] = [];
  for (const word of heading.split(" ")) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(word)) break;
    path.push(word);
  }
  return path;
}

/** The `Aliases` block lists full invocations, e.g. `gh codespace ls, gh cs ls`. */
function ghAliases(path: readonly string[], body: readonly string[]): string[] {
  const start = body.indexOf("Aliases");
  if (start === -1) return [];
  const line = body.slice(start + 1).find((candidate) => candidate.trim() !== "");
  if (line === undefined) return [];
  const aliases = new Set<string>();
  for (const invocation of line.split(",")) {
    const words = invocation.trim().split(/\s+/);
    // Only the last word is this command's alias; earlier words may be a parent's alias.
    const last = words.at(-1);
    if (words.length === path.length + 1 && last !== undefined && last !== path.at(-1)) {
      aliases.add(last);
    }
  }
  return [...aliases];
}

function ghFlags(body: readonly string[]): ListedFlag[] {
  const flags: ListedFlag[] = [];
  for (const line of body) {
    const match = GH_FLAG_LINE.exec(line);
    if (match === null) continue;
    const placeholder = match[3];
    flags.push({
      long: match[2] as string,
      short: match[1] ?? "",
      ...(placeholder !== undefined && { placeholder }),
    });
  }
  return flags;
}

/**
 * The flags one section of a gh `--help` page lists: `FLAGS` (the command's
 * own, persistent ones included) or `INHERITED FLAGS` (its parents'). The
 * reference leaves out a group's own flags when its heading lacks `[flags]`
 * (`gh issue <command>` lists no `-R`), so the help page fills them in.
 */
export function parseGhHelpFlags(text: string, section: "FLAGS" | "INHERITED FLAGS"): ListedFlag[] {
  const lines = text.split("\n");
  const start = lines.indexOf(section);
  if (start === -1) return [];
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    // The next section heading: an unindented line in capitals.
    if (/^[A-Z][A-Z ]*$/.test(line)) break;
    body.push(line);
  }
  return ghFlags(body);
}

/** `listed` with the flags `help` adds that it doesn't already list. */
export function withHelpFlags(listed: ListedCommand, help: readonly ListedFlag[]): ListedCommand {
  const missing = help.filter((flag) => !listed.flags.some((own) => own.long === flag.long));
  return missing.length === 0 ? listed : { ...listed, flags: [...listed.flags, ...missing] };
}

/** The flag `--long` as a command at `path` parses it: its own, or a parent's persistent one. */
export function reachingFlag(
  table: CommandTable,
  path: readonly string[],
  long: string,
): FlagDef | undefined {
  for (let i = path.length; i >= 0; i--) {
    const def = table.commands[path.slice(0, i).join(" ")];
    const flags =
      i === path.length
        ? [...(def?.local ?? []), ...(def?.persistent ?? [])]
        : (def?.persistent ?? []);
    const flag = flags.find(([name]) => name === long);
    if (flag !== undefined) return flag;
  }
  return undefined;
}

/**
 * The flags a gh help page lists as inherited that the table doesn't give
 * the command through a parent's persistent flags, as `-s/--long` strings.
 */
export function missingInheritedFlags(
  table: CommandTable,
  path: readonly string[],
  inherited: readonly ListedFlag[],
): string[] {
  const ancestors = Array.from({ length: path.length }, (_, i) => path.slice(0, i).join(" "));
  return inherited
    .filter(
      (flag) =>
        !ancestors.some((key) =>
          (table.commands[key]?.persistent ?? []).some(
            ([long, short]) => long === flag.long && short === flag.short,
          ),
        ),
    )
    .map((flag) => (flag.short === "" ? `--${flag.long}` : `-${flag.short}/--${flag.long}`));
}

/**
 * Where gh 2.99.0 adds `-R/--repo` (`cmdutil.EnableRepoOverride`): on these
 * commands, as a persistent flag, so each of them and every command below
 * takes it. heel's repo rules depend on parsing it.
 */
export const GH_REPO_FLAG_ROOTS: readonly string[] = [
  "agent-task create",
  "agent-task view",
  "browse",
  "cache",
  "discussion",
  "issue",
  "label",
  "pr",
  "project link",
  "project unlink",
  "release",
  "repo autolink",
  "repo deploy-key",
  "repo read-dir",
  "repo read-file",
  "repo rename",
  "ruleset",
  "run",
  "secret",
  "variable",
  "workflow",
];

/**
 * The commands at or below `GH_REPO_FLAG_ROOTS` that the table doesn't give
 * `-R/--repo` taking a value (a root missing from the table counts too).
 * Commands that take their arguments raw parse no flags, so they're skipped.
 */
export function missingRepoFlags(table: CommandTable): string[] {
  const missing = GH_REPO_FLAG_ROOTS.filter((root) => table.commands[root] === undefined);
  for (const [key, def] of Object.entries(table.commands)) {
    if (def.rawArgs === true) continue;
    const under = GH_REPO_FLAG_ROOTS.some((root) => key === root || key.startsWith(`${root} `));
    if (!under) continue;
    const flag = reachingFlag(table, key.split(" "), "repo");
    if (flag?.[1] !== "R" || flag[2] !== "value") missing.push(key);
  }
  return missing;
}

const KUBECTL_FLAG_LINE = /^ {4}(?:-(\S), )?--([A-Za-z0-9][\w.-]*)=(.*):$/;
const KUBECTL_COMMAND_LINE = /^ {2}([a-z0-9][a-z0-9-]*) {2,}\S/;

export interface KubectlHelpPage {
  readonly aliases: readonly string[];
  readonly subcommands: readonly string[];
  readonly flags: readonly ListedFlag[];
}

/**
 * One `kubectl … --help` page. The root page lists commands under several
 * group headings ("Basic Commands (Beginner):"); others under "Available
 * Commands:". Flags come from "Options:" (and `kubectl options`, same format).
 */
export function parseKubectlHelp(text: string): KubectlHelpPage {
  const aliases: string[] = [];
  const subcommands: string[] = [];
  const flags: ListedFlag[] = [];
  let section = "";
  for (const line of text.split("\n")) {
    if (/^\S.*:$/.test(line)) {
      section = line;
      continue;
    }
    if (section === "Aliases:" && line.trim() !== "") {
      aliases.push(...line.split(",").map((alias) => alias.trim()));
      continue;
    }
    if (isCommandListHeading(section)) {
      const match = KUBECTL_COMMAND_LINE.exec(line);
      if (match !== null) subcommands.push(match[1] as string);
      continue;
    }
    const flag = KUBECTL_FLAG_LINE.exec(line);
    if (flag !== null) {
      flags.push({ long: flag[2] as string, short: flag[1] ?? "", placeholder: flag[3] as string });
    }
  }
  return { aliases: aliases.slice(1), subcommands, flags };
}

function isCommandListHeading(section: string): boolean {
  return section === "Available Commands:" || /^[A-Z][\w ]* Commands( \(.+\))?:$/.test(section);
}

/** What the binary did with `<command> --flag` given bare at the end of argv. */
export type ProbeOutcome = "unknown" | "needs_value" | "accepted";

/**
 * Classifies the stderr of a probe; pflag's messages are the same in gh and
 * kubectl. gh rewrites pflag's "flag needs an argument: --json" into a list
 * of the command's JSON fields, so that message means a value too.
 */
export function classifyProbe(output: string, flag: string): ProbeOutcome {
  if (output.includes(`unknown flag: --${flag}`)) return "unknown";
  if (output.includes(`flag needs an argument: --${flag}`)) return "needs_value";
  if (output.includes(`Specify one or more comma-separated fields for \`--${flag}\``)) {
    return "needs_value";
  }
  return "accepted";
}

/**
 * The kind a listed flag has once probing says whether it needs a value. A
 * flag that takes no value bare is a bool unless its listing shows a value:
 * gh marks optional values `string[="last"]`, kubectl shows a non-bool default.
 *
 * gh lists a placeholder for every flag that takes a value, so a gh probe
 * that disagrees with the listing throws: a command that rewrites pflag's
 * error (as `--json` does) would otherwise turn a value flag into a bool,
 * and heel would read its value as a positional argument.
 */
export function flagKind(cli: "gh" | "kubectl", listed: ListedFlag, needsValue: boolean): FlagKind {
  if (cli === "gh") {
    const optional = listed.placeholder?.includes("[=") === true;
    // pflag shows a backquoted word from the usage as the placeholder, bool or not:
    // "--force `--hostname`" is a bool, "--value `--field`" a string. Those say nothing.
    const quoted = listed.placeholder?.startsWith("-") === true;
    const listsValue = listed.placeholder !== undefined && !optional;
    if (!quoted && needsValue !== listsValue) {
      throw new Error(
        `gh --${listed.long}: help lists ${listed.placeholder ?? "no value"}, but the probe ` +
          `says it ${needsValue ? "needs" : "doesn't need"} one`,
      );
    }
    if (needsValue) return "value";
    return optional ? "optional" : "bool";
  }
  if (needsValue) return "value";
  return listed.placeholder === "true" || listed.placeholder === "false" ? "bool" : "optional";
}

export function toFlagDef(listed: ListedFlag, kind: FlagKind): FlagDef {
  return [listed.long, listed.short, kind];
}

/** Renders a table as the TypeScript module the parsers import. */
export function renderTable(exportName: string, table: CommandTable, source: string): string {
  const lines = [
    `// Generated by \`pnpm gen:cli-tables\` from ${source}. Do not edit.`,
    'import type { CommandTable } from "../cobra.ts";',
    "",
    `export const ${exportName}: CommandTable = {`,
    `  cli: ${JSON.stringify(table.cli)},`,
    `  version: ${JSON.stringify(table.version)},`,
    `  normalizeUnderscores: ${table.normalizeUnderscores},`,
    `  defaultHelpFlag: ${table.defaultHelpFlag},`,
    "  commands: {",
  ];
  for (const key of Object.keys(table.commands).sort()) {
    lines.push(`    ${JSON.stringify(key)}: ${renderCommand(table.commands[key] as CommandDef)},`);
  }
  lines.push("  },", "};", "");
  return lines.join("\n");
}

function renderCommand(def: CommandDef): string {
  const parts: string[] = [];
  if (def.aliases !== undefined && def.aliases.length > 0) {
    parts.push(`aliases: ${JSON.stringify(def.aliases)}`);
  }
  if (def.local !== undefined && def.local.length > 0)
    parts.push(`local: ${renderFlags(def.local)}`);
  if (def.persistent !== undefined && def.persistent.length > 0) {
    parts.push(`persistent: ${renderFlags(def.persistent)}`);
  }
  if (def.interspersed === false) parts.push("interspersed: false");
  if (def.rawArgs === true) parts.push("rawArgs: true");
  return `{ ${parts.join(", ")} }`.replace("{  }", "{}");
}

function renderFlags(flags: readonly FlagDef[]): string {
  const sorted = [...flags].sort((a, b) => a[0].localeCompare(b[0]));
  return `[${sorted.map((flag) => JSON.stringify(flag)).join(", ")}]`;
}
