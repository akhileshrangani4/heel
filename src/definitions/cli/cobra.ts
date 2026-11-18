/**
 * Resolves argv the way cobra and pflag do, against a generated command table
 * (spec: CLI runner, "Parsing known CLIs"). gh and kubectl are both cobra
 * programs, so heel finds the verb with the algorithm the binary itself runs:
 * any other reading would let an argv that heel sees as one command run as
 * another. Flags before the verb, flag values that look like verbs, aliases
 * and `--` all resolve exactly as cobra resolves them, and anything the table
 * doesn't know (an unknown flag, command or alias) is a parse failure rather
 * than a guess.
 *
 * The emulation follows cobra's `Command.Find` (stripFlags, argsMinusFirstX,
 * findNext) and pflag's `FlagSet.Parse`; each quirk below is theirs.
 */
import type { CliFlagValue } from "../../core/call.ts";

/** A bool takes no value; `optional` takes one only as `--flag=value`; `value` needs one. */
export type FlagKind = "bool" | "value" | "optional";

/** `[long name, single-letter shorthand or "", kind]`. */
export type FlagDef = readonly [long: string, short: string, kind: FlagKind];

export interface CommandDef {
  /** Other names cobra resolves to this command. */
  readonly aliases?: readonly string[];
  /** Flags that exist only on this command. */
  readonly local?: readonly FlagDef[];
  /** Flags this command defines for itself and every command below it. */
  readonly persistent?: readonly FlagDef[];
  /** A positional argument ends flag parsing (pflag `SetInterspersed(false)`). */
  readonly interspersed?: false;
  /** cobra passes the arguments through unparsed, so heel can't see the flags. */
  readonly rawArgs?: true;
}

export interface CommandTable {
  readonly cli: string;
  /** The binary version the table was generated from. */
  readonly version: string;
  /** kubectl reads `--all_namespaces` as `--all-namespaces`; gh doesn't. */
  readonly normalizeUnderscores: boolean;
  /**
   * cobra's default `-h/--help` flag: it exists only once a command has been
   * resolved, so it's unknown while cobra walks the path. gh instead defines
   * `--help` itself, as a persistent flag on the root.
   */
  readonly defaultHelpFlag: boolean;
  /** Keyed by the space-joined canonical path below the root; "" is the root. */
  readonly commands: Readonly<Record<string, CommandDef>>;
}

export interface ParsedArgs {
  /** Canonical command names below the root, e.g. ["pr", "merge"], whichever alias was typed. */
  readonly path: readonly string[];
  /**
   * Flags by long name. A bool holds `true` or `"false"` (its last value); a
   * flag given once holds its value (`true` for an optional flag given bare);
   * a flag given more than once holds every value in order, "" for a bare one.
   */
  readonly flags: Readonly<Record<string, CliFlagValue>>;
  readonly positionals: readonly string[];
  /** How many positionals came before a bare `--` (pflag's ArgsLenAtDash). */
  readonly argsLenAtDash?: number;
  /** The program would print help and run nothing. */
  readonly help: boolean;
}

export type ParseFailureReason =
  | "unknown_command"
  | "unknown_flag"
  | "missing_value"
  | "bad_flag_syntax"
  | "invalid_bool"
  | "raw_args";

export type ParseResult =
  | { readonly ok: true; readonly args: ParsedArgs }
  | { readonly ok: false; readonly reason: ParseFailureReason; readonly detail: string };

interface FlagSet {
  readonly long: ReadonlyMap<string, FlagDef>;
  readonly short: ReadonlyMap<string, FlagDef>;
}

interface IndexedCommand {
  readonly path: readonly string[];
  readonly def: CommandDef;
  /** Child names and aliases → child key, in table order (cobra's findNext). */
  readonly children: ReadonlyMap<string, string>;
  /** Flags cobra knows while resolving the path through this command. */
  readonly findFlags: FlagSet;
  /** Flags when this is the command that runs. */
  readonly runFlags: FlagSet;
}

interface IndexedTable {
  readonly table: CommandTable;
  readonly commands: ReadonlyMap<string, IndexedCommand>;
}

const indexes = new WeakMap<CommandTable, IndexedTable>();

