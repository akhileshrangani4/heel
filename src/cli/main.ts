import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { AdminClientError, adminCall } from "../admin/client.ts";
import { type AdminRequest, AUDIT_EXPORT_MAX_PAGE } from "../admin/protocol.ts";
import { AdminSocketError } from "../admin/server.ts";
import { defaultHeelHome } from "../config/load.ts";
import type { HeelConfig, ListenAddress } from "../config/schema.ts";
import { signInSetupFor } from "../definitions/sign-in-setup.ts";
import { createLogger } from "../log.ts";
import { type RunningHeel, startHeel } from "../serve.ts";
import { hasErrnoCode } from "../util/errno.ts";
import { createMasterKeyFile } from "../vault/key.ts";
import { SecretFileError } from "../vault/secret-file.ts";
import { HEEL_VERSION } from "../version.ts";
import {
  type CliIo,
  CONFIG_OPTION,
  ConfigError,
  configFrom,
  EXIT,
  formatTable,
  JSON_OPTION,
  onePositional,
  parseOrUsage,
  RefusedError,
  shortTime,
  UsageError,
} from "./common.ts";
import { RULES_USAGE, rulesCommand } from "./rules.ts";

export { type CliIo, EXIT } from "./common.ts";

import { runCommand } from "./run.ts";

/** What the list admin methods return, as the tables read it. */
interface AgentRow {
  name: string;
  owner: string;
  createdAt: string;
  revokedAt: string | null;
  tokenExpiresAt: string | null;
  hasToken: boolean;
}
interface AccountRow {
  alias: string;
  provider: string;
  owner: string;
  status: string;
  credentialDelivery: string | null;
}
interface PauseRowView {
  scope: string;
  targetName: string;
  pausedAt: string;
  pausedBy: string;
}
interface StandingRowView {
  id: string;
  agent: string;
  account: string | null;
  scope: string;
  expiresAt: string;
  revokedAt: string | null;
}

export const USAGE = `usage:
  heel init [--home <dir>] [--yes]        set heel up: its home, master key, heel.yaml
                                          and starter rules; changes nothing that's
                                          already there
  heel serve [--watch]                    start the agent, human and admin planes,
                                          in this terminal (Ctrl-C stops it)
  heel start [--watch]                    the same, in the background: returns once
                                          heel is up, and writes its log to
                                          $HEEL_HOME/logs/heel.log
  heel stop                               stop the running heel, in the background or not
  heel restart [--watch]                  stop heel, then start it in the background
  heel logs [-f] [-n <lines>] [--json]    heel's log from heel start; -f follows it live
  heel status                             what heel is doing: agents, accounts,
                                          pauses and requests waiting for you
  heel tui                                a live full-screen view of requests,
                                          activity, agents and accounts; Enter
                                          opens a request in the browser
  heel update [--check]                   move heel to the newest version on npm, the
                                          way it was installed; --check only says
                                          whether there is one
  heel vault init                         create the master key file
  heel agent add <name> [--owner <user>] [--expires <days>d|never]
                                          add an agent; prints its token once. The
                                          token expires in 90 days unless --expires
                                          says otherwise
  heel agent workdir <name>               list the directories heel run may work in
  heel agent workdir <name> <dir>...      set them (replaces the list); each <dir> is
                                          an absolute path that exists on heel's host
  heel agent workdir <name> --clear       remove them all: heel run is then refused
  heel agent rotate <name> [--expires <days>d|never]
                                          replace an agent's token (renews it; no
                                          passkey needed)
  heel agent revoke <name>                revoke an agent's token
  heel agent list
  heel connect <provider> --as <alias> [--owner <user>] [--credential-stdin]
  heel connect gmail|google-calendar|outlook --as <alias> [--owner <user>]
                                          add a Gmail, Google Calendar or Outlook
                                          account; its owner signs in with Google or
                                          Microsoft from the Connections page, once
                                          heel.yaml has your OAuth client
                                          (providers.google or providers.microsoft)
  heel connect mcp --as <alias> --url <upstream> [--credential-stdin | --oauth]
                                          put a remote MCP server behind heel; a
                                          token on stdin is sent to it as a bearer,
                                          or with --oauth its owner signs in from
                                          the Connections page
  heel connect http --as <alias> --base-url <url> --openapi <file>
                   --auth bearer|basic|header:<name>|query:<name> --credential-stdin
                                          put an API behind heel's HTTP proxy at
                                          /http/<alias>/…
  heel connect mcp --as <alias> --command <path> [--arg <a>]... [--egress <host>]...
                   [--mount <path>]... [--credential-env <NAME> --credential-stdin
                   (--credential-host <host>... [--credential-auth bearer|basic|header:<Name>]
                    | --credential-delivery env)]
                                          run a local MCP server in heel's sandbox;
                                          it gets a placeholder in <NAME>, and heel
                                          adds the credential to its requests to
                                          each --credential-host. --credential-delivery
                                          env puts the credential itself in <NAME>
                                          instead, where the server can read it
  heel run [--account <alias>] [--reason <text>] [--json] -- <cmd> [args...]
                                          (agent side) ask heel to run a command;
                                          reads HEEL_TOKEN (the agent's token),
                                          HEEL_URL (heel's agent plane, such as
                                          http://127.0.0.1:7300) and HEEL_RUN_ID.
                                          heel runs it on its own host, in this
                                          directory, which must be under one of
                                          the agent's workdirs on heel's host
  heel connect cli <command> --as <alias> --bin <path> [--egress <host>]...
                   [--credential-env <NAME>] --credential-stdin
                   [--credential-host <host>... [--credential-auth bearer|basic|header:<Name>]
                    | --credential-delivery env]
                                          let agents run a CLI (gh, npm, ...) through
                                          heel with \`heel run\`. gh, and a CLI with
                                          --credential-host, get a placeholder and
                                          heel adds the credential on the wire; npm
                                          needs no --credential-env, only its
                                          registry as --egress and --credential-host
  heel account list
  heel account set <alias> --credential-stdin
                                          replace an account's API key or token
                                          (read from stdin); settings stay as they are
  heel account set <alias> (--credential-host <host>... [--credential-auth bearer|basic|header:<Name>]
                   | --credential-delivery env) [--credential-stdin]
                                          move a local MCP server's or a CLI's
                                          credential out of its sandbox, to heel's
                                          egress proxy (or, knowingly, into its
                                          environment)
  heel account remove <alias>             delete an account and its stored
                                          credential; ends its pending approvals,
                                          and the standing approvals and grants
                                          that name it
  heel account share|unshare <alias> --user <name> | --group <group>
                                          let another person's agents use an account
  heel account approvers <alias> [--repo <owner/name>] [--user <name>]... [--group <group>]...
                                          who decides its asks (default: the owner);
                                          no --user or --group clears that scope
  heel account sharing <alias>
  heel user enroll <user>                 print a one-time passkey enrollment link
                                          (valid 15 minutes; also adds a device or
                                          recovers a lost passkey)
  heel user email <user> <address>|--clear
                                          where email and Slack notifications reach
                                          this person
  heel pause --all | --agent <name> | --account <alias> | --owner <user>
                                          stop calls in that scope at once; resuming
                                          needs a passkey on the approval page
  heel pause list
  heel approvals list                     list standing approvals
  heel approvals revoke <id>              revoke a standing approval
  heel audit export [--since <time>] [--until <time>] [--format jsonl]
                                          write audit rows as JSON Lines to stdout;
                                          <time> is ISO 8601, YYYY-MM-DD (UTC), or
                                          a duration ago such as 90m, 24h, 7d
${RULES_USAGE}
Every command takes --config <file>; the default is $HEEL_HOME/heel.yaml.
`;

