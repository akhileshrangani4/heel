import { realpathSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { isLoopbackUrl } from "../config/schema.ts";
import { isNpmConfigEnv } from "../definitions/cli/npm.ts";
import { cliCredentialDelivery, cliSettings, GH_EGRESS } from "../definitions/cli/settings.ts";
import type {
  CredentialDeliveryChoice,
  SandboxCredentialDelivery,
} from "../definitions/credential-delivery.ts";
import { OpenApiError, type Operation, parseOpenApi } from "../definitions/http/openapi.ts";
import { credentialDelivery, isEnvName, upstreamSettings } from "../definitions/mcp/settings.ts";
import { EgressConfigError, isAllowlisted, parseEgressAllow } from "../runner/egress.ts";
import { parseCredentialAuth } from "../runner/intercept.ts";
import { isReservedEnv } from "../runner/plan.ts";
import type { HeelDb } from "../store/db.ts";
import { newId } from "../store/ids.ts";
import { type AccountStatus, accounts, users } from "../store/schema.ts";
import type { CredentialPayload, Vault } from "./vault.ts";

/**
 * The skeleton behind `heel connect`: it registers an account alias and,
 * when given one, stores a static credential in the vault. OAuth consent
 * flows and the HTTP and CLI passthroughs arrive with the deliverables that
 * define those providers.
 *
 * An MCP passthrough account (`heel connect mcp --as notes --url …`) points
 * at someone else's MCP server. Its provider is `mcp:<alias>` (spec: Call
 * model), its URL lives in `settings`, and its credential is optional: an
 * upstream that needs no token is usable as soon as it's connected.
 */

/**
 * The eight built-in providers (spec: Built-in providers). Outlook covers
 * both mail and calendar.
 */
export const BUILT_IN_PROVIDERS = [
  "gmail",
  "outlook",
  "google-calendar",
  "github",
  "slack",
  "linear",
  "notion",
  "stripe",
] as const;
export type BuiltInProvider = (typeof BUILT_IN_PROVIDERS)[number];

/** Built-in providers whose accounts sign in through heel's OAuth client, never with a pasted token. */
const SIGNS_IN: ReadonlySet<string> = new Set(["gmail", "google-calendar", "outlook"]);

export function isBuiltInProvider(name: string): name is BuiltInProvider {
  return (BUILT_IN_PROVIDERS as readonly string[]).includes(name);
}

/**
 * Aliases name the account in rules and become a Python module in code mode
 * (`gmail-work` → `gmail_work`), so they start with a letter and use only
 * lower-case letters, digits and hyphens; that also keeps the `-`→`_`
 * mapping one-to-one.
 */
const ALIAS = /^[a-z][a-z0-9-]{0,63}$/;

export function isValidAlias(alias: string): boolean {
  return ALIAS.test(alias);
}

/** What `heel connect` calls an HTTP account (D7a). */
export const HTTP_PASSTHROUGH = "http";

/** The provider an HTTP account is stored under (spec: Call model). */
export function httpProvider(alias: string): string {
  return `${HTTP_PASSTHROUGH}:${alias}`;
}

export function isHttpProvider(provider: string): boolean {
  return provider.startsWith(`${HTTP_PASSTHROUGH}:`);
}

/** Pure: `bearer`, `basic`, `header:<name>` or `query:<name>`, as settings store it. */
export function parseHttpAuth(text: string) {
  if (text === "bearer" || text === "basic") return { type: text } as const;
  const match = /^(header|query):([A-Za-z0-9_.-]{1,64})$/.exec(text);
  if (match === null) return null;
  const name = match[2] as string;
  // Headers that frame the request itself can't carry a credential.
  if (match[1] === "header" && RESERVED_AUTH_HEADERS.has(name.toLowerCase())) return null;
  return { type: match[1] as "header" | "query", name } as const;
}

const RESERVED_AUTH_HEADERS = new Set([
  "host",
  "content-type",
  "content-length",
  "transfer-encoding",
  "connection",
  "accept",
  "te",
  "upgrade",
  "trailer",
]);

/** The settings an HTTP account stores: its base URL, how it authenticates, and its operations. */
function httpAccountSettings(input: ConnectInput): Record<string, unknown> {
  const http = input.http;
  if (http === undefined) {
    throw new ConnectError("invalid_settings", "http needs --base-url, --auth and --openapi");
  }
  const problem = upstreamUrlProblem(http.baseUrl);
  if (problem !== null)
    throw new ConnectError("invalid_settings", problem.replace("upstream", "base"));
  const auth = parseHttpAuth(http.auth);
  if (auth === null) {
    throw new ConnectError(
      "invalid_settings",
      "--auth is bearer, basic, header:<name> or query:<name>",
    );
  }
  let operations: Operation[];
  try {
    operations = parseOpenApi(http.openapi);
  } catch (error) {
    if (error instanceof OpenApiError) throw new ConnectError("invalid_settings", error.message);
    throw error;
  }
  if (input.credential === undefined) {
    throw new ConnectError(
      "invalid_settings",
      "an http account needs its credential (--credential-stdin)",
    );
  }
  return { transport: "http", baseUrl: http.baseUrl, auth, operations };
}

/** What `heel connect` calls a CLI account (D8b). */
export const CLI_PASSTHROUGH = "cli";

/** The provider a CLI account is stored under (spec: Call model, `cli:<name>`). */
export function cliProvider(command: string): string {
  return `${CLI_PASSTHROUGH}:${command}`;
}

export function isCliProvider(provider: string): boolean {
  return provider.startsWith(`${CLI_PASSTHROUGH}:`);
}

/** The settings a CLI account stores; see `definitions/cli/settings.ts`. */
function cliAccountSettings(input: ConnectInput): Record<string, unknown> {
  const cli = input.cli;
  if (cli === undefined)
    throw new ConnectError("invalid_settings", "cli needs <command> and --bin <path>");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(cli.command)) {
    throw new ConnectError(
      "invalid_settings",
      "the command name is letters, digits, '.', '_' or '-'",
    );
  }
  if (!cli.bin.startsWith("/")) {
    throw new ConnectError(
      "invalid_settings",
      "--bin must be an absolute path; heel never looks it up on PATH",
    );
  }
  // The path stored is the binary itself, not a link someone could repoint later (I-34).
  let real: string | null = null;
  try {
    real = realpathSync(cli.bin);
  } catch {
    real = null;
  }
  if (real !== cli.bin) {
    throw new ConnectError(
      "invalid_settings",
      real === null
        ? `--bin ${cli.bin} doesn't exist on this host`
        : `--bin must be the binary itself, not a link: use ${real}`,
    );
  }
  if (cli.command === "kubectl") {
    // kubectl reads its credential from a kubeconfig file in the sandbox, and a
    // command can be pointed at that file (a symlink the agent leaves in its
    // work root, read with --from-file) and print or upload it. Until heel can
    // hand kubectl its credential without a readable file, it isn't offered.
    throw new ConnectError(
      "invalid_settings",
      "kubectl isn't supported by heel run yet: its credential would be readable by the command",
    );
  }
  if (input.credential?.type !== "static") {
    throw new ConnectError(
      "invalid_settings",
      "a cli account needs its credential (--credential-stdin)",
    );
  }
  if (cli.command === "gh") {
    if (
      (cli.credentialHosts ?? []).length > 0 ||
      (cli.credentialAuth ?? null) !== null ||
      (cli.credentialDelivery ?? null) !== null
    ) {
      throw new ConnectError(
        "invalid_settings",
        "gh's token always goes through heel's egress proxy; leave out --credential-host, --credential-auth and --credential-delivery",
      );
    }
    const egress = [...GH_EGRESS, ...cli.egress];
    checkEgress(egress);
    return { transport: "cli", command: "gh", bin: cli.bin, egress, credentialEnv: null };
  }
  const npm = cli.command === "npm";
  if (cli.credentialEnv === null && !(npm && (cli.credentialHosts ?? []).length > 0)) {
    throw new ConnectError(
      "invalid_settings",
      npm
        ? "npm needs --credential-host <registry host>: heel writes npm's token for it as a placeholder"
        : "a CLI heel doesn't know needs --credential-env <NAME>",
    );
  }
  if (cli.credentialEnv !== null) checkCredentialEnv(cli.credentialEnv, npm);
  const egress = [...cli.egress];
  if (egress.length > 0) checkEgress(egress);
  return {
    transport: "cli",
    command: cli.command,
    bin: cli.bin,
    egress,
    credentialEnv: cli.credentialEnv,
    ...deliverySettings(
      {
        egress,
        credentialEnv: cli.credentialEnv,
        credentialHosts: cli.credentialHosts ?? [],
        credentialAuth: cli.credentialAuth ?? null,
        credentialDelivery: cli.credentialDelivery ?? null,
      },
      { npm },
    ),
  };
}

