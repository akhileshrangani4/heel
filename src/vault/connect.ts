import { and, eq } from "drizzle-orm";
import { isLoopbackUrl } from "../config/schema.ts";
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

/** What `heel connect` calls an MCP passthrough account. */
export const MCP_PASSTHROUGH = "mcp";

/** The provider an MCP passthrough account is stored under (spec: Call model). */
export function mcpProvider(alias: string): string {
  return `${MCP_PASSTHROUGH}:${alias}`;
}

export function isMcpProvider(provider: string): boolean {
  return provider.startsWith(`${MCP_PASSTHROUGH}:`);
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
  /** For `mcp`: the upstream server's URL. */
  url?: string;
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
  if (passthrough) {
    const problem =
      input.url === undefined ? "mcp needs --url <upstream>" : upstreamUrlProblem(input.url);
    if (problem !== null) throw new ConnectError("invalid_settings", problem);
  } else if (input.url !== undefined) {
    throw new ConnectError("invalid_settings", "--url is only for mcp accounts");
  }
  if (!passthrough && !isBuiltInProvider(input.provider)) {
    throw new ConnectError(
      "unknown_provider",
      `unknown provider "${input.provider}"; use mcp, or a built-in provider: ${BUILT_IN_PROVIDERS.join(", ")}`,
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
        provider: passthrough ? mcpProvider(input.alias) : input.provider,
        settings: passthrough ? { url: input.url } : {},
        // A built-in provider needs its credential first; a passthrough may need none.
        status: passthrough ? "active" : "reconnect_required",
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
    provider: passthrough ? mcpProvider(input.alias) : input.provider,
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