const IssuedAgentResult = z.object({
  name: z.string(),
  token: z.string(),
  expiresAt: z.string().nullable().default(null),
});
const ConnectedAccountResult = z.object({
  alias: z.string(),
  provider: z.string(),
  status: z.string(),
  /** For accounts that sign in from the Connections page: whether heel has the client for it. */
  signIn: z.enum(["ready", "needs_setup"]).nullable().default(null),
});
const EnrollmentResult = z.object({
  url: z.string(),
  expiresAt: z.string(),
  /** The IdP identity the user signs in as, on a team install. */
  subject: z.string().nullable().default(null),
  activeFrom: z.string().nullable().optional(),
});
const WorkRootsResult = z.object({ name: z.string(), workRoots: z.array(z.string()) });
const PauseResult = z.object({ scope: z.string(), created: z.boolean() });
const ConfiguredAccountResult = z.object({
  alias: z.string(),
  credentialDelivery: z.string().nullable(),
  rotate: z.boolean(),
});

const AuditExportPageResult = z.object({
  lines: z.array(z.string()),
  throughId: z.int(),
  nextAfterId: z.int(),
  done: z.boolean(),
});

const DURATION_UNITS_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/**
 * Pure: an `--since`/`--until` value as an ISO 8601 instant. Accepts a full
 * timestamp with offset, a date (midnight UTC), or a duration before `now`
 * (`90m`, `24h`, `7d`). Null when the text is none of these.
 */
export function parseExportTime(text: string, now: Date): string | null {
  const duration = /^(\d{1,6})([mhd])$/.exec(text);
  if (duration) {
    const [, amount, unit] = duration;
    const ms = Number(amount) * DURATION_UNITS_MS[unit as keyof typeof DURATION_UNITS_MS];
    return new Date(now.getTime() - ms).toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const date = new Date(`${text}T00:00:00Z`);
    return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text
      ? null
      : date.toISOString();
  }
  if (z.iso.datetime({ offset: true }).safeParse(text).success) {
    return new Date(text).toISOString();
  }
  return null;
}

/** Pure: the MCP URL an agent should be given, from the agent plane's listen address. */
export function agentMcpUrl(listen: ListenAddress, publicUrl: URL | null = null): string {
  // Direct tools work on every host; code mode (bare /mcp) needs the Linux sandbox.
  if (publicUrl !== null)
    return new URL("mcp?tools=direct", publicUrl.href.replace(/\/?$/, "/")).href;
  // A wildcard listen address (a container) is reached at localhost, not 0.0.0.0.
  const wildcard = listen.host === "0.0.0.0" || listen.host === "::";
  const host = wildcard
    ? "localhost"
    : listen.host.includes(":")
      ? `[${listen.host}]`
      : listen.host;
  return `http://${host}:${listen.port}/mcp?tools=direct`;
}

/** Sends one admin request; a refusal becomes a RefusedError carrying heel's message. */
async function admin(config: HeelConfig, request: AdminRequest): Promise<unknown> {
  const response = await adminCall(config.adminSocketPath, request);
  if (!response.ok) throw new RefusedError(`${response.error.message} (${response.error.code})`);
  return response.result;
}

async function readAll(stdin: AsyncIterable<string | Buffer>): Promise<string> {
  let text = "";
  for await (const chunk of stdin)
    text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  return text;
}

function waitForShutdownSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    const onSignal = (signal: NodeJS.Signals): void => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolve(signal);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}

async function serveCommand(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({
      args,
      options: { ...CONFIG_OPTION, watch: { type: "boolean" } },
      allowPositionals: true,
      strict: true,
    }),
  );
  if (positionals.length > 0) throw new UsageError(`unexpected argument "${positionals[0]}"`);
  const config = configFrom(io, values.config);
  const log = createLogger(config.log.level);
  const heel = await startHeel({
    config,
    env: io.env,
    log,
    version: HEEL_VERSION,
    watch: values.watch ?? false,
  });
  io.stderr.write(startupBanner(config.publicUrl, heel.planes));
  const signal = await waitForShutdownSignal();
  log.info({ signal }, "shutting down");
  await heel.close();
  return EXIT.ok;
}

/** `heel start`: `heel serve` in the background (src/cli/background.ts). */
async function startCommand(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({
      args,
      options: { ...CONFIG_OPTION, watch: { type: "boolean" } },
      allowPositionals: true,
      strict: true,
    }),
  );
  if (positionals.length > 0) throw new UsageError(`unexpected argument "${positionals[0]}"`);
  const config = configFrom(io, values.config);
  const { logFileOf, startInBackground } = await import("./background.ts");
  const serveArgs = [
    ...(values.watch === true ? ["--watch"] : []),
    ...(values.config === undefined ? [] : ["--config", resolve(values.config)]),
  ];
  const outcome = await startInBackground(config, io.env, serveArgs);
  const logs = logFileOf(config);
  switch (outcome.kind) {
    case "already":
      io.stdout.write(
        `heel ${outcome.ping.version ?? ""} is already running${outcome.ping.background === true ? " in the background" : " (heel serve, in another terminal)"}.\n`,
      );
      return EXIT.ok;
    case "failed":
      io.stderr.write(`heel: heel didn't start: ${outcome.reason}. See: heel logs\n  (${logs})\n`);
      return EXIT.unavailable;
    case "started":
      io.stdout.write(
        [
          `heel is running in the background (pid ${outcome.pid}).`,
          `  Approve requests:   open ${config.publicUrl.origin}`,
          `  Agents connect to:  http://${config.listen.agent.host}:${config.listen.agent.port}/mcp`,
          "  Live logs:          heel logs -f",
          "  Stop:               heel stop",
          "",
        ].join("\n"),
      );
      return EXIT.ok;
  }
}

