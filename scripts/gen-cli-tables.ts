/**
 * `pnpm gen:cli-tables --gh=/usr/bin/gh --kubectl=/usr/local/bin/kubectl`:
 * regenerates the gh and kubectl command tables under
 * src/definitions/cli/generated/ from the binaries themselves.
 *
 * The help text gives the command tree and flag names; probes against the
 * real binary confirm what help text can't: whether each flag needs a value,
 * whether a group's flag is inherited by its subcommands, and whether cobra
 * parses a command's flags at all. Every probe asks for `--help`, which cobra
 * honours only after flag parsing succeeds, so a probe prints help (or a flag
 * error) and runs nothing. Probes still run under bubblewrap with no network
 * and a read-only filesystem, with a clean config and kuberc disabled exactly
 * as the runner will invoke the binary, so local aliases and extensions never
 * leak into the table.
 */
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { CommandDef, CommandTable, FlagDef } from "../src/definitions/cli/cobra.ts";
import {
  classifyProbe,
  flagKind,
  type ListedCommand,
  type ListedFlag,
  parseGhReference,
  parseKubectlHelp,
  renderTable,
  toFlagDef,
} from "./lib/cli-tables.ts";

const root = join(import.meta.dirname, "..");
const OUT_DIR = join(root, "src/definitions/cli/generated");
const UNKNOWN_FLAG = "heel-probe-unknown-flag";
const PROBE_WORD = "heel-probe-word";
const CONCURRENCY = 16;

const { values } = parseArgs({
  options: { gh: { type: "string" }, kubectl: { type: "string" } },
});
if (values.gh === undefined || values.kubectl === undefined) {
  console.error("usage: pnpm gen:cli-tables --gh=<absolute path> --kubectl=<absolute path>");
  process.exit(64);
}

interface ProbeResult {
  readonly code: number;
  readonly output: string;
}

type Prober = (args: readonly string[]) => Promise<ProbeResult>;

function sandboxedProber(bin: string): Prober {
  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin",
    HOME: "/tmp",
    LANG: "C",
    NO_COLOR: "1",
    GH_CONFIG_DIR: "/tmp/gh",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_PROMPT_DISABLED: "1",
    KUBECONFIG: "/dev/null",
    KUBECTL_KUBERC: "false",
  };
  const bwrap = [
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--ro-bind",
    "/",
    "/",
    "--tmpfs",
    "/tmp",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--chdir",
    "/tmp",
    "--clearenv",
    ...Object.entries(env).flatMap(([key, value]) => ["--setenv", key, value]),
    "--",
    bin,
  ];
  return (args) =>
    new Promise((resolve) => {
      execFile(
        "bwrap",
        [...bwrap, ...args],
        { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
          resolve({ code, output: `${stdout}${stderr}` });
        },
      ).stdin?.end();
    });
}

/** Runs `tasks` with at most CONCURRENCY in flight, keeping their order. */
async function pool<T>(tasks: readonly (() => Promise<T>)[]): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      results[index] = await (tasks[index] as () => Promise<T>)();
    }
  });
  await Promise.all(workers);
  return results;
}

function key(path: readonly string[]): string {
  return path.join(" ");
}

function isChildOf(child: readonly string[], parent: readonly string[]): boolean {
  return child.length === parent.length + 1 && parent.every((word, i) => child[i] === word);
}

interface ProbedCommand {
  readonly listed: ListedCommand;
  readonly rawArgs: boolean;
  readonly interspersed: boolean;
}

async function probeCommand(
  probe: Prober,
  listed: ListedCommand,
  hasChildren: boolean,
): Promise<ProbedCommand> {
  // A command that takes its arguments raw sees `--help` as an argument and
  // may refuse it (gh's auth check does), so this probe comes first.
  const unknown = await probe([...listed.path, `--${UNKNOWN_FLAG}`]);
  const rawArgs = classifyProbe(unknown.output, UNKNOWN_FLAG) !== "unknown";
  if (rawArgs) return { listed, rawArgs, interspersed: true };
  const help = await probe([...listed.path, "--help"]);
  if (help.code !== 0) {
    throw new Error(`"${key(listed.path)} --help" exited ${help.code}:\n${help.output}`);
  }
  // Under a command with subcommands a positional is an unknown command
  // either way (gh even tries it as an extension), so only leaves are probed.
  if (hasChildren) return { listed, rawArgs, interspersed: true };
  const afterWord = await probe([...listed.path, "--help", PROBE_WORD, `--${UNKNOWN_FLAG}`]);
  const interspersed = classifyProbe(afterWord.output, UNKNOWN_FLAG) === "unknown";
  return { listed, rawArgs, interspersed };
}

async function probeFlag(
  cli: "gh" | "kubectl",
  probe: Prober,
  command: ProbedCommand,
  flag: ListedFlag,
  probedChild: readonly string[] | undefined,
): Promise<{ def: FlagDef; persistent: boolean }> {
  const path = command.listed.path;
  const arity = await probe([...path, "--help", `--${flag.long}`]);
  const outcome = classifyProbe(arity.output, flag.long);
  if (outcome === "unknown") throw new Error(`${cli} ${key(path)}: --${flag.long} is not a flag`);
  if (flag.short !== "") {
    const short = await probe([...path, "--help", `-${flag.short}`]);
    if (short.output.includes(`unknown shorthand flag: '${flag.short}'`)) {
      throw new Error(`${cli} ${key(path)}: -${flag.short} is not a flag`);
    }
  }
  let persistent = false;
  if (probedChild !== undefined) {
    const inherited = await probe([...probedChild, "--help", `--${flag.long}`]);
    persistent = classifyProbe(inherited.output, flag.long) !== "unknown";
  }
  return { def: toFlagDef(flag, flagKind(cli, flag, outcome === "needs_value")), persistent };
}

