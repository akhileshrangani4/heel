import { mkdirSync, readFileSync } from "node:fs";
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

import { runCommand } from "./run.ts";

export const USAGE = `usage:
  heel serve [--watch]                    start the agent, human and admin planes
  heel vault init                         create the master key file
  heel agent add <name> [--owner <user>]  add an agent; prints its token once
  heel agent workdir <name> [<dir>...]    the directories heel run may work in
  heel agent rotate <name>                replace an agent's token
  heel agent revoke <name>                revoke an agent's token
  heel agent list
  heel connect <provider> --as <alias> [--owner <user>] [--credential-stdin]
  heel connect gmail|google-calendar|outlook --as <alias> [--owner <user>]
                                          add a Gmail, Google Calendar or Outlook
                                          account; its owner signs in with Google or
                                          Microsoft from the Connections page
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
                   --credential-host <host>... [--credential-auth bearer|basic|header:<name>]]
                                          run a local MCP server in heel's sandbox;
                                          it gets a placeholder in <NAME>, and heel
                                          adds the credential to its requests to
                                          each --credential-host
  heel run [--account <alias>] [--json] -- <cmd> [args...]
                                          (agent side) ask heel to run a command;
                                          reads HEEL_TOKEN, HEEL_URL, HEEL_RUN_ID
  heel connect cli <command> --as <alias> --bin <path> [--egress <host>]...
                   [--credential-env <NAME>] --credential-stdin
                                          let agents run a CLI (gh, kubectl, ...)
                                          through heel with \`heel run\`; the
                                          credential stays with heel
  heel account list
  heel account set <alias> --credential-host <host>... [--credential-auth bearer|basic|header:<name>]
                   [--credential-stdin]
                                          move a local MCP server's credential out of
                                          its sandbox, to heel's egress proxy
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

const IssuedAgentResult = z.object({ name: z.string(), token: z.string() });
const ConnectedAccountResult = z.object({
  alias: z.string(),
  provider: z.string(),
  status: z.string(),
});
const EnrollmentResult = z.object({
  url: z.string(),
  expiresAt: z.string(),
  /** The IdP identity the user signs in as, on a team install. */
  subject: z.string().nullable().default(null),
  activeFrom: z.string().nullable().optional(),
});
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
          `MCP URL: ${agentMcpUrl(config.listen.agent, config.agentPublicUrl)}\n`,
      );
      return EXIT.ok;
    }
    case "workdir": {
      const [name, ...roots] = rest;
      if (name === undefined) throw new UsageError("missing agent name");
      await admin(config, { method: "agent.workdirs", params: { name, workRoots: roots } });
      io.stdout.write(
        roots.length === 0
          ? `"${name}" can no longer run commands.\n`
          : `"${name}" may run commands in: ${roots.join(", ")}\n`,
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
        url: { type: "string" },
        oauth: { type: "boolean" },
        command: { type: "string" },
        arg: { type: "string", multiple: true },
        egress: { type: "string", multiple: true },
        mount: { type: "string", multiple: true },
        "credential-env": { type: "string" },
        "credential-host": { type: "string", multiple: true },
        "credential-auth": { type: "string" },
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
            credentialHosts: values["credential-host"] ?? [],
            credentialAuth: values["credential-auth"] ?? null,
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
  return EXIT.ok;
}

/**
 * `heel account list`, `heel account set <alias> --credential-host <host>...
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
        ...CONFIG_OPTION,
        user: { type: "string", multiple: true },
        group: { type: "string", multiple: true },
        repo: { type: "string" },
        "credential-host": { type: "string", multiple: true },
        "credential-auth": { type: "string" },
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
      print(await admin(config, { method: "account.list" }));
      return EXIT.ok;
    case "set": {
      if (alias === undefined) throw new UsageError("missing account alias");
      const credentialHosts = values["credential-host"] ?? [];
      if (credentialHosts.length === 0)
        throw new UsageError("give at least one --credential-host <host>");
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
            ...(credential === undefined ? {} : { credential }),
          },
        }),
      );
      print(configured);
      if (configured.rotate) {
        io.stderr.write(
          `Until now the server held this credential in its environment, where anything it ran could copy it. ` +
            `Rotate it with the provider, then give heel the new one: ` +
            `heel account set ${alias} --credential-host ... --credential-stdin\n`,
        );
      }
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
    case "codemode-worker": {
      // Internal: heel starts this itself, under bubblewrap, for one script
      // (D6b). It never returns; it exits when the script ends.
      const { codemodeWorkerMain } = await import("../codemode/worker-main.ts");
      await codemodeWorkerMain();
      return new Promise<number>(() => {});
    }
    case "run":
      return runCommand(rest, io, { fetch, cwd: () => io.cwd?.() ?? process.cwd() });
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
