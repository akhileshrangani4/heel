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

/** Classifies the stderr of a probe; pflag's messages are the same in gh and kubectl. */
export function classifyProbe(output: string, flag: string): ProbeOutcome {
  if (output.includes(`unknown flag: --${flag}`)) return "unknown";
  if (output.includes(`flag needs an argument: --${flag}`)) return "needs_value";
  return "accepted";
}

/**
 * The kind a listed flag has once probing says whether it needs a value. A
 * flag that takes no value bare is a bool unless its listing shows a value:
 * gh marks optional values `string[="last"]`, kubectl shows a non-bool default.
 */
export function flagKind(cli: "gh" | "kubectl", listed: ListedFlag, needsValue: boolean): FlagKind {
  if (needsValue) return "value";
  if (cli === "gh") return listed.placeholder?.includes("[=") === true ? "optional" : "bool";
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
