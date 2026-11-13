import { and, eq } from "drizzle-orm";
import type { HeelDb, HeelTx } from "./db.ts";
import { type AccountStatus, accounts, users } from "./schema.ts";

/** The account a call names, as the pipeline needs it. */
export interface AccountRecord {
  id: string;
  orgId: string;
  ownerId: string;
  /** The account owner's user name: their rules file's `hide` entries apply to it. */
  ownerName: string;
  alias: string;
  provider: string;
  status: AccountStatus;
  settings: Record<string, unknown>;
}

/** The account named `alias` in `orgId`, with its owner's name; null when there is none. */
export function findAccount(
  db: HeelDb | HeelTx,
  orgId: string,
  alias: string,
): AccountRecord | null {
  const row = db
    .select({
      id: accounts.id,
      orgId: accounts.orgId,
      ownerId: accounts.ownerId,
      ownerName: users.name,
      alias: accounts.alias,
      provider: accounts.provider,
      status: accounts.status,
      settings: accounts.settings,
    })
    .from(accounts)
    .innerJoin(users, eq(users.id, accounts.ownerId))
    .where(and(eq(accounts.orgId, orgId), eq(accounts.alias, alias)))
    .get();
  return row ?? null;
}

/** A user's name (their rules file is `rules/<name>.yaml`); null when the id is unknown. */
export function userName(db: HeelDb | HeelTx, orgId: string, userId: string): string | null {
  const row = db
    .select({ name: users.name })
    .from(users)
    .where(and(eq(users.orgId, orgId), eq(users.id, userId)))
    .get();
  return row?.name ?? null;
}