/** `heel stop`: the running heel, wherever it was started. */
async function stopCommand(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({ args, options: CONFIG_OPTION, allowPositionals: true, strict: true }),
  );
  if (positionals.length > 0) throw new UsageError(`unexpected argument "${positionals[0]}"`);
  const config = configFrom(io, values.config);
  const { stopHeel } = await import("./background.ts");
  const outcome = await stopHeel(config);
  switch (outcome.kind) {
    case "not_running":
      io.stdout.write("heel isn't running.\n");
      return EXIT.ok;
    case "stopped":
      io.stdout.write(`heel stopped (pid ${outcome.pid}).\n`);
      return EXIT.ok;
    case "failed":
      io.stderr.write(`heel: couldn't stop heel: ${outcome.reason}\n`);
      return EXIT.failed;
  }
}

/** `heel restart`: stop, then start in the background. */
async function restartCommand(args: string[], io: CliIo): Promise<number> {
  const { values } = parseOrUsage(() =>
    parseArgs({
      args,
      options: { ...CONFIG_OPTION, watch: { type: "boolean" } },
      allowPositionals: true,
      strict: true,
    }),
  );
  const stopped = await stopCommand(
    values.config === undefined ? [] : ["--config", values.config],
    io,
  );
  if (stopped !== EXIT.ok) return stopped;
  return startCommand(args, io);
}

/** `heel logs`: the background heel's log, readable; `-f` follows it. */
async function logsCommand(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({
      args,
      options: {
        ...CONFIG_OPTION,
        follow: { type: "boolean", short: "f" },
        lines: { type: "string", short: "n" },
        json: { type: "boolean" },
      },
      allowPositionals: true,
      strict: true,
    }),
  );
  if (positionals.length > 0) throw new UsageError(`unexpected argument "${positionals[0]}"`);
  const count = values.lines === undefined ? 50 : Number.parseInt(values.lines, 10);
  if (!Number.isInteger(count) || count < 0) throw new UsageError("-n takes a number of lines");
  const config = configFrom(io, values.config);
  const { followFile, formatLogLine, lastLines, logFileOf, pingHeel } = await import(
    "./background.ts"
  );
  const file = logFileOf(config);
  const show = (line: string) =>
    io.stdout.write(`${values.json === true ? line : formatLogLine(line)}\n`);
  if (!existsSync(file)) {
    const ping = await pingHeel(config);
    io.stderr.write(
      ping === null
        ? "heel has no log yet. Start it in the background with: heel start\n"
        : "This heel runs in a terminal (heel serve), so its log is there. For a log here, run it with: heel start\n",
    );
    return values.follow === true && ping === null ? EXIT.unavailable : EXIT.ok;
  }
  for (const line of lastLines(file, count)) show(line);
  if (values.follow !== true) return EXIT.ok;
  await followFile(file, statSync(file).size, show);
  return EXIT.ok;
}

/**
 * Pure: the plain lines `heel serve` prints once it is up, after the JSON
 * logs, so a person sees where to go without reading them.
 */
export function startupBanner(
  publicUrl: URL,
  planes: Pick<RunningHeel["planes"], "agent" | "human">,
): string {
  const lines = ["", "heel is running."];
  if (planes.human.state === "listening") {
    lines.push(`  Approve requests:   open ${publicUrl.origin}`);
  } else {
    lines.push(`  Approval page:      off (${planes.human.reason})`);
  }
  if (planes.agent.state === "listening") {
    lines.push(`  Agents connect to:  ${new URL("/mcp", planes.agent.url).href}`);
  } else {
    lines.push(`  Agent port:         off (${planes.agent.reason})`);
  }
  lines.push("  Stop with Ctrl-C. To run it in the background instead: heel start", "");
  return `${lines.join("\n")}\n`;
}

function vaultCommand(args: string[], io: CliIo): number {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({ args, options: CONFIG_OPTION, allowPositionals: true, strict: true }),
  );
  if (onePositional(positionals, "vault subcommand") !== "init") {
    throw new UsageError(`unknown vault subcommand "${positionals[0]}"`);
  }
  const config = configFrom(io, values.config);
  const keyFile = config.vault.keyFile;
  mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
  try {
    createMasterKeyFile(keyFile);
  } catch (error) {
    if (hasErrnoCode(error, "EEXIST")) {
      throw new RefusedError(`${keyFile} already exists; heel never replaces a master key`);
    }
    throw error;
  }
  io.stdout.write(
    `Created the master key at ${keyFile}.\nBack it up: without it, stored credentials can't be decrypted.\n`,
  );
  return EXIT.ok;
}

/** `--expires 30d`, `--expires 90`, or `--expires never` (null). */
function expiresFlag(text: string): number | null {
  if (text === "never") return null;
  const days = /^(\d{1,4})d?$/.exec(text);
  const n = days === null ? Number.NaN : Number(days[1]);
  if (!Number.isInteger(n) || n < 1 || n > 3650) {
    throw new UsageError(
      `--expires takes a number of days (such as 30d or 90d) or never, not "${text}"`,
    );
  }
  return n;
}

/** Pure: the line `heel agent add` and `rotate` print about the new token's expiry. */
export function expiresLine(name: string, expiresAt: string | null): string {
  if (expiresAt === null) {
    return (
      "Expires: never (--expires never). Rotate it if it may have leaked: heel agent rotate " + name
    );
  }
  return `Expires: ${expiresAt.slice(0, 10)}. Before then, get a new one with: heel agent rotate ${name}`;
}

