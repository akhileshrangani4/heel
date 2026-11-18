import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { sessions, users } from "../../src/store/schema.ts";
import {
  csrfMatches,
  endSession,
  hashSessionCookie,
  readSession,
  SESSION_TTL_MS,
  sessionCookieName,
  startSession,
} from "../../src/web/sessions.ts";
import { testStore } from "../helpers/store.ts";

const T0 = new Date("2026-11-14T10:00:00Z");
const at = (ms: number): Date => new Date(T0.getTime() + ms);

describe("human-plane sessions", () => {
  it("stores only the cookie's hash and reads the signed-in person back", () => {
    const t = testStore();
    const started = startSession(t.db, {
      orgId: t.orgId,
      userId: t.ownerId,
      method: "passkey",
      now: T0,
    });
    expect(started.expiresAt).toEqual(at(SESSION_TTL_MS));
    const [row] = t.db.select().from(sessions).all();
    expect(row?.id).toBe(hashSessionCookie(started.cookieValue));
    expect(row?.id).not.toBe(started.cookieValue);

    expect(readSession(t.db, started.cookieValue, T0)).toMatchObject({
      orgId: t.orgId,
      userId: t.ownerId,
      userName: "owner",
      role: "admin",
      method: "passkey",
    });
  });

  it("a session lasts at most 12 hours", () => {
    const t = testStore();
    const { cookieValue } = startSession(t.db, {
      orgId: t.orgId,
      userId: t.ownerId,
      method: "passkey",
      now: T0,
    });
    expect(readSession(t.db, cookieValue, at(SESSION_TTL_MS - 1))).not.toBeNull();
    expect(readSession(t.db, cookieValue, at(SESSION_TTL_MS))).toBeNull();
  });

  it("sign-out ends the session, and a disabled person's session stops working", () => {
    const t = testStore();
    const a = startSession(t.db, { orgId: t.orgId, userId: t.ownerId, method: "passkey", now: T0 });
    const b = startSession(t.db, { orgId: t.orgId, userId: t.ownerId, method: "passkey", now: T0 });
    endSession(t.db, a.cookieValue, T0);
    expect(readSession(t.db, a.cookieValue, T0)).toBeNull();
    expect(readSession(t.db, b.cookieValue, T0)).not.toBeNull();

    t.db.update(users).set({ disabledAt: T0 }).where(eq(users.id, t.ownerId)).run();
    expect(readSession(t.db, b.cookieValue, T0)).toBeNull();
  });

  it("an unknown cookie reads as no session", () => {
    const t = testStore();
    expect(readSession(t.db, "not-a-session", T0)).toBeNull();
  });

  it("uses a __Host- cookie on https and compares CSRF tokens exactly", () => {
    expect(sessionCookieName(new URL("https://heel.example.com"))).toBe("__Host-heel_session");
    expect(sessionCookieName(new URL("http://localhost:7301"))).toBe("heel_session");
    expect(csrfMatches("abc", "abc")).toBe(true);
    expect(csrfMatches("abc", "abd")).toBe(false);
    expect(csrfMatches("abc", "ab")).toBe(false);
    expect(csrfMatches("abc", undefined)).toBe(false);
  });
});