function checkEgress(egress: readonly string[]): void {
  try {
    parseEgressAllow(egress);
  } catch (error) {
    if (error instanceof EgressConfigError)
      throw new ConnectError("invalid_settings", error.message);
    throw error;
  }
}

/** A credential variable heel can set: a valid name, and not one the runner or (for npm) heel sets itself. */
function checkCredentialEnv(name: string, npm: boolean): void {
  if (!isEnvName(name)) {
    throw new ConnectError(
      "invalid_settings",
      "--credential-env must be an environment variable name",
    );
  }
  if (isReservedEnv(name) || (npm && isNpmConfigEnv(name))) {
    throw new ConnectError(
      "invalid_settings",
      `--credential-env ${name} is a variable heel sets itself; name another`,
    );
  }
}

/** What `heel connect` calls an MCP passthrough account. */
export const MCP_PASSTHROUGH = "mcp";

/** The provider an MCP passthrough account is stored under (spec: Call model). */
export function mcpProvider(alias: string): string {
  return `${MCP_PASSTHROUGH}:${alias}`;
}

export function isMcpProvider(provider: string): boolean {
  return provider.startsWith(`${MCP_PASSTHROUGH}:`);
}

/**
 * The settings an MCP passthrough account stores: a remote server's URL, or
 * how to start a local one. Exactly one of the two.
 */
