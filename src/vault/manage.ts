import { and, eq, inArray, isNull } from "drizzle-orm";
import { parse } from "yaml";
import type { HeelDb } from "../store/db.ts";
import {
  accountApprovers,
  accountShares,
  accounts,
  approvals,
  credentials,
  grants,
  standingApprovals,
} from "../store/schema.ts";
import { ConnectError } from "./connect.ts";
import type { CredentialPayload, Vault } from "./vault.ts";

/**
 * `heel account remove` and `heel account set <alias> --credential-stdin`:
 * the two account changes that don't need the provider's sign-in again.
 */

export interface RemovedAccount {
  alias: string;
  accountId: string;
  /** Pending approvals on the account, now expired: nothing will run them. */
  expiredApprovals: number;
  /** Standing approvals and grants that named this account, now revoked. */
  revokedStanding: number;
  revokedGrants: number;
}

function findAccount(db: HeelDb, orgId: string, alias: string) {
  const row = db
    .select({ id: accounts.id, provider: accounts.provider, settings: accounts.settings })
    .from(accounts)
    .where(and(eq(accounts.orgId, orgId), eq(accounts.alias, alias)))
    .get();
  if (!row) throw new ConnectError("not_found", `no account named "${alias}"`);
  return row;
}

/** Whether a grant's match is limited to this account alias (`account: x` or `account: [x, …]`). */
function grantNamesAccount(match: string, alias: string): boolean {
  let parsed: unknown;
  try {
    parsed = parse(match);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object") return false;
  const account = (parsed as Record<string, unknown>)["account"];
  if (account === alias) return true;
  return Array.isArray(account) && account.includes(alias);
}

/**
 * Deletes an account, its stored credential, and who it is shared with and
 * decided by. Anything that would otherwise carry over to a new account
 * connected later under the same alias ends here: pending approvals expire,
 * and standing approvals and grants that name the alias are revoked. The
 * audit log keeps its rows; they record what happened.
 */
export function removeAccount(db: HeelDb, orgId: string, alias: string, now: Date): RemovedAccount {
  const row = findAccount(db, orgId, alias);
  return db.transaction((tx) => {
    const expired = tx
      .update(approvals)
      .set({ status: "expired" })
      .where(
        and(
          eq(approvals.orgId, orgId),
          eq(approvals.account, alias),
          eq(approvals.status, "pending"),
        ),
      )
      .returning({ id: approvals.id })
      .all();

    // Standing approvals carry the account (D13b), or point at an approval on it.
    const onAccount = tx
      .select({ id: approvals.id })
      .from(approvals)
      .where(and(eq(approvals.orgId, orgId), eq(approvals.account, alias)))
      .all()
      .map((a) => a.id);
    const live = and(eq(standingApprovals.orgId, orgId), isNull(standingApprovals.revokedAt));
    const standing = tx
      .update(standingApprovals)
      .set({ revokedAt: now })
      .where(and(live, eq(standingApprovals.account, alias)))
      .returning({ id: standingApprovals.id })
      .all();
    const exact =
      onAccount.length === 0
        ? []
        : tx
            .update(standingApprovals)
            .set({ revokedAt: now })
            .where(
              and(
                live,
                eq(standingApprovals.scope, "exact_call"),
                inArray(standingApprovals.approvalId, onAccount),
              ),
            )
            .returning({ id: standingApprovals.id })
            .all();

    const grantIds = tx
      .select({ id: grants.id, match: grants.match })
      .from(grants)
      .where(and(eq(grants.orgId, orgId), isNull(grants.revokedAt)))
      .all()
      .filter((g) => grantNamesAccount(g.match, alias))
      .map((g) => g.id);
    if (grantIds.length > 0) {
      tx.update(grants).set({ revokedAt: now }).where(inArray(grants.id, grantIds)).run();
    }

    tx.delete(credentials).where(eq(credentials.accountId, row.id)).run();
    tx.delete(accountShares).where(eq(accountShares.accountId, row.id)).run();
    tx.delete(accountApprovers).where(eq(accountApprovers.accountId, row.id)).run();
    tx.delete(accounts).where(eq(accounts.id, row.id)).run();
    return {
      alias,
      accountId: row.id,
      expiredApprovals: expired.length,
      revokedStanding: standing.length + exact.length,
      revokedGrants: grantIds.length,
    };
  });
}

/**
 * Replaces an account's stored API key or token, keeping every setting.
 * Accounts that sign in through a provider (Gmail, Calendar, Outlook, MCP
 * OAuth) hold OAuth tokens instead: they sign in again from Connections.
 */
export function setAccountCredential(
  db: HeelDb,
  vault: Vault | null,
  orgId: string,
  alias: string,
  credential: CredentialPayload & { type: "static" },
): { alias: string; accountId: string } {
  const row = findAccount(db, orgId, alias);
  if (vault === null) {
    throw new ConnectError(
      "vault_unavailable",
      "the vault is not open (no master key), so credentials cannot be stored",
    );
  }
  const stored = db
    .select({ id: credentials.id })
    .from(credentials)
    .where(eq(credentials.accountId, row.id))
    .get();
  if (stored !== undefined && vault.get(row.id).type === "oauth") {
    throw new ConnectError(
      "invalid_settings",
      `"${alias}" signs in with ${row.provider}, so it holds OAuth tokens, not a key; sign in again from the Connections page`,
    );
  }
  vault.put(row.id, credential);
  return { alias, accountId: row.id };
}