async function agentCommand(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({
      args,
      options: {
        ...CONFIG_OPTION,
        ...JSON_OPTION,
        owner: { type: "string" },
        clear: { type: "boolean" },
        expires: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    }),
  );
  const [subcommand, ...rest] = positionals;
  if (values.clear === true && subcommand !== "workdir") {
    throw new UsageError("--clear is for heel agent workdir");
  }
  if (values.expires !== undefined && subcommand !== "add" && subcommand !== "rotate") {
    throw new UsageError("--expires is for heel agent add and heel agent rotate");
  }
  const expiry = values.expires === undefined ? {} : { expiresInDays: expiresFlag(values.expires) };
  const config = configFrom(io, values.config);
  switch (subcommand) {
    case "add": {
      const name = onePositional(rest, "agent name");
      const params = {
        name,
        ...(values.owner === undefined ? {} : { owner: values.owner }),
        ...expiry,
      };
      const issued = IssuedAgentResult.parse(await admin(config, { method: "agent.add", params }));
      io.stdout.write(
        `Added agent "${issued.name}".\n` +
          `Token (shown once; heel keeps only its hash): ${issued.token}\n` +
          `${expiresLine(issued.name, issued.expiresAt)}\n` +
          `MCP URL: ${agentMcpUrl(config.listen.agent, config.agentPublicUrl)}\n`,
      );
      return EXIT.ok;
    }
    case "workdir": {
      const [name, ...roots] = rest;
      if (name === undefined) throw new UsageError("missing agent name");
      if (values.clear === true && roots.length > 0) {
        throw new UsageError("give either directories or --clear");
      }
      // No directories lists them; only --clear empties the list.
      const request: AdminRequest =
        values.clear === true || roots.length > 0
          ? { method: "agent.workdirs", params: { name, workRoots: roots } }
          : { method: "agent.workdirs.list", params: { name } };
      const { workRoots } = WorkRootsResult.parse(await admin(config, request));
      io.stdout.write(
        workRoots.length === 0
          ? `"${name}" has no workdirs, so heel run refuses its commands.\n` +
              `Add one with: heel agent workdir ${name} <dir>\n`
          : `"${name}" may run commands in:\n${workRoots.map((root) => `  ${root}\n`).join("")}`,
      );
      return EXIT.ok;
    }
    case "rotate": {
      const name = onePositional(rest, "agent name");
      const issued = IssuedAgentResult.parse(
        await admin(config, { method: "agent.rotate", params: { name, ...expiry } }),
      );
      io.stdout.write(
        `Rotated the token for "${issued.name}". The old token no longer works.\n` +
          `Token (shown once): ${issued.token}\n` +
          `${expiresLine(issued.name, issued.expiresAt)}\n`,
      );
      return EXIT.ok;
    }
    case "revoke": {
      const name = onePositional(rest, "agent name");
      await admin(config, { method: "agent.revoke", params: { name } });
      io.stdout.write(`Revoked agent "${name}". Its next call is rejected.\n`);
      return EXIT.ok;
    }
    case "list": {
      if (rest.length > 0) throw new UsageError(`unexpected argument "${rest[0]}"`);
      const listed = await admin(config, { method: "agent.list" });
      if (values.json) {
        io.stdout.write(`${JSON.stringify(listed, null, 2)}\n`);
        return EXIT.ok;
      }
      const rows = (listed as AgentRow[]).map((a) => [
        a.name,
        a.owner,
        a.revokedAt === null ? "active" : `revoked ${shortTime(a.revokedAt)}`,
        a.revokedAt !== null || !a.hasToken
          ? ""
          : a.tokenExpiresAt === null
            ? "never"
            : shortTime(a.tokenExpiresAt),
        shortTime(a.createdAt),
      ]);
      io.stdout.write(
        formatTable(
          ["name", "owner", "status", "token expires (UTC)", "added (UTC)"],
          rows,
          "No agents yet. Add one: heel agent add <name>",
        ),
      );
      return EXIT.ok;
    }
    default:
      throw new UsageError(
        subcommand === undefined
          ? "missing agent subcommand"
          : `unknown agent subcommand "${subcommand}"`,
      );
  }
}

/** `--credential-delivery env|proxy`, or null when it wasn't given. */
function deliveryFlag(value: string | undefined): "env" | "proxy" | null {
  if (value === undefined) return null;
  if (value === "env" || value === "proxy") return value;
  throw new UsageError("--credential-delivery is env or proxy");
}

/**
 * `heel connect`. A static credential comes from stdin, never argv, so it
 * stays out of shell history and the process list.
 */
async function connectCommand(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({
      args,
      options: {
        ...CONFIG_OPTION,
        as: { type: "string" },
        owner: { type: "string" },
        url: { type: "string" },
        oauth: { type: "boolean" },
        command: { type: "string" },
        arg: { type: "string", multiple: true },
        egress: { type: "string", multiple: true },
        mount: { type: "string", multiple: true },
        "credential-env": { type: "string" },
        "credential-host": { type: "string", multiple: true },
        "credential-auth": { type: "string" },
        "credential-delivery": { type: "string" },
        "credential-stdin": { type: "boolean" },
        "base-url": { type: "string" },
        auth: { type: "string" },
        openapi: { type: "string" },
        bin: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    }),
  );
  const [provider, cliCommand, ...extra] = positionals;
  if (provider === undefined) throw new UsageError("missing provider");
  if (provider !== "cli" && cliCommand !== undefined) {
    throw new UsageError(`unexpected argument "${cliCommand}"`);
  }
  if (extra.length > 0) throw new UsageError(`unexpected argument "${extra[0]}"`);
  if (provider === "cli" && (cliCommand === undefined || values.bin === undefined)) {
    throw new UsageError("heel connect cli <command> --bin <absolute path> --as <alias>");
  }
  if (values.as === undefined) throw new UsageError("missing --as <alias>");
  const config = configFrom(io, values.config);
  const delivery = deliveryFlag(values["credential-delivery"]);
  const sandboxed = provider === "cli" || values.command !== undefined;
  if (
    !sandboxed &&
    (delivery !== null ||
      values["credential-host"] !== undefined ||
      values["credential-auth"] !== undefined)
  ) {
    throw new UsageError(
      "--credential-host, --credential-auth and --credential-delivery are for heel connect cli and local MCP servers (--command)",
    );
  }
  const credentialFlags = {
    credentialHosts: values["credential-host"] ?? [],
    credentialAuth: values["credential-auth"] ?? null,
    ...(delivery === null ? {} : { credentialDelivery: delivery }),
  };
  let credential: { type: "static"; value: string } | undefined;
  if (values["credential-stdin"]) {
    const value = (await readAll(io.stdin)).replace(/\r?\n$/, "");
    if (value === "") throw new UsageError("--credential-stdin read nothing from stdin");
    credential = { type: "static", value };
  }
  const params = {
    provider,
    alias: values.as,
    ...(values.owner === undefined ? {} : { owner: values.owner }),
    ...(values.url === undefined ? {} : { url: values.url }),
    ...(values.oauth === true ? { oauth: true } : {}),
    ...(provider === "cli"
      ? {
          cli: {
            command: cliCommand as string,
            bin: values.bin as string,
            egress: values.egress ?? [],
            credentialEnv: values["credential-env"] ?? null,
            ...credentialFlags,
          },
        }
      : {}),
    ...(values.command === undefined
      ? {}
      : {
          stdio: {
            command: values.command,
            args: values.arg ?? [],
            egress: values.egress ?? [],
            credentialEnv: values["credential-env"] ?? null,
            ...credentialFlags,
            mounts: values.mount ?? [],
          },
        }),
    ...(provider === "http"
      ? {
          http: {
            baseUrl: values["base-url"] ?? "",
            auth: values.auth ?? "",
            openapi: values.openapi === undefined ? "" : readFileSync(values.openapi, "utf8"),
          },
        }
      : {}),
    ...(credential ? { credential } : {}),
  };
  const account = ConnectedAccountResult.parse(
    await admin(config, { method: "account.connect", params }),
  );
  io.stdout.write(`Connected ${account.provider} as "${account.alias}" (${account.status}).\n`);
  const setup = signInSetupFor(account.provider);
  if (account.signIn === "needs_setup" && setup !== null) {
    io.stdout.write(
      `It can't sign in yet: ${account.provider} needs your own ${setup.label} OAuth client as ${setup.configKey} in heel.yaml, then a restart. Steps: ${setup.docsUrl}\n`,
    );
  } else if (account.signIn === "ready") {
    io.stdout.write(
      `Next: sign in to it from the Connections page: ${new URL("/connections", config.publicUrl)}\n`,
    );
  }
  return EXIT.ok;
}

