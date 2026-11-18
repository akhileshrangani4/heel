import { createHash, randomBytes } from "node:crypto";
import { and, count, eq, gt, isNull, lt } from "drizzle-orm";
import type { HeelDb } from "../store/db.ts";
import { newId } from "../store/ids.ts";
import { oidcSignIns, sessions, users } from "../store/schema.ts";
import type { OidcIdentity, PendingSignIn } from "./oidc.ts";

/**
 * What heel keeps between sending a person to the IdP and their return
 * (D13b; spec: Teams, "Sign-in"), and who they are once back.
 *
 * - A pending sign-in is stored under the hash of a random cookie set on the
 *   browser that started it, so the callback completes only in that browser,
 *   and it is used once.
 * - People are matched by their IdP issuer and subject, never by name.
 *   Their role and groups are read again at every sign-in. Someone moved out
 *   of every mapped group can't sign in, loses any admin role and groups, and
 *   their sessions end.
 * - A new person's heel name comes from the IdP, normalized (lower case,
 *   letters, digits, `.`, `_`, `-`). If another user already has it, the
 *   sign-in is refused and an admin decides: names are how admin commands
 *   (`heel user enroll`) find people, so one person must never get another's
 *   by signing in first.
 * - At most MAX_PENDING sign-ins are in progress at once, so unauthenticated
 *   requests can't grow the table without bound.
 */

export const MAX_PENDING = 1_000;

export class TooManySignIns extends Error {
  override readonly name = "TooManySignIns";
}

export function hashBinding(cookie: string): string {
  return createHash("sha256").update(cookie, "utf8").digest("hex");
}

/** Stores a pending sign-in; returns the cookie value that binds it to this browser. */
export function savePending(db: HeelDb, pending: PendingSignIn, next: string, now: Date): string {
  const cookie = randomBytes(32).toString("base64url");
  db.transaction((tx) => {
    tx.delete(oidcSignIns).where(lt(oidcSignIns.expiresAt, now)).run();
    const live = tx.select({ n: count() }).from(oidcSignIns).get()?.n ?? 0;
    if (live >= MAX_PENDING) throw new TooManySignIns("too many sign-ins in progress");
    tx.insert(oidcSignIns)
      .values({
        id: hashBinding(cookie),
        state: pending.state,
        nonce: pending.nonce,
        codeVerifier: pending.codeVerifier,
        next,
        expiresAt: pending.expiresAt,
      })
      .run();
  });
  return cookie;
}

/** The pending sign-in this browser's cookie names, removed as it is read; null if none is live. */
export function takePending(
  db: HeelDb,
  cookie: string,
  now: Date,
): { pending: PendingSignIn; next: string } | null {
  return db.transaction((tx) => {
    const id = hashBinding(cookie);
    const row = tx.select().from(oidcSignIns).where(eq(oidcSignIns.id, id)).get();
    tx.delete(oidcSignIns).where(eq(oidcSignIns.id, id)).run();
    if (row === undefined || row.expiresAt.getTime() <= now.getTime()) return null;
    return {
      pending: {
        state: row.state,
        nonce: row.nonce,
        codeVerifier: row.codeVerifier,
        expiresAt: row.expiresAt,
      },
      next: row.next,
    };
  });
}

export type SignInRefusal =
  /** None of the person's groups is mapped to a role. */
  | "no_role"
  /** The heel user for this identity is disabled. */
  | "disabled"
  /** The IdP's name for a new person is another user's, or isn't usable as a name. */
  | "name_unavailable";

/** A heel user name from an IdP name: NFKC, lower case, `[a-z0-9._-]`, 1 to 64 characters; null if none is left. */
export function userNameFrom(raw: string): string | null {
  const name = raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/@.*$/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 64);
  return name === "" ? null : name;
}

/** The subject heel stores: issuer and subject together, so two IdPs never share a person. */
export function subjectKey(identity: Pick<OidcIdentity, "issuer" | "subject">): string {
  return `${identity.issuer} ${identity.subject}`;
}

/**
 * The heel user for a signed-in identity, created on first sign-in. A new
 * user's name is the identity's display name, made unique with a number when
 * another user already has it.
 */
export function userForIdentity(
  db: HeelDb,
  orgId: string,
  identity: OidcIdentity,
  now: Date,
): { ok: true; userId: string } | { ok: false; reason: SignInRefusal } {
  const key = subjectKey(identity);
  if (identity.role === null) {
    // Out of every mapped group: no admin role, no groups, and no live session left.
    db.transaction((tx) => {
      const existing = tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.orgId, orgId), eq(users.oidcSubject, key)))
        .get();
      if (existing === undefined) return;
      tx.update(users).set({ role: "member", groups: [] }).where(eq(users.id, existing.id)).run();
      tx.update(sessions)
        .set({ endedAt: now })
        .where(
          and(
            eq(sessions.userId, existing.id),
            isNull(sessions.endedAt),
            gt(sessions.expiresAt, now),
          ),
        )
        .run();
    });
    return { ok: false, reason: "no_role" };
  }
  const role = identity.role;
  return db.transaction((tx) => {
    const existing = tx
      .select({ id: users.id, disabledAt: users.disabledAt, email: users.email })
      .from(users)
      .where(and(eq(users.orgId, orgId), eq(users.oidcSubject, key)))
      .get();
    if (existing !== undefined) {
      if (existing.disabledAt !== null) return { ok: false as const, reason: "disabled" as const };
      tx.update(users)
        .set({
          role,
          groups: identity.groups,
          groupsSyncedAt: now,
          ...(existing.email === null && identity.email !== null ? { email: identity.email } : {}),
        })
        .where(eq(users.id, existing.id))
        .run();
      return { ok: true as const, userId: existing.id };
    }
    const name = userNameFrom(identity.name);
    if (name === null) return { ok: false as const, reason: "name_unavailable" as const };
    const taken = tx
      .select({ name: users.name })
      .from(users)
      .where(eq(users.orgId, orgId))
      .all()
      .some((u) => u.name.toLowerCase() === name);
    if (taken) return { ok: false as const, reason: "name_unavailable" as const };
    const id = newId("user");
    tx.insert(users)
      .values({
        id,
        orgId,
        name,
        oidcSubject: key,
        role,
        email: identity.email,
        groups: identity.groups,
        groupsSyncedAt: now,
        createdAt: now,
      })
      .run();
    return { ok: true as const, userId: id };
  });
}
