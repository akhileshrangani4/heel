import { and, eq, isNull } from "drizzle-orm";
import type { HeelQuery } from "../gateway/pipeline/ports.ts";
import type { HeelDb, HeelTx } from "./db.ts";
import { type AccountRecord, accountsOwnedBy, findAccount } from "./directory.ts";
import { newId } from "./ids.ts";
import { accountApprovers, accountShares, accounts, type PrincipalKind, users } from "./schema.ts";

/**
 * Account sharing and approvers.
 *
 * - An account's owner may use it, and so may every user or IdP group it is
 *   shared with. An agent may call an account only if the agent's owner may.
 * - An account's asks go to its approvers, or to its owner when it names
 *   none. A GitHub account can name approvers for one repo; a call on that
 *   repo goes to them instead. Disabled users never decide.
 * - Groups mean their members as of each member's last sign-in, and only
 *   for a session's maximum (12 hours) after it: agents act without anyone
 *   signing in, so someone removed from a group in the IdP loses what it
 *   gave them within a day, not whenever they next sign in.
 * - A disabled owner's account can't be used by anyone.
 * - An org ask goes to admins. Being an admin doesn't make anyone an
 *   approver of an account.
 */

export interface Principal {
  kind: PrincipalKind;
  /** A user name, or a group name exactly as the IdP sends it. */
  name: string;
}

export class SharingError extends Error {
  override readonly name = "SharingError";
  readonly code: "unknown_account" | "unknown_user" | "invalid";

  constructor(code: SharingError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/** How long groups read at a sign-in keep counting: a session's maximum, 12 h. */
export const GROUPS_FRESH_MS = 12 * 60 * 60_000;

/** A user's groups, if read from the IdP recently enough to count. */
function freshGroups(user: { groups: string[]; groupsSyncedAt: Date | null }, now: Date): string[] {
  if (user.groupsSyncedAt === null) return [];
  return now.getTime() - user.groupsSyncedAt.getTime() <= GROUPS_FRESH_MS ? user.groups : [];
}

function liveUser(db: HeelQuery, userId: string) {
  return db
    .select({ id: users.id, groups: users.groups, groupsSyncedAt: users.groupsSyncedAt })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.disabledAt)))
    .get();
}

/** Whether a user may use an account: they own it, or it is shared with them or one of their groups. */
export function mayUseAccount(
  db: HeelQuery,
  account: Pick<AccountRecord, "id" | "ownerId">,
  userId: string,
  now: Date = new Date(),
): boolean {
  // Nobody uses a disabled owner's account, and a disabled user uses nothing.
  if (liveUser(db, account.ownerId) === undefined) return false;
  if (account.ownerId === userId) return true;
  const user = liveUser(db, userId);
  if (user === undefined) return false;
  const groups = freshGroups(user, now);
  const shares = db
    .select({ kind: accountShares.kind, principal: accountShares.principal })
    .from(accountShares)
    .where(eq(accountShares.accountId, account.id))
    .all();
  return shares.some(
    (s) =>
      (s.kind === "user" && s.principal === user.id) ||
      (s.kind === "group" && groups.includes(s.principal)),
  );
}

/** Every account a user may use, by alias: their own and those shared with them. */
export function accountsUsableBy(
  db: HeelDb | HeelTx,
  orgId: string,
  userId: string,
): AccountRecord[] {
  const own = accountsOwnedBy(db, orgId, userId);
  const sharedIds = new Set(
    db
      .select({ accountId: accountShares.accountId })
      .from(accountShares)
      .where(eq(accountShares.orgId, orgId))
      .all()
      .map((s) => s.accountId),
  );
  const shared = db
    .select({ alias: accounts.alias, id: accounts.id, ownerId: accounts.ownerId })
    .from(accounts)
    .where(eq(accounts.orgId, orgId))
    .all()
    .filter((a) => sharedIds.has(a.id) && a.ownerId !== userId && mayUseAccount(db, a, userId))
    .map((a) => findAccount(db, orgId, a.alias))
    .filter((a): a is AccountRecord => a !== null);
  return [...own, ...shared].sort((a, b) => a.alias.localeCompare(b.alias));
}

function accountId(db: HeelQuery, orgId: string, alias: string): string {
  const row = db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.orgId, orgId), eq(accounts.alias, alias)))
    .get();
  if (row === undefined) throw new SharingError("unknown_account", `no account named "${alias}"`);
  return row.id;
}

/** A principal as stored: a user's id, or the group name. */
function stored(db: HeelQuery, orgId: string, principal: Principal): string {
  if (principal.kind === "group") {
    // Exactly as the IdP sends it: surrounding spaces would never match.
    if (
      principal.name.trim() !== principal.name ||
      principal.name === "" ||
      principal.name.length > 256
    ) {
      throw new SharingError(
        "invalid",
        "a group name is 1 to 256 characters, with no surrounding spaces",
      );
    }
    return principal.name;
  }
  const user = db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.orgId, orgId), eq(users.name, principal.name)))
    .get();
  if (user === undefined)
    throw new SharingError("unknown_user", `no user named "${principal.name}"`);
  return user.id;
}