/**
 * `heel account list`, `heel account remove <alias>`,
 * `heel account set <alias> --credential-stdin` (a new key, settings kept),
 * `heel account set <alias> --credential-host <host>...
 * [--credential-auth <auth>]`, and sharing (D13b):
 * `heel account share|unshare <alias> --user <name> | --group <group>`,
 * `heel account approvers <alias> [--repo <owner/name>] [--user <name>]... [--group <group>]...`
 * (no principals clears that scope), `heel account sharing <alias>`.
 */
async function accountCommand(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({
      args,
      options: {
        ...JSON_OPTION,
        ...CONFIG_OPTION,
        user: { type: "string", multiple: true },
        group: { type: "string", multiple: true },
        repo: { type: "string" },
        "credential-host": { type: "string", multiple: true },
        "credential-auth": { type: "string" },
        "credential-delivery": { type: "string" },
        "credential-stdin": { type: "boolean" },
      },
      allowPositionals: true,
      strict: true,
    }),
  );
  const [subcommand, alias, ...extra] = positionals;
  if (extra.length > 0) throw new UsageError(`unexpected argument "${extra[0]}"`);
  const config = configFrom(io, values.config);
  const principals = [
    ...(values.user ?? []).map((name) => ({ kind: "user" as const, name })),
    ...(values.group ?? []).map((name) => ({ kind: "group" as const, name })),
  ];
  const print = (result: unknown) => io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  switch (subcommand) {
    case "list":
      if (alias !== undefined) throw new UsageError(`unexpected argument "${alias}"`);
      {
        const listed = await admin(config, { method: "account.list" });
        if (values.json) {
          print(listed);
          return EXIT.ok;
        }
        const rows = (listed as AccountRow[]).map((a) => [
          a.alias,
          a.provider,
          a.owner,
          a.status === "active" ? "ready" : a.status.replaceAll("_", " "),
          a.credentialDelivery ?? "",
        ]);
        io.stdout.write(
          formatTable(
            ["alias", "provider", "owner", "status", "credential"],
            rows,
            "No accounts yet. Connect one: heel connect <provider> --as <alias>",
          ),
        );
      }
      return EXIT.ok;
    case "set": {
      if (alias === undefined) throw new UsageError("missing account alias");
      const credentialHosts = values["credential-host"] ?? [];
      const delivery = deliveryFlag(values["credential-delivery"]);
      if (
        credentialHosts.length === 0 &&
        delivery === null &&
        values["credential-auth"] === undefined &&
        values["credential-stdin"]
      ) {
        // Only a new key or token: every setting stays as it is.
        const value = (await readAll(io.stdin)).replace(/\r?\n$/, "");
        if (value === "") throw new UsageError("--credential-stdin read nothing from stdin");
        print(
          await admin(config, {
            method: "account.credential",
            params: { alias, credential: { type: "static", value } },
          }),
        );
        io.stderr.write(
          `Stored the new credential for "${alias}". Revoke the old one with the provider.\n`,
        );
        return EXIT.ok;
      }
      if (credentialHosts.length === 0 && delivery !== "env") {
        throw new UsageError(
          "give --credential-stdin (a new key or token), at least one --credential-host <host>, or --credential-delivery env",
        );
      }
      let credential: { type: "static"; value: string } | undefined;
      if (values["credential-stdin"]) {
        const value = (await readAll(io.stdin)).replace(/\r?\n$/, "");
        if (value === "") throw new UsageError("--credential-stdin read nothing from stdin");
        credential = { type: "static", value };
      }
      const configured = ConfiguredAccountResult.parse(
        await admin(config, {
          method: "account.configure",
          params: {
            alias,
            credentialHosts,
            credentialAuth: values["credential-auth"] ?? null,
            ...(delivery === null ? {} : { credentialDelivery: delivery }),
            ...(credential === undefined ? {} : { credential }),
          },
        }),
      );
      print(configured);
      if (configured.rotate) {
        io.stderr.write(
          `Until now the program held this credential in its environment, where anything it ran could copy it. ` +
            `Rotate it with the provider, then give heel the new one: ` +
            `heel account set ${alias} --credential-host ... --credential-stdin\n`,
        );
      }
      if (configured.credentialDelivery === "env") {
        io.stderr.write(
          `The program now gets the credential itself, in its environment, where anything it runs can read it. ` +
            `heel warns about this account at every start.\n`,
        );
      }
      return EXIT.ok;
    }
    case "remove": {
      if (alias === undefined) throw new UsageError("missing account alias");
      const removed = await admin(config, { method: "account.remove", params: { alias } });
      print(removed);
      io.stderr.write(
        `Removed "${alias}" and its stored credential. Agents can no longer use it; ` +
          "revoke the credential with the provider too.\n",
      );
      return EXIT.ok;
    }
    case "share":
    case "unshare": {
      if (alias === undefined) throw new UsageError("missing account alias");
      const [principal, ...more] = principals;
      if (principal === undefined || more.length > 0) {
        throw new UsageError("give exactly one --user <name> or --group <group>");
      }
      print(
        await admin(config, {
          method: subcommand === "share" ? "account.share" : "account.unshare",
          params: { alias, ...principal },
        }),
      );
      return EXIT.ok;
    }
    case "approvers":
      if (alias === undefined) throw new UsageError("missing account alias");
      print(
        await admin(config, {
          method: "account.approvers",
          params: { alias, repo: values.repo ?? null, approvers: principals },
        }),
      );
      return EXIT.ok;
    case "sharing":
      if (alias === undefined) throw new UsageError("missing account alias");
      print(await admin(config, { method: "account.sharing", params: { alias } }));
      return EXIT.ok;
    default:
      throw new UsageError(
        subcommand === undefined
          ? "missing account subcommand"
          : `unknown account subcommand "${subcommand}"`,
      );
  }
}

