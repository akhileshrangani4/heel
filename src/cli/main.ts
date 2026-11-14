import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { AdminClientError, adminCall } from "../admin/client.ts";
import { type AdminRequest, AUDIT_EXPORT_MAX_PAGE } from "../admin/protocol.ts";
import { AdminSocketError } from "../admin/server.ts";
import type { HeelConfig, ListenAddress } from "../config/schema.ts";
import { createLogger } from "../log.ts";
import { startHeel } from "../serve.ts";
import { hasErrnoCode } from "../util/errno.ts";
import { createMasterKeyFile } from "../vault/key.ts";
import { HEEL_VERSION } from "../version.ts";
import {
  type CliIo,
  CONFIG_OPTION,
  ConfigError,
  configFrom,
  EXIT,
  onePositional,
  parseOrUsage,
  RefusedError,
  UsageError,
} from "./common.ts";
import { RULES_USAGE, rulesCommand } from "./rules.ts";

export { type CliIo, EXIT } from "./common.ts";

export const USAGE = `usage:
  heel serve [--watch]                    start the agent, human and admin planes
  heel vault init                         create the master key file
  heel agent add <name> [--owner <user>]  add an agent; prints its token once
  heel agent rotate <name>                replace an agent's token
  heel agent revoke <name>                revoke an agent's token
  heel agent list
  heel connect <provider> --as <alias> [--owner <user>] [--credential-stdin]
  heel account list
  heel user enroll <user>                 print a one-time passkey enrollment link
                                          (valid 15 minutes; also adds a device or
                                          recovers a lost passkey)
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

const IssuedAgentResult = z.object({ name: z.string(), token: z.string() });
const ConnectedAccountResult = z.object({
  alias: z.string(),
  provider: z.string(),
  status: z.string(),
});
const EnrollmentResult = z.object({ url: z.string(), expiresAt: z.string() });
const PauseResult = z.object({ scope: z.string(), created: z.boolean() });

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
export function agentMcpUrl(listen: ListenAddress): string {
  const host = listen.host.includes(":") ? `[${listen.host}]` : listen.host;
  return `http://${host}:${listen.port}/mcp`;
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
  const signal = await waitForShutdownSignal();
  log.info({ signal }, "shutting down");
  await heel.close();
  return EXIT.ok;
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

async function agentCommand(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({
      args,
      options: { ...CONFIG_OPTION, owner: { type: "string" } },
      allowPositionals: true,
      strict: true,
    }),
  );
  const [subcommand, ...rest] = positionals;
  const config = configFrom(io, values.config);
  switch (subcommand) {
    case "add": {
      const name = onePositional(rest, "agent name");
      const params = { name, ...(values.owner === undefined ? {} : { owner: values.owner }) };
      const issued = IssuedAgentResult.parse(await admin(config, { method: "agent.add", params }));
      io.stdout.write(
        `Added agent "${issued.name}".\n` +
          `Token (shown once; heel keeps only its hash): ${issued.token}\n` +
          `MCP URL: ${agentMcpUrl(config.listen.agent)}\n`,
      );
      return EXIT.ok;
    }
    case "rotate": {
      const name = onePositional(rest, "agent name");
      const issued = IssuedAgentResult.parse(
        await admin(config, { method: "agent.rotate", params: { name } }),
      );
      io.stdout.write(
        `Rotated the token for "${issued.name}". The old token no longer works.\n` +
          `Token (shown once): ${issued.token}\n`,
      );
      return EXIT.ok;
    }
    case "revoke": {
      const name = onePositional(rest, "agent name");
      await admin(config, { method: "agent.revoke", params: { name } });
      io.stdout.write(`Revoked agent "${name}". Its next call is rejected.\n`);
      return EXIT.ok;
    }
    case "list":
      if (rest.length > 0) throw new UsageError(`unexpected argument "${rest[0]}"`);
      io.stdout.write(
        `${JSON.stringify(await admin(config, { method: "agent.list" }), null, 2)}\n`,
      );
      return EXIT.ok;
    default:
      throw new UsageError(
        subcommand === undefined
          ? "missing agent subcommand"
          : `unknown agent subcommand "${subcommand}"`,
      );
  }
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
        "credential-stdin": { type: "boolean" },
      },
      allowPositionals: true,
      strict: true,
    }),
  );
  const provider = onePositional(positionals, "provider");
  if (values.as === undefined) throw new UsageError("missing --as <alias>");
  const config = configFrom(io, values.config);
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
    ...(credential ? { credential } : {}),
  };
  const account = ConnectedAccountResult.parse(
    await admin(config, { method: "account.connect", params }),
  );
  io.stdout.write(`Connected ${account.provider} as "${account.alias}" (${account.status}).\n`);
  return EXIT.ok;
}

async function accountCommand(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({ args, options: CONFIG_OPTION, allowPositionals: true, strict: true }),
  );
  if (onePositional(positionals, "account subcommand") !== "list") {
    throw new UsageError(`unknown account subcommand "${positionals[0]}"`);
  }
  const config = configFrom(io, values.config);
  io.stdout.write(`${JSON.stringify(await admin(config, { method: "account.list" }), null, 2)}\n`);
  return EXIT.ok;
}

async function userCommand(args: string[], io: CliIo): Promise<number> {
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
  io.stdout.write(
    `Enrollment link for "${name}" (one use, valid until ${enrollment.expiresAt}):\n` +
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
    io.stdout.write(`${JSON.stringify(await admin(config, { method: "pause.list" }), null, 2)}\n`);
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
    parseArgs({ args, options: CONFIG_OPTION, allowPositionals: true, strict: true }),
  );
  const [subcommand, ...rest] = positionals;
  const config = configFrom(io, values.config);
  switch (subcommand) {
    case "list":
      if (rest.length > 0) throw new UsageError(`unexpected argument "${rest[0]}"`);
      io.stdout.write(
        `${JSON.stringify(await admin(config, { method: "standing.list" }), null, 2)}\n`,
      );
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

async function dispatch(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
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
    case "rules":
      return rulesCommand(rest, io);
    case "audit":
      return auditCommand(rest, io);
    case "help":
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

/** The `heel` command. Returns the process exit code. */
export async function main(argv: string[], io: CliIo): Promise<number> {
  try {
    return await dispatch(argv, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`heel: ${error.message}\n\n${USAGE}`);
      return EXIT.usage;
    }
    if (error instanceof AdminClientError || error instanceof AdminSocketError) {
      io.stderr.write(`heel: ${error.message}\n`);
      return EXIT.unavailable;
    }
    if (error instanceof ConfigError) {
      io.stderr.write(`heel: ${error.message}\n`);
      return EXIT.config;
    }
    if (error instanceof RefusedError) {
      io.stderr.write(`heel: ${error.message}\n`);
      return EXIT.failed;
    }
    // Unexpected: show the stack so the fault can be found.
    io.stderr.write(
      `heel: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    return EXIT.failed;
  }
}