export function shareAccount(
  db: HeelDb,
  orgId: string,
  alias: string,
  principal: Principal,
  now: Date,
): void {
  db.transaction((tx) => {
    const id = accountId(tx, orgId, alias);
    tx.insert(accountShares)
      .values({
        id: newId("share"),
        orgId,
        accountId: id,
        kind: principal.kind,
        principal: stored(tx, orgId, principal),
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();
  });
}

export function unshareAccount(
  db: HeelDb,
  orgId: string,
  alias: string,
  principal: Principal,
): void {
  db.transaction((tx) => {
    const id = accountId(tx, orgId, alias);
    tx.delete(accountShares)
      .where(
        and(
          eq(accountShares.accountId, id),
          eq(accountShares.kind, principal.kind),
          eq(accountShares.principal, stored(tx, orgId, principal)),
        ),
      )
      .run();
  });
}

/**
 * Replaces an account's approvers for one scope: every call (`repo` null),
 * or one GitHub repo. An empty list clears that scope, so with no general
 * approvers left the owner decides again.
 */
export function setApprovers(
  db: HeelDb,
  orgId: string,
  alias: string,
  repo: string | null,
  approvers: readonly Principal[],
  now: Date,
): void {
  db.transaction((tx) => {
    const id = accountId(tx, orgId, alias);
    if (repo !== null) {
      const provider = tx
        .select({ provider: accounts.provider })
        .from(accounts)
        .where(eq(accounts.id, id))
        .get()?.provider;
      if (provider !== "github" && provider !== "cli:gh") {
        throw new SharingError("invalid", "per-repo approvers are only for GitHub accounts");
      }
      if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repo)) {
        throw new SharingError("invalid", `not a repo: ${repo}`);
      }
    }
    const scope = repo === null ? null : repo.toLowerCase();
    tx.delete(accountApprovers)
      .where(
        and(
          eq(accountApprovers.accountId, id),
          scope === null ? isNull(accountApprovers.repo) : eq(accountApprovers.repo, scope),
        ),
      )
      .run();
    const seen = new Set<string>();
    for (const approver of approvers) {
      const principal = stored(tx, orgId, approver);
      // SQLite's unique index treats a null repo as distinct, so repeats are dropped here.
      if (seen.has(`${approver.kind} ${principal}`)) continue;
      seen.add(`${approver.kind} ${principal}`);
      tx.insert(accountApprovers)
        .values({
          id: newId("approver"),
          orgId,
          accountId: id,
          kind: approver.kind,
          principal,
          repo: scope,
          createdAt: now,
        })
        .run();
    }
  });
}

/** An account's shares and approvers, by name, for `heel account list`. */
export function sharingOf(db: HeelQuery, orgId: string, alias: string) {
  const id = accountId(db, orgId, alias);
  const names = new Map(
    db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(eq(users.orgId, orgId))
      .all()
      .map((u) => [u.id, u.name]),
  );
  const named = (kind: PrincipalKind, principal: string) =>
    kind === "user" ? { user: names.get(principal) ?? principal } : { group: principal };
  return {
    sharedWith: db
      .select({ kind: accountShares.kind, principal: accountShares.principal })
      .from(accountShares)
      .where(eq(accountShares.accountId, id))
      .all()
      .map((s) => named(s.kind, s.principal)),
    approvers: db
      .select({
        kind: accountApprovers.kind,
        principal: accountApprovers.principal,
        repo: accountApprovers.repo,
      })
      .from(accountApprovers)
      .where(eq(accountApprovers.accountId, id))
      .all()
      .map((a) => ({
        ...named(a.kind, a.principal),
        ...(a.repo === null ? {} : { repo: a.repo }),
      })),
  };
}

/** The live users a set of principals names. */
function expand(
  db: HeelQuery,
  orgId: string,
  principals: readonly { kind: PrincipalKind; principal: string }[],
): string[] {
  const now = new Date();
  const live = db
    .select({ id: users.id, groups: users.groups, groupsSyncedAt: users.groupsSyncedAt })
    .from(users)
    .where(and(eq(users.orgId, orgId), isNull(users.disabledAt)))
    .all()
    .map((u) => ({ id: u.id, groups: freshGroups(u, now) }));
  const ids = new Set<string>();
  for (const p of principals) {
    for (const user of live) {
      if (
        (p.kind === "user" && p.principal === user.id) ||
        (p.kind === "group" && user.groups.includes(p.principal))
      ) {
        ids.add(user.id);
      }
    }
  }
  return [...ids];
}

/**
 * Who decides an account ask: the approvers named for the call's repo, else
 * the account's general approvers, else its owner.
 */
export function accountApproverIds(
  db: HeelQuery,
  orgId: string,
  alias: string,
  repo: string | undefined,
): string[] {
  const account = db
    .select({ id: accounts.id, ownerId: accounts.ownerId })
    .from(accounts)
    .where(and(eq(accounts.orgId, orgId), eq(accounts.alias, alias)))
    .get();
  if (account === undefined) return [];
  const named = db
    .select({
      kind: accountApprovers.kind,
      principal: accountApprovers.principal,
      repo: accountApprovers.repo,
    })
    .from(accountApprovers)
    .where(eq(accountApprovers.accountId, account.id))
    .all();
  const forRepo = repo === undefined ? [] : named.filter((a) => a.repo === repo.toLowerCase());
  if (forRepo.length > 0) return expand(db, orgId, forRepo);
  const general = named.filter((a) => a.repo === null);
  if (general.length > 0) return expand(db, orgId, general);
  return expand(db, orgId, [{ kind: "user", principal: account.ownerId }]);
}