/** `heel user email <user> <address>` or `heel user email <user> --clear`. */
async function userEmailCommand(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({
      args,
      options: { ...CONFIG_OPTION, clear: { type: "boolean" } },
      allowPositionals: true,
      strict: true,
    }),
  );
  const [, name, address, ...extra] = positionals;
  if (name === undefined) throw new UsageError("missing user name");
  if (extra.length > 0 || (address === undefined) === (values.clear !== true)) {
    throw new UsageError("give either an email address or --clear");
  }
  const config = configFrom(io, values.config);
  await admin(config, { method: "user.email", params: { name, email: address ?? null } });
  io.stdout.write(
    address === undefined
      ? `Cleared the email for "${name}".\n`
      : `Notifications for "${name}" go to ${address} (email and Slack, when configured).\n`,
  );
  return EXIT.ok;
}

async function userCommand(args: string[], io: CliIo): Promise<number> {
  // Each subcommand has its own options, so dispatch before parsing them.
  if (args.find((arg) => !arg.startsWith("-")) === "email") return userEmailCommand(args, io);
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({ args, options: CONFIG_OPTION, allowPositionals: true, strict: true }),
  );
  const [subcommand, ...rest] = positionals;
  if (subcommand !== "enroll") {
    throw new UsageError(
      subcommand === undefined
        ? "missing user subcommand"
        : `unknown user subcommand "${subcommand}"`,
    );
  }
  const name = onePositional(rest, "user name");
  const config = configFrom(io, values.config);
  const enrollment = EnrollmentResult.parse(
    await admin(config, { method: "user.enroll", params: { name } }),
  );
  if (enrollment.activeFrom) {
    io.stdout.write(
      `"${name}" already has a passkey, so this is a recovery link. It works from ${enrollment.activeFrom}\n` +
        `(a day from now), and the approval page shows it with a way to cancel it until then:\n` +
        `${enrollment.url}\n` +
        'To add a device right away instead, sign in with your passkey and use "Add another device" on the approval page.\n',
    );
    return EXIT.ok;
  }
  io.stdout.write(
    `Enrollment link for "${name}"${enrollment.subject === null ? "" : ` (signs in as ${enrollment.subject})`} (one use, valid until ${enrollment.expiresAt}):\n` +
      `${enrollment.url}\n` +
      "Open it on the device that will hold the passkey. A newer link replaces this one.\n",
  );
  return EXIT.ok;
}

/** Pure: the admin `pause` params for `heel pause`'s flags; exactly one scope must be named. */
export function pauseParams(values: {
  all?: boolean | undefined;
  agent?: string | undefined;
  account?: string | undefined;
  owner?: string | undefined;
}): Extract<AdminRequest, { method: "pause" }>["params"] {
  const named = [
    values.all === true ? ({ scope: "global" } as const) : null,
    values.agent === undefined ? null : ({ scope: "agent", name: values.agent } as const),
    values.account === undefined ? null : ({ scope: "account", name: values.account } as const),
    values.owner === undefined ? null : ({ scope: "owner", name: values.owner } as const),
  ].filter((scope) => scope !== null);
  const [only, ...extra] = named;
  if (only === undefined || extra.length > 0) {
    throw new UsageError("name exactly one of --all, --agent, --account or --owner");
  }
  return only;
}

/**
 * `heel pause`. One command, no passkey: pausing can only stop calls
 * (Q-N5). There is no `heel resume`; resuming needs a passkey on the page.
 */
async function pauseCommand(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({
      args,
      options: {
        ...JSON_OPTION,
        ...CONFIG_OPTION,
        all: { type: "boolean" },
        agent: { type: "string" },
        account: { type: "string" },
        owner: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    }),
  );
  const config = configFrom(io, values.config);
  if (positionals.length > 0) {
    if (onePositional(positionals, "pause subcommand") !== "list") {
      throw new UsageError(`unknown pause subcommand "${positionals[0]}"`);
    }
    const { all, agent, account, owner } = values;
    if (all !== undefined || [agent, account, owner].some((v) => v !== undefined)) {
      throw new UsageError("pause list takes no scope flags");
    }
    const listed = await admin(config, { method: "pause.list" });
    if (values.json) {
      io.stdout.write(`${JSON.stringify(listed, null, 2)}\n`);
      return EXIT.ok;
    }
    const rows = (listed as PauseRowView[]).map((p) => [
      p.scope === "global" ? "all" : p.scope,
      p.targetName,
      shortTime(p.pausedAt),
      p.pausedBy,
    ]);
    io.stdout.write(
      formatTable(["scope", "what", "since (UTC)", "by"], rows, "Nothing is paused."),
    );
    return EXIT.ok;
  }
  const params = pauseParams(values);
  const paused = PauseResult.parse(await admin(config, { method: "pause", params }));
  const what = params.scope === "global" ? "everything" : `${params.scope} "${params.name}"`;
  io.stdout.write(
    paused.created
      ? `Paused ${what}. Calls in scope return paused until someone resumes it with a passkey.\n`
      : `Already paused: ${what}.\n`,
  );
  return EXIT.ok;
}

async function approvalsCommand(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({
      args,
      options: { ...CONFIG_OPTION, ...JSON_OPTION },
      allowPositionals: true,
      strict: true,
    }),
  );
  const [subcommand, ...rest] = positionals;
  const config = configFrom(io, values.config);
  switch (subcommand) {
    case "list":
      if (rest.length > 0) throw new UsageError(`unexpected argument "${rest[0]}"`);
      {
        const listed = await admin(config, { method: "standing.list" });
        if (values.json) {
          io.stdout.write(`${JSON.stringify(listed, null, 2)}\n`);
          return EXIT.ok;
        }
        const rows = (listed as StandingRowView[]).map((a) => [
          a.id,
          a.agent,
          a.account ?? "",
          a.scope === "exact_call"
            ? "this exact call"
            : a.scope === "rule"
              ? "the rule"
              : "the run",
          a.revokedAt === null
            ? `until ${shortTime(a.expiresAt)}`
            : `revoked ${shortTime(a.revokedAt)}`,
        ]);
        io.stdout.write(
          formatTable(
            ["id", "agent", "account", "covers", "status (UTC)"],
            rows,
            "No standing approvals.",
          ),
        );
      }
      return EXIT.ok;
    case "revoke": {
      const id = onePositional(rest, "standing approval id");
      await admin(config, { method: "standing.revoke", params: { id } });
      io.stdout.write(`Revoked standing approval ${id}. It stops matching on the next call.\n`);
      return EXIT.ok;
    }
    default:
      throw new UsageError(
        subcommand === undefined
          ? "missing approvals subcommand"
          : `unknown approvals subcommand "${subcommand}"`,
      );
  }
}

/**
 * `heel audit export`. Pages through one pinned snapshot of the log and
 * streams each page to stdout, so memory stays bounded on a large log.
 */
