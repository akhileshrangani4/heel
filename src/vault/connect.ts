import { and, eq } from "drizzle-orm";
import type { HeelDb } from "../store/db.ts";
import { newId } from "../store/ids.ts";
import { type AccountStatus, accounts } from "../store/schema.ts";
import type { CredentialPayload, Vault } from "./vault.ts";

/**
 * The skeleton behind `heel connect`: it registers an account alias and,
 * when given one, stores a static credential in the vault. OAuth consent
 * flows and passthrough (MCP, HTTP, CLI) accounts arrive with the
 * deliverables that define those providers.
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

export type ConnectErrorCode =
  | "invalid_alias"
  | "unknown_provider"
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
  if (!isBuiltInProvider(input.provider)) {
    throw new ConnectError(
      "unknown_provider",
      `unknown provider "${input.provider}"; built-in providers are ${BUILT_IN_PROVIDERS.join(", ")}`,
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
        provider: input.provider,
        settings: {},
        status: "reconnect_required",
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
  return { accountId, alias: input.alias, provider: input.provider, status: row.status };
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
