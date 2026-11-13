import { and, eq } from "drizzle-orm";
import type { HeelDb } from "./db.ts";
import { newId } from "./ids.ts";
import { orgs, users } from "./schema.ts";

/** The name of the user a single-user install creates for its operator. */
export const LOCAL_OWNER_NAME = "owner";

export interface Install {
  orgId: string;
}

/**
 * Returns the install's org, creating it on first boot. v1 supports one org
 * per install (spec: Teams); more than one row means the database was edited
 * by hand or by a newer heel, and guessing which org to serve would be unsafe.
 */
export function ensureInstall(db: HeelDb, now: Date): Install {
  return db.transaction((tx) => {
    const rows = tx.select({ id: orgs.id }).from(orgs).limit(2).all();
    if (rows.length > 1) {
      throw new Error("this database holds more than one org; heel v0.1 serves exactly one");
    }
    const existing = rows[0];
    if (existing) return { orgId: existing.id };
    const orgId = newId("org");
    tx.insert(orgs).values({ id: orgId, name: "default", createdAt: now }).run();
    return { orgId };
  });
}

/**
 * Returns the user who owns agents on a single-user install, creating it the
 * first time. Passkey enrollment (D4) attaches to this user; OIDC installs
 * (D13) create users at sign-in instead.
 */
export function ensureLocalOwner(db: HeelDb, orgId: string, now: Date): string {
  return db.transaction((tx) => {
    const existing = tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.orgId, orgId), eq(users.name, LOCAL_OWNER_NAME)))
      .get();
    if (existing) return existing.id;
    const id = newId("user");
    tx.insert(users)
      .values({
        id,
        orgId,
        name: LOCAL_OWNER_NAME,
        role: "admin",
        oidcSubject: null,
        createdAt: now,
      })
      .run();
    return id;
  });
}