/** A subcommand that parses flags and doesn't list `flag` itself, to test inheritance. */
function inheritanceProbe(
  probed: readonly ProbedCommand[],
  parent: readonly string[],
  flag: ListedFlag,
): readonly string[] | undefined {
  const child = probed.find(
    (candidate) =>
      isChildOf(candidate.listed.path, parent) &&
      !candidate.rawArgs &&
      !candidate.listed.flags.some((listed) => listed.long === flag.long),
  );
  return child?.listed.path;
}

async function buildTable(
  cli: "gh" | "kubectl",
  version: string,
  listed: readonly ListedCommand[],
  probe: Prober,
  options: Pick<CommandTable, "normalizeUnderscores" | "defaultHelpFlag">,
): Promise<CommandTable> {
  const probed = await pool(
    listed.map(
      (command) => () =>
        probeCommand(
          probe,
          command,
          listed.some((other) => isChildOf(other.path, command.path)),
        ),
    ),
  );
  const flagJobs = probed.flatMap((command) =>
    command.rawArgs
      ? []
      : command.listed.flags.map((flag) => async () => ({
          command,
          ...(await probeFlag(
            cli,
            probe,
            command,
            flag,
            inheritanceProbe(probed, command.listed.path, flag),
          )),
        })),
  );
  const flags = await pool(flagJobs);
  const commands: Record<string, CommandDef> = {};
  for (const command of probed) {
    const own = flags.filter((flag) => flag.command === command);
    const inherited = inheritedFlags(command.listed.path, flags);
    const fresh = own.filter(({ def }) => !inherited.some((parent) => sameFlag(parent, def)));
    const local = fresh.filter((flag) => !flag.persistent).map((flag) => flag.def);
    const persistent = fresh.filter((flag) => flag.persistent).map((flag) => flag.def);
    commands[key(command.listed.path)] = {
      ...(command.listed.aliases.length > 0 && { aliases: command.listed.aliases }),
      ...(local.length > 0 && { local }),
      ...(persistent.length > 0 && { persistent }),
      ...(!command.interspersed && { interspersed: false as const }),
      ...(command.rawArgs && { rawArgs: true as const }),
    };
  }
  return { cli, version, ...options, commands };
}

function inheritedFlags(
  path: readonly string[],
  flags: readonly { command: ProbedCommand; def: FlagDef; persistent: boolean }[],
): FlagDef[] {
  return flags
    .filter(
      ({ command, persistent }) =>
        persistent &&
        command.listed.path.length < path.length &&
        command.listed.path.every((word, i) => path[i] === word),
    )
    .map(({ def }) => def);
}

function sameFlag(a: FlagDef, b: FlagDef): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

async function ghTable(bin: string): Promise<CommandTable> {
  const probe = sandboxedProber(bin);
  const version = /gh version (\S+)/.exec((await probe(["--version"])).output)?.[1];
  if (version === undefined) throw new Error("could not read gh --version");
  const reference = await probe(["help", "reference"]);
  if (reference.code !== 0) throw new Error(`gh help reference failed:\n${reference.output}`);
  // The reference has no section for the root; gh defines these two itself.
  const rootCommand: ListedCommand = {
    path: [],
    aliases: [],
    flags: [
      { long: "help", short: "" },
      { long: "version", short: "" },
    ],
  };
  const listed = [rootCommand, ...parseGhReference(reference.output)];
  return buildTable("gh", version, listed, probe, {
    normalizeUnderscores: false,
    defaultHelpFlag: false,
  });
}

async function kubectlTable(bin: string): Promise<CommandTable> {
  const probe = sandboxedProber(bin);
  const versionOutput = (await probe(["version", "--client"])).output;
  const version = /Client Version: v?(\S+)/.exec(versionOutput)?.[1];
  if (version === undefined) throw new Error("could not read kubectl version --client");
  const globals = parseKubectlHelp((await probe(["options"])).output).flags;
  const listed: ListedCommand[] = [{ path: [], aliases: [], flags: globals }];
  let frontier: (readonly string[])[] = [[]];
  while (frontier.length > 0) {
    const pages = await pool(
      frontier.map((path) => async () => {
        const page = await probe([...path, "--help"]);
        if (page.code !== 0) throw new Error(`kubectl ${key(path)} --help failed:\n${page.output}`);
        return { path, page: parseKubectlHelp(page.output) };
      }),
    );
    frontier = [];
    for (const { path, page } of pages) {
      if (path.length > 0) listed.push({ path, aliases: page.aliases, flags: page.flags });
      frontier.push(...page.subcommands.map((name) => [...path, name]));
    }
  }
  return buildTable("kubectl", version, listed, probe, {
    normalizeUnderscores: true,
    defaultHelpFlag: true,
  });
}

function formatGenerated(files: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      join(root, "node_modules/.bin/biome"),
      ["format", "--write", ...files],
      (error, _stdout, stderr) => (error === null ? resolve() : reject(new Error(stderr))),
    );
  });
}

const [gh, kubectl] = await Promise.all([ghTable(values.gh), kubectlTable(values.kubectl)]);
const ghFile = join(OUT_DIR, "gh-table.ts");
const kubectlFile = join(OUT_DIR, "kubectl-table.ts");
writeFileSync(ghFile, renderTable("GH_TABLE", gh, `gh ${gh.version}`));
writeFileSync(kubectlFile, renderTable("KUBECTL_TABLE", kubectl, `kubectl ${kubectl.version}`));
await formatGenerated([ghFile, kubectlFile]);
process.stdout.write(
  `gh ${gh.version}: ${Object.keys(gh.commands).length} commands\n` +
    `kubectl ${kubectl.version}: ${Object.keys(kubectl.commands).length} commands\n`,
);