function mcpSettings(input: ConnectInput): Record<string, unknown> {
  if ((input.url === undefined) === (input.stdio === undefined)) {
    throw new ConnectError(
      "invalid_settings",
      "mcp needs either --url <upstream> or --command <path>",
    );
  }
  if (input.url !== undefined) {
    const problem = upstreamUrlProblem(input.url);
    if (problem !== null) throw new ConnectError("invalid_settings", problem);
    if (input.oauth === true && input.credential !== undefined) {
      throw new ConnectError(
        "invalid_settings",
        "--oauth signs in from the Connections page; give no token",
      );
    }
    return { transport: "http", url: input.url, oauth: input.oauth === true };
  }
  if (input.oauth === true) {
    throw new ConnectError("invalid_settings", "--oauth is for remote servers (--url)");
  }
  const stdio = input.stdio as NonNullable<ConnectInput["stdio"]>;
  if (!stdio.command.startsWith("/")) {
    throw new ConnectError(
      "invalid_settings",
      "--command must be an absolute path; heel never looks it up on PATH",
    );
  }
  try {
    parseEgressAllow(stdio.egress);
  } catch (error) {
    if (error instanceof EgressConfigError)
      throw new ConnectError("invalid_settings", error.message);
    throw error;
  }
  if (!stdio.mounts.every((path) => path.startsWith("/"))) {
    throw new ConnectError("invalid_settings", "--mount paths must be absolute");
  }
  if (stdio.credentialEnv !== null) checkCredentialEnv(stdio.credentialEnv, false);
  if (input.credential !== undefined && stdio.credentialEnv === null) {
    throw new ConnectError(
      "invalid_settings",
      "a local server's credential needs --credential-env <NAME>",
    );
  }
  return {
    transport: "stdio",
    command: stdio.command,
    args: stdio.args,
    egress: stdio.egress,
    credentialEnv: stdio.credentialEnv,
    ...deliverySettings(
      {
        egress: stdio.egress,
        credentialEnv: stdio.credentialEnv,
        credentialHosts: stdio.credentialHosts ?? [],
        credentialAuth: stdio.credentialAuth ?? null,
        credentialDelivery: stdio.credentialDelivery ?? null,
      },
      { npm: false },
    ),
    mounts: stdio.mounts,
  };
}