/** Parses `args` (everything after the program name) against `table`. */
export function parseCobraArgs(table: CommandTable, args: readonly string[]): ParseResult {
  const index = indexTable(table);
  const root = lookup(index, "");
  const { command, rest } = findCommand(index, root, args);
  if (command.def.rawArgs === true) {
    return failure("raw_args", `${commandName(table, command)} takes its arguments unparsed`);
  }
  const parsed = parseFlags(table, command, rest);
  if (!parsed.ok) return parsed;
  if (parsed.args.help) return parsed;
  if (command.children.size > 0 && parsed.args.positionals.length > 0) {
    // A leftover word under a command with subcommands names a command the
    // table doesn't have: an alias, extension, plugin or hidden command.
    return failure(
      "unknown_command",
      `unknown command "${parsed.args.positionals[0]}" for "${commandName(table, command)}"`,
    );
  }
  return parsed;
}

/** cobra's `Command.Find`: walks subcommand names, skipping flags and their values. */
function findCommand(
  index: IndexedTable,
  start: IndexedCommand,
  args: readonly string[],
): { command: IndexedCommand; rest: readonly string[] } {
  let command = start;
  let rest = args;
  for (;;) {
    const words = stripFlags(rest, command.findFlags, index.table);
    const next = words[0];
    if (next === undefined) return { command, rest };
    const childKey = command.children.get(next);
    if (childKey === undefined) return { command, rest };
    rest = argsMinusFirstX(rest, next, command.findFlags, index.table);
    command = lookup(index, childKey);
  }
}

/** The words cobra considers as subcommand names: non-flags that aren't flag values. */
function stripFlags(args: readonly string[], flags: FlagSet, table: CommandTable): string[] {
  const commands: string[] = [];
  let i = 0;
  while (i < args.length) {
    const s = args[i] as string;
    i += 1;
    if (s === "--") break;
    if (takesNextArg(s, flags, table)) {
      // cobra stops when at most the flag's value is left.
      if (args.length - i <= 1) break;
      i += 1;
      continue;
    }
    if (s !== "" && !s.startsWith("-")) commands.push(s);
  }
  return commands;
}

/** `args` without the first `x` that is neither a flag nor a flag's value. */
function argsMinusFirstX(
  args: readonly string[],
  x: string,
  flags: FlagSet,
  table: CommandTable,
): readonly string[] {
  for (let pos = 0; pos < args.length; pos += 1) {
    const s = args[pos] as string;
    if (s === "--") break;
    if (takesNextArg(s, flags, table)) {
      pos += 1;
      continue;
    }
    if (!s.startsWith("-") && s === x) return [...args.slice(0, pos), ...args.slice(pos + 1)];
  }
  return args;
}

/**
 * cobra's test for "`s` is a flag whose value is the next argument". An
 * unknown flag counts as one: cobra can't tell, so it skips the next word.
 */
function takesNextArg(s: string, flags: FlagSet, table: CommandTable): boolean {
  if (s.includes("=")) return false;
  if (s.startsWith("--")) return !hasNoOptDefault(flags.long.get(normalize(table, s.slice(2))));
  if (s.startsWith("-") && s.length === 2) return !hasNoOptDefault(flags.short.get(s.slice(1)));
  return false;
}

function hasNoOptDefault(flag: FlagDef | undefined): boolean {
  return flag !== undefined && flag[2] !== "value";
}

type Occurrence = { readonly flag: FlagDef; readonly value: string | true };

interface FlagParseState {
  readonly occurrences: Occurrence[];
  readonly positionals: string[];
  argsLenAtDash?: number;
  /** pflag hit an undefined `-h` or `--help` and stopped (ErrHelp). */
  helpRequested: boolean;
}

