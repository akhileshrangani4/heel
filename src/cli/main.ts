import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { AdminClientError, adminCall } from "../admin/client.ts";
import type { AdminRequest } from "../admin/protocol.ts";
import { AdminSocketError } from "../admin/server.ts";
import { loadConfig, resolveConfigSource } from "../config/load.ts";
import type { HeelConfig, ListenAddress } from "../config/schema.ts";
import { YamlValidationError } from "../config/yaml.ts";
import { createLogger } from "../log.ts";
import { startHeel } from "../serve.ts";
import { hasErrnoCode } from "../util/errno.ts";
import { createMasterKeyFile } from "../vault/key.ts";
import { HEEL_VERSION } from "../version.ts";

/** Exit codes, from sysexits(3) as the spec uses for `heel run`. */
export const EXIT = {
  ok: 0,
  /** heel answered and refused the request. */
  failed: 1,
  usage: 64,
  /** heel isn't running, or (for `serve`) another heel already owns the admin socket. */
  unavailable: 69,
  /** heel.yaml is missing or invalid. */
  config: 78,
} as const;

export interface CliIo {
  env: Readonly<Record<string, string | undefined>>;
  stdin: AsyncIterable<string | Buffer>;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
}

export const USAGE = `usage:
  heel serve                              start the agent, human and admin planes
  heel vault init                         create the master key file
  heel agent add <name> [--owner <user>]  add an agent; prints its token once
  heel agent rotate <name>                replace an agent's token
  heel agent revoke <name>                revoke an agent's token
  heel agent list
  heel connect <provider> --as <alias> [--owner <user>] [--credential-stdin]
  heel account list

Every command takes --config <file>; the default is $HEEL_HOME/heel.yaml.
`;

class UsageError extends Error {
  override readonly name = "UsageError";
}

class RefusedError extends Error {
  override readonly name = "RefusedError";
}

const IssuedAgentResult = z.object({ name: z.string(), token: z.string() });
const ConnectedAccountResult = z.object({
  alias: z.string(),
  provider: z.string(),
  status: z.string(),
});

/** Pure: the MCP URL an agent should be given, from the agent plane's listen address. */
export function agentMcpUrl(listen: ListenAddress): string {
  const host = listen.host.includes(":") ? `[${listen.host}]` : listen.host;
  return `http://${host}:${listen.port}/mcp`;
}

/** The `--config <file>` flag every command accepts. */
const CONFIG_OPTION = { config: { type: "string" } } as const;

/** Runs a parseArgs call, turning node:util's ERR_PARSE_ARGS_* errors into usage errors. */
function parseOrUsage<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof TypeError && /^ERR_PARSE_ARGS/.test(String(Reflect.get(error, "code")))) {
      throw new UsageError(error.message);
    }
    throw error;
  }
}

class ConfigError extends Error {
  override readonly name = "ConfigError";
}

function configFrom(io: CliIo, configFlag: string | undefined): HeelConfig {
  const source = resolveConfigSource(io.env, configFlag);
  try {
    return loadConfig(source);
  } catch (error) {
    if (error instanceof YamlValidationError) {
      throw new ConfigError(`invalid config:\n${error.message}`, { cause: error });
    }
    if (hasErrnoCode(error, "ENOENT")) {
      throw new ConfigError(`config file not found: ${source.file}`, { cause: error });
    }
    throw error;
  }
}

function onePositional(positionals: string[], what: string): string {
  const [value, ...extra] = positionals;
  if (value === undefined) throw new UsageError(`missing ${what}`);
  if (extra.length > 0) throw new UsageError(`unexpected argument "${extra[0]}"`);
  return value;
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
    parseArgs({ args, options: CONFIG_OPTION, allowPositionals: true, strict: true }),
  );
  if (positionals.length > 0) throw new UsageError(`unexpected argument "${positionals[0]}"`);
  const config = configFrom(io, values.config);
  const log = createLogger(config.log.level);
  const heel = await startHeel({ config, env: io.env, log, version: HEEL_VERSION });
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