/** How a sandboxed program's credential is to reach it, as `heel connect` and `heel account set` give it. */
interface DeliveryFlags {
  egress: readonly string[];
  credentialEnv: string | null;
  credentialHosts: readonly string[];
  credentialAuth: string | null;
  credentialDelivery: CredentialDeliveryChoice | null;
}

/** What an account stores about its credential's delivery (see `definitions/credential-delivery.ts`). */
interface DeliveryStored {
  credentialHosts: string[];
  credentialAuth: string | null;
  credentialDelivery: CredentialDeliveryChoice | null;
}

/**
 * A sandboxed program's delivery settings, checked:
 *
 * - With credential hosts: each is one the program may reach, a credential
 *   variable carries the placeholder (npm may go without: heel writes its
 *   token into npm's config), and the auth is one heel can rewrite (never a
 *   URL query), `bearer` by default and the only one npm sends.
 * - `--credential-delivery env`: the operator chose to give the program the
 *   credential itself; there must be a variable for it, and no hosts.
 * - Neither, with a credential variable: refused, naming both fixes, since
 *   such an account's calls would be refused anyway.
 */
function deliverySettings(flags: DeliveryFlags, options: { npm: boolean }): DeliveryStored {
  const hosts = flags.credentialHosts;
  if (flags.credentialDelivery === "env") {
    if (hosts.length > 0 || flags.credentialAuth !== null) {
      throw new ConnectError(
        "invalid_settings",
        "--credential-delivery env gives the program the credential itself; leave out --credential-host and --credential-auth",
      );
    }
    if (flags.credentialEnv === null) {
      throw new ConnectError(
        "invalid_settings",
        "--credential-delivery env needs --credential-env <NAME>, the variable the credential goes in",
      );
    }
    return { credentialHosts: [], credentialAuth: null, credentialDelivery: "env" };
  }
  if (hosts.length === 0) {
    if (flags.credentialDelivery === "proxy") {
      throw new ConnectError(
        "invalid_settings",
        "--credential-delivery proxy needs --credential-host <host>, the hosts heel adds the credential for",
      );
    }
    if (flags.credentialAuth !== null) {
      throw new ConnectError(
        "invalid_settings",
        "--credential-auth needs --credential-host <host>",
      );
    }
    if (flags.credentialEnv !== null) {
      throw new ConnectError(
        "invalid_settings",
        `the credential would be in the program's environment (${flags.credentialEnv}), where anything it runs can read it. ` +
          "Add --credential-host <host> (one of its --egress hosts) and heel adds the credential on the wire instead, " +
          "or accept that risk with --credential-delivery env",
      );
    }
    return { credentialHosts: [], credentialAuth: null, credentialDelivery: null };
  }
  if (flags.credentialEnv === null && !options.npm) {
    throw new ConnectError(
      "invalid_settings",
      "--credential-host needs --credential-env <NAME>, the variable the program reads its credential from",
    );
  }
  let egress: ReturnType<typeof parseEgressAllow>;
  let parsed: ReturnType<typeof parseEgressAllow>;
  try {
    egress = parseEgressAllow(flags.egress);
    parsed = parseEgressAllow(hosts);
  } catch (error) {
    if (error instanceof EgressConfigError)
      throw new ConnectError("invalid_settings", error.message);
    throw error;
  }
  const outside = parsed.findIndex((host) => !isAllowlisted(egress, host));
  if (outside !== -1) {
    throw new ConnectError(
      "invalid_settings",
      `--credential-host ${hosts[outside]} isn't one of the account's --egress hosts`,
    );
  }
  const auth = flags.credentialAuth ?? "bearer";
  if (parseCredentialAuth(auth) === null) {
    throw new ConnectError(
      "invalid_settings",
      "--credential-auth is bearer, basic or header:<Name>; heel won't put a credential in a URL",
    );
  }
  if (options.npm && auth !== "bearer") {
    throw new ConnectError(
      "invalid_settings",
      "npm sends its registry token as a bearer token: --credential-auth bearer (or leave it out)",
    );
  }
  return { credentialHosts: [...hosts], credentialAuth: auth, credentialDelivery: "proxy" };
}