async function auditCommand(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({
      args,
      options: {
        ...CONFIG_OPTION,
        since: { type: "string" },
        until: { type: "string" },
        format: { type: "string", default: "jsonl" },
      },
      allowPositionals: true,
      strict: true,
    }),
  );
  if (onePositional(positionals, "audit subcommand") !== "export") {
    throw new UsageError(`unknown audit subcommand "${positionals[0]}"`);
  }
  if (values.format !== "jsonl") throw new UsageError(`unsupported --format "${values.format}"`);
  const now = new Date();
  const window: { since?: string; until?: string } = {};
  for (const flag of ["since", "until"] as const) {
    const text = values[flag];
    if (text === undefined) continue;
    const instant = parseExportTime(text, now);
    if (instant === null) throw new UsageError(`--${flag}: cannot read "${text}" as a time`);
    window[flag] = instant;
  }
  const config = configFrom(io, values.config);
  let afterId = 0;
  let throughId: number | undefined;
  for (;;) {
    const page = AuditExportPageResult.parse(
      await admin(config, {
        method: "audit.export",
        params: {
          ...window,
          afterId,
          limit: AUDIT_EXPORT_MAX_PAGE,
          ...(throughId === undefined ? {} : { throughId }),
        },
      }),
    );
    if (page.lines.length > 0) io.stdout.write(page.lines.join(""));
    if (page.done) return EXIT.ok;
    afterId = page.nextAfterId;
    throughId = page.throughId;
  }
}

/**
 * Pure: the usage lines for one command (`heel agent ...`, `heel run ...`),
 * or null when USAGE has none. Each entry starts at a `  heel <command>`
 * line and runs through its indented description.
 */
export function usageFor(command: string): string | null {
  const blocks: string[][] = [];
  for (const line of USAGE.split("\n")) {
    if (line.startsWith("  heel ")) blocks.push([line]);
    else if (line.startsWith("   ") && blocks.length > 0) blocks.at(-1)?.push(line);
  }
  const mine = blocks.filter(([first]) => {
    const name = first?.slice("  heel ".length).split(/[\s|]/)[0];
    return name === command;
  });
  if (mine.length === 0) return null;
  return `usage:\n${mine.map((block) => block.join("\n")).join("\n")}\n\nRun \`heel help\` for every command. Every command takes --config <file>.\n`;
}

/** `--help` or `-h` among a command's own arguments; for `heel run`, only before `--`. */
function asksForHelp(rest: readonly string[]): boolean {
  const own = rest.includes("--") ? rest.slice(0, rest.indexOf("--")) : rest;
  return own.includes("--help") || own.includes("-h");
}

/** `heel init`: a home, a master key, a small heel.yaml and starter rules (src/cli/init.ts). */
async function initCommand(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({
      args,
      options: { home: { type: "string" }, yes: { type: "boolean", short: "y" } },
      allowPositionals: true,
      strict: true,
    }),
  );
  if (positionals.length > 0) throw new UsageError(`unexpected argument "${positionals[0]}"`);
  const { chooseHome, confirm, initHome, initSummary } = await import("./init.ts");
  const home = chooseHome(values.home, io.env);
  const fromEnv = values.home === undefined && io.env["HEEL_HOME"] !== undefined;
  if (values.yes !== true) {
    if (!process.stdin.isTTY) {
      throw new UsageError(
        "heel init asks before writing; pass --yes to run it without a terminal",
      );
    }
    io.stderr.write(
      `heel will set itself up in ${home}: a master key, heel.yaml and starter rules. Nothing that's already there is changed.\n`,
    );
    if (!(await confirm("Go ahead?"))) {
      io.stderr.write("Nothing was written.\n");
      return EXIT.ok;
    }
  }
  const steps = initHome(home);
  // Every command finds the default home on its own; only another folder needs HEEL_HOME.
  const found = fromEnv || home === io.env["HEEL_HOME"] || home === defaultHeelHome();
  io.stdout.write(initSummary(home, steps, found));
  return EXIT.ok;
}

/** `heel update`: the newest heel from npm, installed the way this one was (src/cli/update.ts). */
async function updateCommand(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({
      args,
      options: { ...CONFIG_OPTION, check: { type: "boolean" } },
      allowPositionals: true,
      strict: true,
    }),
  );
  if (positionals.length > 0) throw new UsageError(`unexpected argument "${positionals[0]}"`);
  const { checkMessage, latestVersion, runCommand, thisInstall, updatePlan } = await import(
    "./update.ts"
  );
  let latest: string;
  try {
    latest = await latestVersion();
  } catch (error) {
    io.stderr.write(
      `heel: couldn't ask npm for the newest version: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return EXIT.unavailable;
  }
  if (values.check === true) {
    io.stdout.write(checkMessage(HEEL_VERSION, latest));
    return EXIT.ok;
  }
  const plan = updatePlan(thisInstall(), HEEL_VERSION, latest);
  if (plan.kind !== "run") {
    io.stdout.write(plan.message);
    return EXIT.ok;
  }
  io.stdout.write(plan.before);
  const code = await runCommand(plan.command, plan.args);
  if (code !== 0) {
    io.stderr.write(
      `heel: the update didn't finish (${plan.command} ${plan.args.join(" ")} exited ${code}). heel ${HEEL_VERSION} is unchanged.\n`,
    );
    return EXIT.failed;
  }
  io.stdout.write(plan.after);
  // A heel that's running still runs the old code. One `heel start` put in
  // the background is restarted here, on the new version; one in a terminal
  // is the person's to restart.
  const config = configFrom(io, values.config);
  const { pingHeel } = await import("./background.ts");
  const running = await pingHeel(config);
  if (running === null) return EXIT.ok;
  if (running.background !== true) {
    io.stdout.write(
      "heel serve is still running the old version: stop it (Ctrl-C) and start it again.\n",
    );
    return EXIT.ok;
  }
  io.stdout.write("Restarting heel in the background on the new version…\n");
  return restartCommand(values.config === undefined ? [] : ["--config", values.config], io);
}

/** `heel tui`: the full-screen view (src/cli/tui.ts). Needs a terminal. */
async function tuiCommand(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({ args, options: CONFIG_OPTION, allowPositionals: true, strict: true }),
  );
  if (positionals.length > 0) throw new UsageError(`unexpected argument "${positionals[0]}"`);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    io.stderr.write("heel: heel tui needs a terminal. For plain text, run: heel status\n");
    return EXIT.usage;
  }
  const { runTui } = await import("./tui.ts");
  return runTui(configFrom(io, values.config));
}

