import { and, eq } from "drizzle-orm";
import { isLoopbackUrl } from "../config/schema.ts";
import { OpenApiError, type Operation, parseOpenApi } from "../definitions/http/openapi.ts";
import { isEnvName } from "../definitions/mcp/settings.ts";
import { EgressConfigError, parseEgressAllow } from "../runner/egress.ts";
import type { HeelDb } from "../store/db.ts";
import { newId } from "../store/ids.ts";
import { type AccountStatus, accounts } from "../store/schema.ts";
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
  if (stdio.credentialEnv !== null && !isEnvName(stdio.credentialEnv)) {
    throw new ConnectError(
      "invalid_settings",
      "--credential-env must be an environment variable name",
    );
  }
  if (input.credential !== undefined && stdio.credentialEnv === null) {
    throw new ConnectError(
      "invalid_settings",
      "a local server's credential needs --credential-env <NAME>",
    );
  }
  return { transport: "stdio", ...stdio };
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
  /** For a remote `mcp` server that wants OAuth sign-in (D5c). */
  oauth?: boolean;
  /** For `mcp`: a local server heel starts in the sandbox, instead of a URL. */
  stdio?: {
    command: string;
    args: string[];
    egress: string[];
    credentialEnv: string | null;
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
  if (!passthrough && (input.url !== undefined || input.stdio !== undefined)) {
    throw new ConnectError("invalid_settings", "--url and --command are only for mcp accounts");
  }
  if (!http && input.http !== undefined) {
    throw new ConnectError(
      "invalid_settings",
      "--base-url and --openapi are only for http accounts",
    );
  }
  const settings = passthrough ? mcpSettings(input) : http ? httpAccountSettings(input) : {};
  if (!passthrough && !http && !isBuiltInProvider(input.provider)) {
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
        : input.provider,
    status: row.status,
  };
}

export interface AccountSummary {
  id: string;
  alias: string;
  provider: string;
  ownerId: string;
  status: AccountStatus;
}

export function listAccounts(db: HeelDb, orgId: string): AccountSummary[] {
  return db
    .select({
      id: accounts.id,
      alias: accounts.alias,
      provider: accounts.provider,
      ownerId: accounts.ownerId,
      status: accounts.status,
    })
    .from(accounts)
    .where(eq(accounts.orgId, orgId))
    .orderBy(accounts.alias)
    .all();
}