/** What `heel account set` may change. */
export interface ConfigureInput {
  /** Empty only with `credentialDelivery: env`. */
  credentialHosts: string[];
  /** Null keeps the account's current auth (`bearer` if it had none). */
  credentialAuth: string | null;
  /** `env` to give the program the credential itself; `proxy` (or null) with hosts. */
  credentialDelivery?: CredentialDeliveryChoice | null | undefined;
  /** A replacement static credential, e.g. after rotating one the program held. */
  credential?: CredentialPayload | undefined;
}

export interface ConfiguredAccount {
  alias: string;
  accountId: string;
  credentialDelivery: SandboxCredentialDelivery | null;
  /**
   * The program held the credential in its environment until now (or did,
   * before heel refused that by default), and it wasn't replaced here:
   * rotate it, since anything the program ran could have copied it.
   */
  rotate: boolean;
}

/**
 * `heel account set <alias> --credential-host …` (or `--credential-delivery
 * env`): changes how a local MCP server's or a CLI's credential reaches its
 * sandbox, without reconnecting the account. Settings only; the stored
 * credential is untouched unless a replacement is given. The caller stops any
 * running server, so the old environment doesn't outlive the change.
 */
export function configureAccount(
  db: HeelDb,
  vault: Vault | null,
  orgId: string,
  alias: string,
  input: ConfigureInput,
): ConfiguredAccount {
  const row = db
    .select({ id: accounts.id, provider: accounts.provider, settings: accounts.settings })
    .from(accounts)
    .where(and(eq(accounts.orgId, orgId), eq(accounts.alias, alias)))
    .get();
  if (!row) throw new ConnectError("not_found", `no account named "${alias}"`);
  const upstream = upstreamSettings(row.settings);
  const cli = upstream === null ? cliSettings(row.settings) : null;
  const current = upstream?.transport === "stdio" ? upstream : cli;
  if (current === null || cli?.command === "gh" || cli?.command === "kubectl") {
    throw new ConnectError(
      "invalid_settings",
      cli?.command === "gh"
        ? "gh accounts already get their token at heel's egress proxy; there is nothing to set"
        : "only local MCP servers (heel connect mcp --command) and CLIs (heel connect cli) have credential hosts",
    );
  }
  const delivery = input.credentialDelivery ?? null;
  if (input.credentialHosts.length === 0 && delivery !== "env") {
    throw new ConnectError(
      "invalid_settings",
      "give at least one --credential-host <host>, or --credential-delivery env",
    );
  }
  const settings = {
    ...current,
    ...deliverySettings(
      {
        egress: current.egress,
        credentialEnv: current.credentialEnv,
        credentialHosts: input.credentialHosts,
        credentialAuth:
          delivery === "env"
            ? input.credentialAuth
            : (input.credentialAuth ?? current.credentialAuth),
        credentialDelivery: delivery,
      },
      { npm: cli?.command === "npm" },
    ),
  };
  if (input.credential !== undefined && vault === null) {
    throw new ConnectError(
      "vault_unavailable",
      "the vault is not open (no master key), so credentials cannot be stored",
    );
  }
  const before = sandboxCredentialDelivery(row.settings);
  const after = sandboxCredentialDelivery(settings);
  // The new credential first: if storing it fails, the account still runs as it did.
  if (input.credential !== undefined) vault?.put(row.id, input.credential);
  db.update(accounts).set({ settings }).where(eq(accounts.id, row.id)).run();
  return {
    alias,
    accountId: row.id,
    credentialDelivery: after,
    // A refused account ran with the credential in its environment before heel refused that.
    rotate:
      after === "proxy" &&
      (before === "env" || before === "refused") &&
      input.credential === undefined,
  };
}