/** `heel status`: the same picture as the TUI's header, as plain lines. */
async function statusCommand(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({ args, options: CONFIG_OPTION, allowPositionals: true, strict: true }),
  );
  if (positionals.length > 0) throw new UsageError(`unexpected argument "${positionals[0]}"`);
  const config = configFrom(io, values.config);
  const ping = (await admin(config, { method: "ping" })) as { version?: string; vault?: string };
  const approvals = (await admin(config, { method: "approvals.list" })) as {
    status: string;
    summary: string;
    url: string;
  }[];
  const agents = (await admin(config, { method: "agent.list" })) as { revokedAt: string | null }[];
  const accounts = (await admin(config, { method: "account.list" })) as { status: string }[];
  const pauses = (await admin(config, { method: "pause.list" })) as {
    scope: string;
    targetName: string;
  }[];
  const proposals = (await admin(config, { method: "proposals.list" })) as {
    summary: string;
    url: string;
  }[];
  const waiting = approvals.filter((a) => a.status === "pending");
  const lines = [
    `heel ${ping.version ?? ""} is running${ping.vault === "unavailable" ? ", but the vault is closed (no master key)" : ""}.`,
    `  Agents:    ${agents.filter((a) => a.revokedAt === null).length}`,
    `  Accounts:  ${accounts.length}${
      accounts.some((a) => a.status !== "active")
        ? ` (${accounts.filter((a) => a.status !== "active").length} need sign-in)`
        : ""
    }`,
    `  Paused:    ${pauses.length === 0 ? "nothing" : pauses.map((p) => (p.scope === "global" ? "everything" : `${p.scope} ${p.targetName}`)).join(", ")}`,
    `  Waiting:   ${waiting.length === 0 ? "nothing" : `${waiting.length} request${waiting.length === 1 ? "" : "s"}`}`,
    ...waiting.slice(0, 5).map((a) => `    ${a.summary}\n      ${a.url}`),
    ...(waiting.length > 5 ? [`    and ${waiting.length - 5} more: heel tui`] : []),
    `  Proposals: ${proposals.length === 0 ? "nothing" : `${proposals.length} waiting for you to add or reject`}`,
    ...proposals.slice(0, 5).map((p) => `    ${p.summary}\n      ${p.url}`),
    ...(proposals.length > 5 ? [`    and ${proposals.length - 5} more: heel tui`] : []),
  ];
  io.stdout.write(`${lines.join("\n")}\n`);
  return EXIT.ok;
}

async function dispatch(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== undefined && command !== "help" && asksForHelp(rest)) {
    const usage = usageFor(command);
    if (usage !== null) {
      io.stdout.write(usage);
      return EXIT.ok;
    }
  }
  switch (command) {
    case "serve":
      return serveCommand(rest, io);
    case "vault":
      return vaultCommand(rest, io);
    case "agent":
      return agentCommand(rest, io);
    case "connect":
      return connectCommand(rest, io);
    case "account":
      return accountCommand(rest, io);
    case "user":
      return userCommand(rest, io);
    case "pause":
      return pauseCommand(rest, io);
    case "approvals":
      return approvalsCommand(rest, io);
    case "resume":
    case "unpause":
      return resumeHint(io);
    case "rules":
      return rulesCommand(rest, io);
    case "audit":
      return auditCommand(rest, io);
    case "codemode-worker": {
      // Internal: heel starts this itself, under bubblewrap, for one script
      // (D6b). It never returns; it exits when the script ends.
      const { codemodeWorkerMain } = await import("../codemode/worker-main.ts");
      await codemodeWorkerMain();
      return new Promise<number>(() => {});
    }
    case "run":
      return runCommand(rest, io, { fetch, cwd: () => io.cwd?.() ?? process.cwd() });
    case "init":
      return initCommand(rest, io);
    case "tui":
      return tuiCommand(rest, io);
    case "start":
      return startCommand(rest, io);
    case "stop":
      return stopCommand(rest, io);
    case "restart":
      return restartCommand(rest, io);
    case "logs":
      return logsCommand(rest, io);
    case "update":
      return updateCommand(rest, io);
    case "status":
      return statusCommand(rest, io);
    case "help": {
      const usage = rest[0] === undefined ? null : usageFor(rest[0]);
      io.stdout.write(usage ?? USAGE);
      return EXIT.ok;
    }
    case "--help":
    case "-h":
      io.stdout.write(USAGE);
      return EXIT.ok;
    case "--version":
      io.stdout.write(`${HEEL_VERSION}\n`);
      return EXIT.ok;
    default:
      throw new UsageError(
        command === undefined ? "missing command" : `unknown command "${command}"`,
      );
  }
}

/**
 * Resuming needs a passkey, so the CLI can't do it: an agent that can run
 * `heel` on the host could otherwise lift a pause meant to stop it. Say where
 * to go instead of "unknown command".
 */
function resumeHint(io: CliIo): number {
  let where = "the Pause page";
  try {
    where = new URL("pause", configFrom(io, undefined).publicUrl.href.replace(/\/?$/, "/")).href;
  } catch {
    // No readable heel.yaml here: name the page without its address.
  }
  io.stderr.write(
    `heel: resuming needs your passkey, so it happens on the approval page: ${where}\n` +
      "List what is paused with: heel pause list\n",
  );
  return EXIT.usage;
}

/** The `heel` command. Returns the process exit code. */
export async function main(argv: string[], io: CliIo): Promise<number> {
  try {
    return await dispatch(argv, io);
  } catch (error) {
    if (error instanceof UsageError) {
      // Only the command's own usage; the whole list buries the one line that matters.
      const usage = argv[0] === undefined ? null : usageFor(argv[0]);
      io.stderr.write(`heel: ${error.message}\n\n${usage ?? USAGE}`);
      return EXIT.usage;
    }
    if (error instanceof AdminClientError || error instanceof AdminSocketError) {
      io.stderr.write(`heel: ${error.message}\n`);
      return EXIT.unavailable;
    }
    // A configured secret (an OAuth client's, say) that's missing or unsafe: the fix is the file.
    if (error instanceof ConfigError || error instanceof SecretFileError) {
      io.stderr.write(`heel: ${error.message}\n`);
      return EXIT.config;
    }
    if (error instanceof RefusedError) {
      io.stderr.write(`heel: ${error.message}\n`);
      return EXIT.failed;
    }
    // A file heel can't create or open: the fix is a path, not a bug report.
    if (
      ["EACCES", "EPERM", "ENOENT", "EROFS"].some((code) => hasErrnoCode(error, code)) &&
      error instanceof Error &&
      "path" in error
    ) {
      io.stderr.write(
        `heel: ${error.message}\nSet HEEL_HOME to a directory you own (for example ~/.heel), or point heel.yaml at one.\n`,
      );
      return EXIT.failed;
    }
    // Unexpected: show the stack so the fault can be found.
    io.stderr.write(
      `heel: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    return EXIT.failed;
  }
}