/** pflag's `FlagSet.Parse` over the resolved command's flags. */
function parseFlags(
  table: CommandTable,
  command: IndexedCommand,
  args: readonly string[],
): ParseResult {
  const flags = command.runFlags;
  const interspersed = command.def.interspersed !== false;
  const state: FlagParseState = { occurrences: [], positionals: [], helpRequested: false };
  let i = 0;
  while (i < args.length && !state.helpRequested) {
    const s = args[i] as string;
    i += 1;
    if (s.length < 2 || !s.startsWith("-")) {
      if (!interspersed) {
        state.positionals.push(s, ...args.slice(i));
        break;
      }
      state.positionals.push(s);
      continue;
    }
    if (s === "--") {
      state.argsLenAtDash = state.positionals.length;
      state.positionals.push(...args.slice(i));
      break;
    }
    const step = s.startsWith("--")
      ? parseLongArg(table, flags, s, args, i, state)
      : parseShortArg(flags, s, args, i, state);
    if (typeof step !== "number") return step;
    i = step;
  }
  return collect(command.path, state);
}

/** Returns the index of the next unread argument, or a failure. */
function parseLongArg(
  table: CommandTable,
  flags: FlagSet,
  s: string,
  args: readonly string[],
  next: number,
  state: FlagParseState,
): number | ParseResult {
  const body = s.slice(2);
  if (body === "" || body.startsWith("-") || body.startsWith("=")) {
    return failure("bad_flag_syntax", `bad flag syntax: ${s}`);
  }
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  const flag = flags.long.get(normalize(table, name));
  if (flag === undefined) {
    if (name === "help") {
      state.helpRequested = true;
      return next;
    }
    return failure("unknown_flag", `unknown flag: --${name}`);
  }
  if (eq !== -1) return record(state, flag, body.slice(eq + 1), next);
  if (flag[2] !== "value") return record(state, flag, true, next);
  if (next < args.length) return record(state, flag, args[next] as string, next + 1);
  return failure("missing_value", `flag needs an argument: ${s}`);
}

/** A cluster of shorthands such as `-it` or `-nprod`. */
function parseShortArg(
  flags: FlagSet,
  s: string,
  args: readonly string[],
  next: number,
  state: FlagParseState,
): number | ParseResult {
  let shorthands = s.slice(1);
  let i = next;
  while (shorthands.length > 0) {
    // pflag ignores Go test flags (`-test.v`) entirely.
    if (shorthands.startsWith("test.")) return i;
    const c = shorthands[0] as string;
    const flag = flags.short.get(c);
    if (flag === undefined) {
      if (c === "h") {
        state.helpRequested = true;
        return i;
      }
      return failure("unknown_flag", `unknown shorthand flag: '${c}' in -${shorthands}`);
    }
    let value: string | true;
    let rest = shorthands.slice(1);
    if (shorthands.length > 2 && shorthands[1] === "=") {
      value = shorthands.slice(2);
      rest = "";
    } else if (flag[2] !== "value") {
      value = true;
    } else if (shorthands.length > 1) {
      value = shorthands.slice(1);
      rest = "";
    } else if (i < args.length) {
      value = args[i] as string;
      i += 1;
    } else {
      return failure("missing_value", `flag needs an argument: '${c}' in -${shorthands}`);
    }
    const recorded = record(state, flag, value, i);
    if (typeof recorded !== "number") return recorded;
    shorthands = rest;
  }
  return i;
}

function record(
  state: FlagParseState,
  flag: FlagDef,
  value: string | true,
  next: number,
): number | ParseResult {
  if (flag[2] === "bool" && value !== true && parseGoBool(value) === undefined) {
    return failure("invalid_bool", `invalid argument "${value}" for --${flag[0]}`);
  }
  state.occurrences.push({ flag, value });
  return next;
}

function collect(path: readonly string[], state: FlagParseState): ParseResult {
  const grouped = new Map<string, Occurrence[]>();
  for (const occurrence of state.occurrences) {
    const name = occurrence.flag[0];
    grouped.set(name, [...(grouped.get(name) ?? []), occurrence]);
  }
  const flags: Record<string, CliFlagValue> = {};
  for (const [name, occurrences] of grouped) flags[name] = flagValue(occurrences);
  const help = state.helpRequested || flags["help"] === true;
  return {
    ok: true,
    args: {
      path,
      flags,
      positionals: state.positionals,
      ...(state.argsLenAtDash !== undefined && { argsLenAtDash: state.argsLenAtDash }),
      help,
    },
  };
}

function flagValue(occurrences: readonly Occurrence[]): CliFlagValue {
  const last = occurrences[occurrences.length - 1] as Occurrence;
  if (last.flag[2] === "bool") {
    return last.value === true || parseGoBool(last.value) === true ? true : "false";
  }
  if (occurrences.length === 1) return last.value;
  return occurrences.map(({ value }) => (value === true ? "" : value));
}

