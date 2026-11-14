import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { newId } from "../../src/store/ids.ts";
import { passkeys, users, webauthnChallenges } from "../../src/store/schema.ts";
import { CHALLENGE_TTL_MS, deriveChallenge } from "../../src/web/challenges.ts";
import {
  createEnrollment,
  ENROLLMENT_TTL_MS,
  EnrollmentError,
  Passkeys,
  relyingPartyFor,
} from "../../src/web/passkeys.ts";
import { SoftAuthenticator } from "../helpers/authenticator.ts";
import { type TestStore, testStore } from "../helpers/store.ts";

const PUBLIC_URL = new URL("https://heel.example.com");
const ORIGIN = PUBLIC_URL.origin;
const T0 = new Date("2026-11-14T10:00:00Z");
const at = (ms: number): Date => new Date(T0.getTime() + ms);

function tokenOf(url: string): string {
  const token = new URL(url).pathname.split("/").at(-1);
  if (token === undefined || token === "") throw new Error(`no token in ${url}`);
  return token;
}

/** Enrolls a fresh authenticator for `userName` through the one-time link. */
async function enroll(
  t: TestStore,
  pk: Passkeys,
  userName = "owner",
  now = T0,
): Promise<SoftAuthenticator> {
  const link = createEnrollment(t.db, { orgId: t.orgId, userName, publicUrl: PUBLIC_URL, now });
  const token = tokenOf(link.url);
  const options = await pk.registrationOptions({ token, now });
  if (!options.ok) throw new Error(`registration options refused: ${options.reason}`);
  const authenticator = new SoftAuthenticator();
  const finished = await pk.finishRegistration({
    token,
    challengeId: options.challengeId,
    response: authenticator.register(options.options, ORIGIN),
    now,
  });
  if (!finished.ok) throw new Error(`registration refused: ${finished.reason}`);
  return authenticator;
}

function addUser(t: TestStore, name: string): string {
  const id = newId("user");
  t.db.insert(users).values({ id, orgId: t.orgId, name, role: "member", createdAt: T0 }).run();
  return id;
}

const DECISION = { intent: "approve-once", approvalId: "apr_1", callHash: "a".repeat(64) };

describe("passkey enrollment (Q-N2)", () => {
  it("I-58: a one-time admin-socket link enrolls a passkey, and the link can't be reused", async () => {
    const t = testStore();
    const pk = new Passkeys(t.db, relyingPartyFor(PUBLIC_URL));
    const link = createEnrollment(t.db, {
      orgId: t.orgId,
      userName: "owner",
      publicUrl: PUBLIC_URL,
      now: T0,
    });
    expect(link.url).toMatch(/^https:\/\/heel\.example\.com\/enroll\/[A-Za-z0-9_-]{43}$/);
    expect(link.expiresAt).toEqual(at(ENROLLMENT_TTL_MS));

    const token = tokenOf(link.url);
    const options = await pk.registrationOptions({ token, now: T0 });
    if (!options.ok) throw new Error(options.reason);
    expect(options.options.rp).toEqual({ id: "heel.example.com", name: "heel" });
    expect(options.options.authenticatorSelection).toMatchObject({
      residentKey: "required",
      userVerification: "required",
    });
    const authenticator = new SoftAuthenticator();
    const done = await pk.finishRegistration({
      token,
      challengeId: options.challengeId,
      response: authenticator.register(options.options, ORIGIN),
      now: T0,
    });
    expect(done).toEqual({ ok: true, userId: t.ownerId, passkeyId: authenticator.id });

    const stored = t.db.select().from(passkeys).all();
    expect(stored.map((p) => [p.id, p.userId])).toEqual([[authenticator.id, t.ownerId]]);
    // Only the token's hash is stored; the link is spent.
    expect(await pk.registrationOptions({ token, now: T0 })).toEqual({
      ok: false,
      reason: "enrollment_invalid",
    });
  });

  it("refuses an expired enrollment link", async () => {
    const t = testStore();
    const pk = new Passkeys(t.db, relyingPartyFor(PUBLIC_URL));
    const link = createEnrollment(t.db, {
      orgId: t.orgId,
      userName: "owner",
      publicUrl: PUBLIC_URL,
      now: T0,
    });
    expect(
      await pk.registrationOptions({ token: tokenOf(link.url), now: at(ENROLLMENT_TTL_MS) }),
    ).toEqual({ ok: false, reason: "enrollment_invalid" });
  });

  it("a new link replaces the user's older one (recovery and new devices)", async () => {
    const t = testStore();
    const pk = new Passkeys(t.db, relyingPartyFor(PUBLIC_URL));
    const first = createEnrollment(t.db, {
      orgId: t.orgId,
      userName: "owner",
      publicUrl: PUBLIC_URL,
      now: T0,
    });
    await enroll(t, pk);
    expect(await pk.registrationOptions({ token: tokenOf(first.url), now: T0 })).toEqual({
      ok: false,
      reason: "enrollment_invalid",
    });
    // A second device for the same person.
    await enroll(t, pk);
    expect(t.db.select().from(passkeys).all()).toHaveLength(2);
  });

  it("names unknown and disabled users", () => {
    const t = testStore();
    const input = { orgId: t.orgId, publicUrl: PUBLIC_URL, now: T0 };
    expect(() => createEnrollment(t.db, { ...input, userName: "nobody" })).toThrow(EnrollmentError);
    const id = addUser(t, "gone");
    t.db.update(users).set({ disabledAt: T0 }).where(eq(users.id, id)).run();
    expect(() => createEnrollment(t.db, { ...input, userName: "gone" })).toThrow(/disabled/);
  });

  it("refuses a registration made for another origin", async () => {
    const t = testStore();
    const pk = new Passkeys(t.db, relyingPartyFor(PUBLIC_URL));
    const link = createEnrollment(t.db, {
      orgId: t.orgId,
      userName: "owner",
      publicUrl: PUBLIC_URL,
      now: T0,
    });
    const token = tokenOf(link.url);
    const options = await pk.registrationOptions({ token, now: T0 });
    if (!options.ok) throw new Error(options.reason);
    const result = await pk.finishRegistration({
      token,
      challengeId: options.challengeId,
      response: new SoftAuthenticator().register(options.options, "https://evil.example.com"),
      now: T0,
    });
    expect(result).toMatchObject({ ok: false, reason: "invalid_assertion" });
    expect(t.db.select().from(passkeys).all()).toEqual([]);
  });
});