/**
 * How an account's credential reaches its sandbox: `proxy` (heel adds it on
 * the wire), `env` (the sandboxed program holds it, as the operator chose),
 * `refused` (it would hold it, unchosen, so calls are refused), or null when
 * no sandbox gets it (built-in providers, HTTP accounts, remote MCP servers).
 */
export function sandboxCredentialDelivery(
  settings: Record<string, unknown>,
): SandboxCredentialDelivery | null {
  const upstream = upstreamSettings(settings);
  if (upstream?.transport === "stdio") return credentialDelivery(upstream);
  if (upstream !== null) return null;
  const cli = cliSettings(settings);
  return cli === null ? null : cliCredentialDelivery(cli);
}

/** Pure: why an upstream MCP URL can't be used, or null. https, or http on loopback only. */
export function upstreamUrlProblem(text: string): string | null {
  if (!URL.canParse(text)) return "the upstream URL doesn't parse";
  const url = new URL(text);
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && isLoopbackUrl(url)) return null;
  return "the upstream URL must be https:// (http:// only on localhost)";
}

export type ConnectErrorCode =
  | "invalid_alias"
  | "unknown_provider"
  | "invalid_settings"
  | "alias_taken"
  | "not_found"
  | "vault_unavailable";

export class ConnectError extends Error {
  override readonly name = "ConnectError";
  readonly code: ConnectErrorCode;
  constructor(code: ConnectErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ConnectInput {
  orgId: string;
  ownerId: string;
  provider: string;
  alias: string;
  credential?: CredentialPayload;
  /** For `mcp`: the upstream server's URL (a remote server). */
  url?: string;
  /** For `http` (D7a): the base URL, `--auth`, and the OpenAPI file's text. */
  http?: { baseUrl: string; auth: string; openapi: string };
  /** For `cli` (D8b): the command name, the binary heel runs, extra egress, and where the credential goes. */
  cli?: {
    command: string;
    bin: string;
    egress: string[];
    credentialEnv: string | null;
    /** Hosts heel's egress proxy adds the credential for; the CLI gets a placeholder. */
    credentialHosts?: string[] | undefined;
    /** `bearer` (the default), `basic` or `header:<Name>`. */
    credentialAuth?: string | null | undefined;
    /** `env` to give the CLI the credential itself (`--credential-delivery env`). */
    credentialDelivery?: CredentialDeliveryChoice | null | undefined;
  };
  /** For a remote `mcp` server that wants OAuth sign-in (D5c). */
  oauth?: boolean;
  /** For `mcp`: a local server heel starts in the sandbox, instead of a URL. */
  stdio?: {
    command: string;
    args: string[];
    egress: string[];
    credentialEnv: string | null;
    /** Hosts heel's egress proxy adds the credential for; the server gets a placeholder. */
    credentialHosts?: string[] | undefined;
    /** `bearer` (the default), `basic` or `header:<Name>`. */
    credentialAuth?: string | null | undefined;
    /** `env` to give the server the credential itself (`--credential-delivery env`). */
    credentialDelivery?: CredentialDeliveryChoice | null | undefined;
    mounts: string[];
  };
}

export interface ConnectedAccount {
  accountId: string;
  alias: string;
  provider: string;
  status: AccountStatus;
}

/**
 * Registers an account. Without a credential it stays `reconnect_required`,
 * so every call on it is denied until one is stored. A credential needs an
 * open vault; with no master key, nothing is written.
 */
export function connectAccount(
  db: HeelDb,
  vault: Vault | null,
  input: ConnectInput,
  now: Date,
): ConnectedAccount {
  if (!isValidAlias(input.alias)) {
    throw new ConnectError(
      "invalid_alias",
      "aliases are 1–64 lower-case letters, digits or '-', starting with a letter",
    );
  }
  const passthrough = input.provider === MCP_PASSTHROUGH;
  const http = input.provider === HTTP_PASSTHROUGH;
  const cli = input.provider === CLI_PASSTHROUGH;
  if (!passthrough && (input.url !== undefined || input.stdio !== undefined)) {
    throw new ConnectError("invalid_settings", "--url and --command are only for mcp accounts");
  }
  if (!http && input.http !== undefined) {
    throw new ConnectError(
      "invalid_settings",
      "--base-url and --openapi are only for http accounts",
    );
  }
  if (!cli && input.cli !== undefined) {
    throw new ConnectError("invalid_settings", "--bin is only for cli accounts");
  }
  const settings = passthrough
    ? mcpSettings(input)
    : http
      ? httpAccountSettings(input)
      : cli
        ? cliAccountSettings(input)
        : {};
  if (!passthrough && !http && !cli && !isBuiltInProvider(input.provider)) {
    throw new ConnectError(
      "unknown_provider",
      `unknown provider "${input.provider}"; use mcp, or a built-in provider: ${BUILT_IN_PROVIDERS.join(", ")}`,
    );
  }
  if (SIGNS_IN.has(input.provider) && input.credential !== undefined) {
    throw new ConnectError(
      "invalid_settings",
      `${input.provider} signs in from the Connections page; give no credential`,
    );
  }
  if (input.credential && !vault) {
    throw new ConnectError(
      "vault_unavailable",
      "the vault is not open (no master key), so credentials cannot be stored",
    );
  }
  const accountId = newId("account");
  db.transaction((tx) => {
    const existing = tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.orgId, input.orgId), eq(accounts.alias, input.alias)))
      .get();
    if (existing) {
      throw new ConnectError("alias_taken", `an account named "${input.alias}" already exists`);
    }
    tx.insert(accounts)
      .values({
        id: accountId,
        orgId: input.orgId,
        ownerId: input.ownerId,
        alias: input.alias,
        provider: passthrough
          ? mcpProvider(input.alias)
          : http
            ? httpProvider(input.alias)
            : cli
              ? cliProvider((input.cli as { command: string }).command)
              : input.provider,
        settings,
        // A built-in provider needs its credential first; a passthrough may need none,
        // unless its owner still has to sign in to it (OAuth).
        status: passthrough && settings["oauth"] !== true ? "active" : "reconnect_required",
        createdAt: now,
      })
      .run();
  });
  if (input.credential && vault) {
    try {
      vault.put(accountId, input.credential);
    } catch (error) {
      // Do not leave an alias behind that looks connected but has no credential.
      db.delete(accounts).where(eq(accounts.id, accountId)).run();
      throw error;
    }
  }
  const row = db
    .select({ status: accounts.status })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .get();
  if (!row) throw new Error(`account ${accountId} vanished while connecting`);
  return {
    accountId,
    alias: input.alias,
    provider: passthrough
      ? mcpProvider(input.alias)
      : http
        ? httpProvider(input.alias)
        : cli
          ? cliProvider((input.cli as { command: string }).command)
          : input.provider,
    status: row.status,
  };
}

export interface AccountSummary {
  id: string;
  alias: string;
  provider: string;
  ownerId: string;
  /** The owner's user name, as rules files are named. */
  owner: string;
  status: AccountStatus;
  /**
   * For accounts whose credential a sandboxed program uses: `env` means the
   * program holds it (the operator chose that), `refused` that its calls are
   * refused until the operator chooses.
   */
  credentialDelivery: SandboxCredentialDelivery | null;
}

export function listAccounts(db: HeelDb, orgId: string): AccountSummary[] {
  return db
    .select({
      id: accounts.id,
      alias: accounts.alias,
      provider: accounts.provider,
      ownerId: accounts.ownerId,
      owner: users.name,
      status: accounts.status,
      settings: accounts.settings,
    })
    .from(accounts)
    .innerJoin(users, eq(users.id, accounts.ownerId))
    .where(eq(accounts.orgId, orgId))
    .orderBy(accounts.alias)
    .all()
    .map(({ settings, ...row }) => ({
      ...row,
      credentialDelivery: sandboxCredentialDelivery(settings),
    }));
}