/** Go's strconv.ParseBool, which pflag uses for bool flags. */
export function parseGoBool(value: string): boolean | undefined {
  if (["1", "t", "T", "true", "TRUE", "True"].includes(value)) return true;
  if (["0", "f", "F", "false", "FALSE", "False"].includes(value)) return false;
  return undefined;
}

function normalize(table: CommandTable, name: string): string {
  return table.normalizeUnderscores ? name.replaceAll("_", "-") : name;
}

function failure(reason: ParseFailureReason, detail: string): ParseResult {
  return { ok: false, reason, detail };
}

function commandName(table: CommandTable, command: IndexedCommand): string {
  return [table.cli, ...command.path].join(" ");
}

function lookup(index: IndexedTable, key: string): IndexedCommand {
  const command = index.commands.get(key);
  if (command === undefined) throw new Error(`${index.table.cli} table has no command "${key}"`);
  return command;
}

/** Builds (once per table) the child maps and per-command flag sets. */
function indexTable(table: CommandTable): IndexedTable {
  const cached = indexes.get(table);
  if (cached !== undefined) return cached;
  const keys = Object.keys(table.commands);
  if (!keys.includes("")) throw new Error(`${table.cli} table has no root command`);
  const commands = new Map<string, IndexedCommand>();
  for (const key of keys) {
    const def = table.commands[key] as CommandDef;
    const path = key === "" ? [] : key.split(" ");
    // Nearest first: cobra merges the command's own flags, then each
    // ancestor's persistent flags walking up, and an earlier name shadows a
    // later one.
    const inherited = ancestorKeys(path)
      .reverse()
      .flatMap((ancestor) => {
        const ancestorDef = table.commands[ancestor];
        if (ancestorDef === undefined) {
          throw new Error(`${table.cli} table has "${key}" but not its parent "${ancestor}"`);
        }
        return ancestorDef.persistent ?? [];
      });
    const findFlags = flagSet(table, key, [
      ...(def.local ?? []),
      ...(def.persistent ?? []),
      ...inherited,
    ]);
    const runFlags = table.defaultHelpFlag ? withDefaultHelp(findFlags) : findFlags;
    commands.set(key, { path, def, children: childMap(table, path), findFlags, runFlags });
  }
  const index: IndexedTable = { table, commands };
  indexes.set(table, index);
  return index;
}

function ancestorKeys(path: readonly string[]): string[] {
  return path.map((_, depth) => path.slice(0, depth).join(" "));
}

function childMap(table: CommandTable, path: readonly string[]): Map<string, string> {
  const children = new Map<string, string>();
  for (const [key, def] of Object.entries(table.commands)) {
    const childPath = key === "" ? [] : key.split(" ");
    if (childPath.length !== path.length + 1) continue;
    if (!path.every((segment, i) => childPath[i] === segment)) continue;
    const name = childPath[path.length] as string;
    for (const word of [name, ...(def.aliases ?? [])]) {
      if (!children.has(word)) children.set(word, key);
    }
  }
  return children;
}

/** cobra's InitDefaultHelpFlag: `-h/--help`, or just `--help` when `-h` is taken. */
function withDefaultHelp(flags: FlagSet): FlagSet {
  if (flags.long.has("help")) return flags;
  const help: FlagDef = ["help", flags.short.has("h") ? "" : "h", "bool"];
  const long = new Map(flags.long).set("help", help);
  const short = help[1] === "" ? flags.short : new Map(flags.short).set("h", help);
  return { long, short };
}

function flagSet(table: CommandTable, key: string, defs: readonly FlagDef[]): FlagSet {
  const long = new Map<string, FlagDef>();
  const short = new Map<string, FlagDef>();
  for (const def of defs) {
    const [name, shorthand] = def;
    if (long.has(name)) continue;
    long.set(name, def);
    if (shorthand === "") continue;
    if (short.has(shorthand)) throw new Error(`${table.cli} "${key}" defines -${shorthand} twice`);
    short.set(shorthand, def);
  }
  return { long, short };
}