describe("passkey assertions", () => {
  it("I-56: a decision challenge commits to its binding: changing the call hash changes the bytes", () => {
    const nonce = new Uint8Array(32);
    const base = deriveChallenge(nonce, "decide", DECISION);
    expect(deriveChallenge(nonce, "decide", { ...DECISION })).toEqual(base);
    expect(deriveChallenge(nonce, "decide", { ...DECISION, callHash: "b".repeat(64) })).not.toEqual(
      base,
    );
    expect(deriveChallenge(nonce, "decide", { ...DECISION, intent: "deny" })).not.toEqual(base);
    expect(deriveChallenge(nonce, "resume", DECISION)).not.toEqual(base);
  });

  it("I-56: a fresh, user-verified assertion returns the binding the challenge was issued for", async () => {
    const t = testStore();
    const pk = new Passkeys(t.db, relyingPartyFor(PUBLIC_URL));
    const authenticator = await enroll(t, pk);
    const options = await pk.assertionOptions({
      orgId: t.orgId,
      userId: t.ownerId,
      purpose: "decide",
      binding: DECISION,
      now: T0,
    });
    if (!options.ok) throw new Error(options.reason);
    expect(options.options.userVerification).toBe("required");
    expect(options.options.allowCredentials?.map((c) => c.id)).toEqual([authenticator.id]);

    const verified = await pk.verifyAssertion({
      orgId: t.orgId,
      challengeId: options.challengeId,
      purpose: "decide",
      userId: t.ownerId,
      response: authenticator.assert(options.options, ORIGIN),
      now: T0,
    });
    expect(verified).toEqual({
      ok: true,
      userId: t.ownerId,
      passkeyId: authenticator.id,
      binding: DECISION,
    });
  });

  it("I-56: an assertion signed for one decision can't answer another decision's challenge", async () => {
    const t = testStore();
    const pk = new Passkeys(t.db, relyingPartyFor(PUBLIC_URL));
    const authenticator = await enroll(t, pk);
    const issue = (binding: Record<string, string>) =>
      pk.assertionOptions({
        orgId: t.orgId,
        userId: t.ownerId,
        purpose: "decide",
        binding,
        now: T0,
      });
    const approveA = await issue(DECISION);
    const approveB = await issue({ ...DECISION, approvalId: "apr_2", callHash: "b".repeat(64) });
    if (!approveA.ok || !approveB.ok) throw new Error("options refused");

    // Signed over A's challenge, presented as the answer to B.
    const result = await pk.verifyAssertion({
      orgId: t.orgId,
      challengeId: approveB.challengeId,
      purpose: "decide",
      userId: t.ownerId,
      response: authenticator.assert(approveA.options, ORIGIN),
      now: T0,
    });
    expect(result).toMatchObject({ ok: false, reason: "invalid_assertion" });
  });

  it("I-56: each challenge answers once; a replayed assertion is refused", async () => {
    const t = testStore();
    const pk = new Passkeys(t.db, relyingPartyFor(PUBLIC_URL));
    const authenticator = await enroll(t, pk);
    const options = await pk.assertionOptions({
      orgId: t.orgId,
      userId: t.ownerId,
      purpose: "decide",
      binding: DECISION,
      now: T0,
    });
    if (!options.ok) throw new Error(options.reason);
    const response = authenticator.assert(options.options, ORIGIN);
    const input = {
      orgId: t.orgId,
      challengeId: options.challengeId,
      purpose: "decide" as const,
      userId: t.ownerId,
      response,
      now: T0,
    };
    expect(await pk.verifyAssertion(input)).toMatchObject({ ok: true });
    expect(await pk.verifyAssertion(input)).toEqual({ ok: false, reason: "challenge_used" });
  });

  it("I-56: a failed attempt burns the challenge, so it can't be retried", async () => {
    const t = testStore();
    const pk = new Passkeys(t.db, relyingPartyFor(PUBLIC_URL));
    const authenticator = await enroll(t, pk);
    const options = await pk.assertionOptions({
      orgId: t.orgId,
      userId: t.ownerId,
      purpose: "decide",
      binding: DECISION,
      now: T0,
    });
    if (!options.ok) throw new Error(options.reason);
    const base = {
      orgId: t.orgId,
      challengeId: options.challengeId,
      purpose: "decide" as const,
      userId: t.ownerId,
      now: T0,
    };
    expect(await pk.verifyAssertion({ ...base, response: { not: "an assertion" } })).toEqual({
      ok: false,
      reason: "malformed_response",
    });
    expect(
      await pk.verifyAssertion({
        ...base,
        response: authenticator.assert(options.options, ORIGIN),
      }),
    ).toEqual({ ok: false, reason: "challenge_used" });
  });

  it("I-56: refuses an assertion without user verification", async () => {
    const t = testStore();
    const pk = new Passkeys(t.db, relyingPartyFor(PUBLIC_URL));
    const authenticator = await enroll(t, pk);
    const options = await pk.assertionOptions({
      orgId: t.orgId,
      userId: t.ownerId,
      purpose: "resume",
      binding: { scope: "agent", target: "inbox-bot" },
      now: T0,
    });
    if (!options.ok) throw new Error(options.reason);
    const result = await pk.verifyAssertion({
      orgId: t.orgId,
      challengeId: options.challengeId,
      purpose: "resume",
      userId: t.ownerId,
      response: authenticator.assert(options.options, ORIGIN, { userVerified: false }),
      now: T0,
    });
    expect(result).toMatchObject({ ok: false, reason: "invalid_assertion" });
  });

  it("I-56: refuses an assertion made for another origin", async () => {
    const t = testStore();
    const pk = new Passkeys(t.db, relyingPartyFor(PUBLIC_URL));
    const authenticator = await enroll(t, pk);
    const options = await pk.assertionOptions({
      orgId: t.orgId,
      userId: t.ownerId,
      purpose: "decide",
      binding: DECISION,
      now: T0,
    });
    if (!options.ok) throw new Error(options.reason);
    const result = await pk.verifyAssertion({
      orgId: t.orgId,
      challengeId: options.challengeId,
      purpose: "decide",
      userId: t.ownerId,
      response: authenticator.assert(options.options, "https://heel.example.com.evil.test"),
      now: T0,
    });
    expect(result).toMatchObject({ ok: false, reason: "invalid_assertion" });
  });

  it("I-56: a challenge expires after five minutes", async () => {
    const t = testStore();
    const pk = new Passkeys(t.db, relyingPartyFor(PUBLIC_URL));
    const authenticator = await enroll(t, pk);
    const options = await pk.assertionOptions({
      orgId: t.orgId,
      userId: t.ownerId,
      purpose: "decide",
      binding: DECISION,
      now: T0,
    });
    if (!options.ok) throw new Error(options.reason);
    const result = await pk.verifyAssertion({
      orgId: t.orgId,
      challengeId: options.challengeId,
      purpose: "decide",
      userId: t.ownerId,
      response: authenticator.assert(options.options, ORIGIN),
      now: at(CHALLENGE_TTL_MS),
    });
    expect(result).toEqual({ ok: false, reason: "challenge_expired" });
  });

  it("I-56: another person's passkey can't answer a challenge issued to the approver", async () => {
    const t = testStore();
    const pk = new Passkeys(t.db, relyingPartyFor(PUBLIC_URL));
    await enroll(t, pk);
    const malloryId = addUser(t, "mallory");
    const mallory = await enroll(t, pk, "mallory");
    const options = await pk.assertionOptions({
      orgId: t.orgId,
      userId: t.ownerId,
      purpose: "decide",
      binding: DECISION,
      now: T0,
    });
    if (!options.ok) throw new Error(options.reason);

    // Mallory's session can't claim the owner's challenge at all…
    expect(
      await pk.verifyAssertion({
        orgId: t.orgId,
        challengeId: options.challengeId,
        purpose: "decide",
        userId: malloryId,
        response: mallory.assert(options.options, ORIGIN),
        now: T0,
      }),
    ).toEqual({ ok: false, reason: "unknown_challenge" });
    // …and the owner's session can't answer it with Mallory's passkey.
    const again = await pk.assertionOptions({
      orgId: t.orgId,
      userId: t.ownerId,
      purpose: "decide",
      binding: DECISION,
      now: T0,
    });
    if (!again.ok) throw new Error(again.reason);
    expect(
      await pk.verifyAssertion({
        orgId: t.orgId,
        challengeId: again.challengeId,
        purpose: "decide",
        userId: t.ownerId,
        response: mallory.assert(again.options, ORIGIN),
        now: T0,
      }),
    ).toEqual({ ok: false, reason: "unknown_passkey" });
  });

  it("a challenge for one purpose can't be claimed as another", async () => {
    const t = testStore();
    const pk = new Passkeys(t.db, relyingPartyFor(PUBLIC_URL));
    const authenticator = await enroll(t, pk);
    const options = await pk.assertionOptions({
      orgId: t.orgId,
      userId: t.ownerId,
      purpose: "resume",
      binding: { scope: "global", target: "" },
      now: T0,
    });
    if (!options.ok) throw new Error(options.reason);
    expect(
      await pk.verifyAssertion({
        orgId: t.orgId,
        challengeId: options.challengeId,
        purpose: "decide",
        userId: t.ownerId,
        response: authenticator.assert(options.options, ORIGIN),
        now: T0,
      }),
    ).toEqual({ ok: false, reason: "unknown_challenge" });
  });

  it("refuses decision options for a person with no passkey", async () => {
    const t = testStore();
    const pk = new Passkeys(t.db, relyingPartyFor(PUBLIC_URL));
    expect(
      await pk.assertionOptions({
        orgId: t.orgId,
        userId: t.ownerId,
        purpose: "decide",
        binding: DECISION,
        now: T0,
      }),
    ).toEqual({ ok: false, reason: "no_passkey" });
    expect(t.db.select().from(webauthnChallenges).all()).toEqual([]);
  });

  it("sign-in accepts any enrolled passkey and names its person", async () => {
    const t = testStore();
    const pk = new Passkeys(t.db, relyingPartyFor(PUBLIC_URL));
    const authenticator = await enroll(t, pk);
    const options = await pk.assertionOptions({
      orgId: t.orgId,
      userId: null,
      purpose: "sign_in",
      binding: {},
      now: T0,
    });
    if (!options.ok) throw new Error(options.reason);
    expect(options.options.allowCredentials).toBeUndefined();
    expect(
      await pk.verifyAssertion({
        orgId: t.orgId,
        challengeId: options.challengeId,
        purpose: "sign_in",
        userId: null,
        response: authenticator.assert(options.options, ORIGIN),
        now: T0,
      }),
    ).toMatchObject({ ok: true, userId: t.ownerId });
  });

  it("a disabled person's passkey stops working", async () => {
    const t = testStore();
    const pk = new Passkeys(t.db, relyingPartyFor(PUBLIC_URL));
    const authenticator = await enroll(t, pk);
    t.db.update(users).set({ disabledAt: T0 }).where(eq(users.id, t.ownerId)).run();
    const options = await pk.assertionOptions({
      orgId: t.orgId,
      userId: null,
      purpose: "sign_in",
      binding: {},
      now: T0,
    });
    if (!options.ok) throw new Error(options.reason);
    expect(
      await pk.verifyAssertion({
        orgId: t.orgId,
        challengeId: options.challengeId,
        purpose: "sign_in",
        userId: null,
        response: authenticator.assert(options.options, ORIGIN),
        now: T0,
      }),
    ).toEqual({ ok: false, reason: "user_disabled" });
  });
});
