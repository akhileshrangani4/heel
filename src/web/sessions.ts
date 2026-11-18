import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { HeelDb } from "../store/db.ts";
import { type SessionMethod, sessions, type UserRole, users } from "../store/schema.ts";

/** Sessions last at most 12 h (spec: Teams). */
export const SESSION_TTL_MS = 12 * 60 * 60_000;

/** The signed-in person, as human-plane routes see them. */
export interface SessionView {
  orgId: string;
  userId: string;
  userName: string;
  role: UserRole;
  method: SessionMethod;
  csrfToken: string;
  expiresAt: Date;
}

/** Pure: the stored id for a session cookie value. Only the hash is stored. */
export function hashSessionCookie(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Pure: the cookie name. `__Host-` pins the cookie to this exact origin and
 * path `/`, which browsers allow only on `https://` (spec: Listeners).
 */
export function sessionCookieName(publicUrl: URL): string {
  return publicUrl.protocol === "https:" ? "__Host-heel_session" : "heel_session";
}

/** Pure: constant-time comparison of a submitted CSRF token with the session's. */
export function csrfMatches(expected: string, submitted: string | undefined): boolean {
  if (submitted === undefined) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(submitted, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface StartedSession {
  cookieValue: string;
  expiresAt: Date;
}

/** Starts a session after a verified sign-in. The cookie value is returned once and never stored. */
export function startSession(
  db: HeelDb,
  input: { orgId: string; userId: string; method: SessionMethod; now: Date },
): StartedSession {
  const cookieValue = randomBytes(32).toString("base64url");
  const expiresAt = new Date(input.now.getTime() + SESSION_TTL_MS);
  db.insert(sessions)
    .values({
      id: hashSessionCookie(cookieValue),
      orgId: input.orgId,
      userId: input.userId,
      method: input.method,
      csrfToken: randomBytes(24).toString("base64url"),
      createdAt: input.now,
      expiresAt,
    })
    .run();
  return { cookieValue, expiresAt };
}

/** The live session a cookie names; null when it is unknown, ended, expired or its user is disabled. */
export function readSession(db: HeelDb, cookieValue: string, now: Date): SessionView | null {
  const row = db
    .select({
      orgId: sessions.orgId,
      userId: sessions.userId,
      userName: users.name,
      role: users.role,
      method: sessions.method,
      csrfToken: sessions.csrfToken,
      expiresAt: sessions.expiresAt,
      disabledAt: users.disabledAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.id, hashSessionCookie(cookieValue)),
        isNull(sessions.endedAt),
        gt(sessions.expiresAt, now),
      ),
    )
    .get();
  if (row === undefined || row.disabledAt !== null) return null;
  const { disabledAt: _disabled, ...view } = row;
  return view;
}

/** Ends a session (sign-out). Ending an unknown or ended session is a no-op. */
export function endSession(db: HeelDb, cookieValue: string, now: Date): void {
  db.update(sessions)
    .set({ endedAt: now })
    .where(and(eq(sessions.id, hashSessionCookie(cookieValue)), isNull(sessions.endedAt)))
    .run();
}
