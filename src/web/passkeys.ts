import { createHash, randomBytes } from "node:crypto";
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import type { HeelDb } from "../store/db.ts";
import { newId } from "../store/ids.ts";
import { enrollments, passkeys, users } from "../store/schema.ts";
import {
  type ChallengeBinding,
  type ChallengeRow,
  claimChallenge,
  issueChallenge,
} from "./challenges.ts";

/** How long a `heel user enroll` link stays valid (Q-N2). */
export const ENROLLMENT_TTL_MS = 15 * 60_000;
/**
 * How long a recovery link waits before it works. A local agent can run
 * `heel user enroll` on a same-user install; the wait gives the person time
 * to see the link on the approval page and cancel it.
 */
export const RECOVERY_DELAY_MS = 24 * 60 * 60_000;
/** How long a recovery link stays usable once it starts working. */
export const RECOVERY_WINDOW_MS = 24 * 60 * 60_000;

/** The WebAuthn relying party: the human plane's public origin (spec: Listeners). */
export interface RelyingParty {
  id: string;
  origin: string;
  name: string;
}

/** Pure: the relying party for a `public_url`. Its host is the RP ID. */
export function relyingPartyFor(publicUrl: URL): RelyingParty {
  return { id: publicUrl.hostname, origin: publicUrl.origin, name: "heel" };
}

/** Pure: lower-case hex SHA-256 of an enrollment link token; only the hash is stored. */
export function hashEnrollmentToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Path of the one-time enrollment page for a token. */
export function enrollmentPath(token: string): string {
  return `/enroll/${token}`;
}

export interface Enrollment {
  url: string;
  expiresAt: Date;
  /** For a recovery link, when it starts working; null when it works at once. */
  activeFrom: Date | null;
}

export class EnrollmentError extends Error {
  override readonly name = "EnrollmentError";
  readonly code: "unknown_user" | "user_disabled";

  constructor(code: "unknown_user" | "user_disabled", message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * A one-time link that adds a passkey for a user (Q-N2), valid 15 minutes.
 *
 * - **First passkey:** `heel user enroll <user>` over the admin socket.
 * - **Another device:** from the approval page, after the person confirms with
 *   a passkey they already have (`afterPasskey`). Works at once.
 * - **Recovery:** `heel user enroll` for someone who already has a passkey.
 *   It works only after `RECOVERY_DELAY_MS`, and the approval page shows it
 *   with a way to cancel, so an agent that can run `heel` can't quietly add
 *   a passkey of its own.
 *
 * No agent-plane route creates one (I-58).
 */
export function createEnrollment(
  db: HeelDb,
  input: { orgId: string; userName: string; publicUrl: URL; now: Date; afterPasskey?: boolean },
): Enrollment {
  const user = db
    .select({ id: users.id, disabledAt: users.disabledAt })
    .from(users)
    .where(and(eq(users.orgId, input.orgId), eq(users.name, input.userName)))
    .get();
  if (user === undefined) {
    throw new EnrollmentError("unknown_user", `no user named "${input.userName}"`);
  }
  if (user.disabledAt !== null) {
    throw new EnrollmentError("user_disabled", `user "${input.userName}" is disabled`);
  }
  // Only a passkey that works at this address counts: after public_url
  // changes, the old ones can't sign in here, so enrolling isn't recovery.
  const hasPasskey =
    db
      .select({ id: passkeys.id })
      .from(passkeys)
      .where(
        and(
          eq(passkeys.userId, user.id),
          or(isNull(passkeys.rpId), eq(passkeys.rpId, relyingPartyFor(input.publicUrl).id)),
        ),
      )
      .get() !== undefined;
  const recovery = hasPasskey && input.afterPasskey !== true;
  const notBefore = recovery ? new Date(input.now.getTime() + RECOVERY_DELAY_MS) : null;
  const token = randomBytes(32).toString("base64url");
  const expiresAt =
    notBefore === null
      ? new Date(input.now.getTime() + ENROLLMENT_TTL_MS)
      : new Date(notBefore.getTime() + RECOVERY_WINDOW_MS);
  db.transaction((tx) => {
    tx.delete(enrollments)
      .where(or(lt(enrollments.expiresAt, input.now), eq(enrollments.userId, user.id)))
      .run();
    tx.insert(enrollments)
      .values({
        id: newId("enrollment"),
        orgId: input.orgId,
        userId: user.id,
        tokenHash: hashEnrollmentToken(token),
        createdAt: input.now,
        expiresAt,
        notBefore,
      })
      .run();
  });
  return {
    url: new URL(enrollmentPath(token), input.publicUrl).href,
    expiresAt,
    activeFrom: notBefore,
  };
}

export interface OpenEnrollment {
  id: string;
  orgId: string;
  userId: string;
  userName: string;
  expiresAt: Date;
  /** A recovery link that doesn't work yet: when it will. Null once it works. */
  waitingUntil: Date | null;
}

/**
 * The unused, unexpired enrollment a link token names; null otherwise. A
 * recovery link that doesn't work yet is returned with `waitingUntil` set:
 * the page says when it will, and registering refuses until then.
 */
export function findEnrollment(db: HeelDb, token: string, now: Date): OpenEnrollment | null {
  const row = db
    .select({
      id: enrollments.id,
      orgId: enrollments.orgId,
      userId: enrollments.userId,
      userName: users.name,
      expiresAt: enrollments.expiresAt,
      notBefore: enrollments.notBefore,
      disabledAt: users.disabledAt,
    })
    .from(enrollments)
    .innerJoin(users, eq(users.id, enrollments.userId))
    .where(and(eq(enrollments.tokenHash, hashEnrollmentToken(token)), isNull(enrollments.usedAt)))
    .get();
  if (row === undefined || row.disabledAt !== null) return null;
  if (row.expiresAt.getTime() <= now.getTime()) return null;
  return {
    id: row.id,
    orgId: row.orgId,
    userId: row.userId,
    userName: row.userName,
    expiresAt: row.expiresAt,
    waitingUntil:
      row.notBefore !== null && row.notBefore.getTime() > now.getTime() ? row.notBefore : null,
  };
}

/** A recovery link someone made that hasn't been used or cancelled, for the approval page. */
export interface PendingRecovery {
  id: string;
  userId: string;
  userName: string;
  createdAt: Date;
  activeFrom: Date;
}

export function pendingRecoveries(db: HeelDb, orgId: string, now: Date): PendingRecovery[] {
  return db
    .select({
      id: enrollments.id,
      userId: enrollments.userId,
      userName: users.name,
      createdAt: enrollments.createdAt,
      activeFrom: enrollments.notBefore,
      expiresAt: enrollments.expiresAt,
    })
    .from(enrollments)
    .innerJoin(users, eq(users.id, enrollments.userId))
    .where(and(eq(enrollments.orgId, orgId), isNull(enrollments.usedAt)))
    .all()
    .flatMap((row) =>
      row.activeFrom === null || row.expiresAt.getTime() <= now.getTime()
        ? []
        : [{ ...row, activeFrom: row.activeFrom }],
    );
}

/** Cancels an unused enrollment link. True when one was cancelled. */
export function cancelEnrollment(db: HeelDb, orgId: string, id: string): boolean {
  return (
    db
      .delete(enrollments)
      .where(and(eq(enrollments.orgId, orgId), eq(enrollments.id, id), isNull(enrollments.usedAt)))
      .run().changes === 1
  );
}

/** True once anyone in the org has a passkey; the sign-in page says how to enroll otherwise. */
export function anyPasskeyEnrolled(db: HeelDb, orgId: string): boolean {
  return (
    db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.orgId, orgId)).get() !==
    undefined
  );
}

// ── response shapes ─────────────────────────────────────────────────────────

const base64url = z.string().regex(/^[A-Za-z0-9_-]*$/, "expected base64url");
const transports = z.array(z.string()).exactOptional();

/** The browser's assertion, as `PublicKeyCredential.toJSON()` (or our page script) sends it. */
const AuthenticationResponseSchema = z.object({
  id: base64url,
  rawId: base64url,
  type: z.literal("public-key"),
  response: z.object({
    clientDataJSON: base64url,
    authenticatorData: base64url,
    signature: base64url,
    userHandle: base64url.exactOptional(),
  }),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).exactOptional(),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
});

const RegistrationResponseSchema = z.object({
  id: base64url,
  rawId: base64url,
  type: z.literal("public-key"),
  response: z.object({
    clientDataJSON: base64url,
    attestationObject: base64url,
    transports,
  }),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).exactOptional(),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
});

// ── ceremonies ──────────────────────────────────────────────────────────────

export type PasskeyRefusal =
  | "unknown_challenge"
  | "challenge_used"
  | "challenge_expired"
  | "malformed_response"
  | "unknown_passkey"
  | "user_disabled"
  | "invalid_assertion"
  | "no_passkey"
  | "enrollment_invalid"
  | "enrollment_waiting"
  | "already_enrolled";

export type OptionsResult<T> =
  | { ok: true; challengeId: string; options: T }
  | { ok: false; reason: PasskeyRefusal };

/**
 * Who must answer an assertion. Sign-in names nobody (the passkey names the
 * person); a decision or a resume always names the signed-in person, so no
 * other passkey in the org can answer it.
 */
export type AssertionSubject =
  | { purpose: "sign_in"; userId: null }
  | {
      purpose: "decide" | "resume" | "connect" | "mode" | "grant" | "add_device" | "rules";
      userId: string;
    };

export type AssertionRequest = AssertionSubject & {
  orgId: string;
  binding: ChallengeBinding;
  now: Date;
};

/**
 * WebAuthn ceremonies for the human plane (spec: The approval page). Every
 * decision needs a fresh assertion with user verification whose challenge
 * is bound to what is being decided (I-56); see `deriveChallenge`.
 */
export class Passkeys {
  readonly #db: HeelDb;
  readonly #rp: RelyingParty;

  constructor(db: HeelDb, rp: RelyingParty) {
    this.#db = db;
    this.#rp = rp;
  }

  get relyingParty(): RelyingParty {
    return this.#rp;
  }

  #userPasskeys(orgId: string, userId: string) {
    return this.#db
      .select({ id: passkeys.id, transports: passkeys.transports })
      .from(passkeys)
      .where(and(eq(passkeys.orgId, orgId), eq(passkeys.userId, userId)))
      .all();
  }

  /** Issues a bound challenge and the options the page passes to `navigator.credentials.get`. */
  async assertionOptions(
    request: AssertionRequest,
  ): Promise<OptionsResult<PublicKeyCredentialRequestOptionsJSON>> {
    const allow = request.userId === null ? [] : this.#userPasskeys(request.orgId, request.userId);
    if (request.userId !== null && allow.length === 0) return { ok: false, reason: "no_passkey" };
    const issued = issueChallenge(this.#db, request);
    return {
      ok: true,
      challengeId: issued.id,
      options: await this.#requestOptions(issued.bytes, allow),
    };
  }

  /** Options for an open sign-in challenge the page was rendered with (see `openChallenge`). */
  async signInOptions(
    row: ChallengeRow,
  ): Promise<OptionsResult<PublicKeyCredentialRequestOptionsJSON>> {
    // Name this heel's own passkeys. Every heel on one machine shares the RP
    // ID `localhost`, so with none named the browser also offers passkeys made
    // for another heel, which this one would refuse. Their ids aren't secret:
    // heel accepts no other passkeys anyway.
    const own = this.#db
      .select({ id: passkeys.id, transports: passkeys.transports })
      .from(passkeys)
      .where(eq(passkeys.orgId, row.orgId))
      .all();
    return {
      ok: true,
      challengeId: row.id,
      options: await this.#requestOptions(Buffer.from(row.challenge, "base64url"), own),
    };
  }

  async #requestOptions(
    challenge: Buffer,
    allow: readonly { id: string; transports: string[] }[],
  ): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const options = await generateAuthenticationOptions({
      rpID: this.#rp.id,
      challenge: new Uint8Array(challenge),
      userVerification: "required",
      timeout: 120_000,
      ...(allow.length === 0
        ? {}
        : { allowCredentials: allow.map((p) => ({ id: p.id, transports: p.transports })) }),
    });
    if (options.challenge !== challenge.toString("base64url")) {
      throw new Error("WebAuthn options do not carry the issued challenge");
    }
    return options;
  }

  /**
   * Checks an assertion against its challenge. The challenge is burned first
   * (one attempt each), then the passkey must belong to the person it was
   * issued to, the signature must verify for this origin and RP ID, and the
   * authenticator must report user verification.
   */
  async verifyAssertion(
    input: AssertionSubject & {
      orgId: string;
      challengeId: string;
      response: unknown;
      now: Date;
    },
  ): Promise<
    | { ok: true; userId: string; passkeyId: string; binding: ChallengeBinding }
    | { ok: false; reason: PasskeyRefusal; detail?: string }
  > {
    const claimed = claimChallenge(this.#db, {
      orgId: input.orgId,
      id: input.challengeId,
      purpose: input.purpose,
      userId: input.userId,
      now: input.now,
    });
    if (!claimed.ok) return claimed;
    const parsed = AuthenticationResponseSchema.safeParse(input.response);
    if (!parsed.success) return { ok: false, reason: "malformed_response" };
    const response: AuthenticationResponseJSON = parsed.data;

    const passkey = this.#db
      .select({
        id: passkeys.id,
        userId: passkeys.userId,
        publicKey: passkeys.publicKey,
        counter: passkeys.counter,
        transports: passkeys.transports,
        disabledAt: users.disabledAt,
      })
      .from(passkeys)
      .innerJoin(users, eq(users.id, passkeys.userId))
      .where(and(eq(passkeys.orgId, input.orgId), eq(passkeys.id, response.id)))
      .get();
    if (passkey === undefined) return { ok: false, reason: "unknown_passkey" };
    // A decision challenge names its person: another person's passkey can't answer it.
    if (claimed.row.userId !== null && passkey.userId !== claimed.row.userId) {
      return { ok: false, reason: "unknown_passkey" };
    }
    if (passkey.disabledAt !== null) return { ok: false, reason: "user_disabled" };

    let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verified = await verifyAuthenticationResponse({
        response,
        expectedChallenge: claimed.row.challenge,
        expectedOrigin: this.#rp.origin,
        expectedRPID: this.#rp.id,
        credential: {
          id: passkey.id,
          publicKey: new Uint8Array(passkey.publicKey),
          counter: passkey.counter,
          transports: passkey.transports,
        },
        requireUserVerification: true,
      });
    } catch (error) {
      return {
        ok: false,
        reason: "invalid_assertion",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (!verified.verified || !verified.authenticationInfo.userVerified) {
      return { ok: false, reason: "invalid_assertion" };
    }
    // Compare-and-set on the counter: of two assertions verified against the
    // same stored counter (a cloned authenticator), only one is accepted.
    const updated = this.#db
      .update(passkeys)
      .set({ counter: verified.authenticationInfo.newCounter, lastUsedAt: input.now })
      .where(and(eq(passkeys.id, passkey.id), eq(passkeys.counter, passkey.counter)))
      .run();
    if (updated.changes !== 1) return { ok: false, reason: "invalid_assertion" };
    return {
      ok: true,
      userId: passkey.userId,
      passkeyId: passkey.id,
      binding: claimed.row.binding,
    };
  }

  /** Options for `navigator.credentials.create` on the enrollment page. */
  async registrationOptions(input: {
    token: string;
    now: Date;
  }): Promise<OptionsResult<PublicKeyCredentialCreationOptionsJSON>> {
    const enrollment = findEnrollment(this.#db, input.token, input.now);
    if (enrollment === null) return { ok: false, reason: "enrollment_invalid" };
    if (enrollment.waitingUntil !== null) return { ok: false, reason: "enrollment_waiting" };
    const issued = issueChallenge(this.#db, {
      orgId: enrollment.orgId,
      userId: enrollment.userId,
      purpose: "enroll",
      binding: { enrollmentId: enrollment.id },
      now: input.now,
    });
    const options = await generateRegistrationOptions({
      rpName: this.#rp.name,
      rpID: this.#rp.id,
      userName: enrollment.userName,
      userID: new TextEncoder().encode(enrollment.userId),
      challenge: new Uint8Array(issued.bytes),
      attestationType: "none",
      timeout: 120_000,
      excludeCredentials: this.#userPasskeys(enrollment.orgId, enrollment.userId).map((p) => ({
        id: p.id,
        transports: p.transports,
      })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    return { ok: true, challengeId: issued.id, options };
  }

  /** Verifies the new credential, stores it and uses up the enrollment link. */
  async finishRegistration(input: {
    token: string;
    challengeId: string;
    response: unknown;
    now: Date;
  }): Promise<
    | { ok: true; userId: string; passkeyId: string }
    | { ok: false; reason: PasskeyRefusal; detail?: string }
  > {
    const enrollment = findEnrollment(this.#db, input.token, input.now);
    if (enrollment === null) return { ok: false, reason: "enrollment_invalid" };
    if (enrollment.waitingUntil !== null) return { ok: false, reason: "enrollment_waiting" };
    const claimed = claimChallenge(this.#db, {
      orgId: enrollment.orgId,
      id: input.challengeId,
      purpose: "enroll",
      userId: enrollment.userId,
      now: input.now,
    });
    if (!claimed.ok) return claimed;
    if (claimed.row.binding["enrollmentId"] !== enrollment.id) {
      return { ok: false, reason: "unknown_challenge" };
    }
    const parsed = RegistrationResponseSchema.safeParse(input.response);
    if (!parsed.success) return { ok: false, reason: "malformed_response" };
    const response: RegistrationResponseJSON = parsed.data;

    let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verified = await verifyRegistrationResponse({
        response,
        expectedChallenge: claimed.row.challenge,
        expectedOrigin: this.#rp.origin,
        expectedRPID: this.#rp.id,
        requireUserVerification: true,
      });
    } catch (error) {
      return {
        ok: false,
        reason: "invalid_assertion",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (!verified.verified || !verified.registrationInfo.userVerified) {
      return { ok: false, reason: "invalid_assertion" };
    }
    const credential = verified.registrationInfo.credential;
    return this.#db.transaction(
      (
        tx,
      ):
        | { ok: true; userId: string; passkeyId: string }
        | { ok: false; reason: PasskeyRefusal } => {
        // Checked before the link is used up, so a duplicate leaves the link usable.
        const existing = tx
          .select({ id: passkeys.id })
          .from(passkeys)
          .where(eq(passkeys.id, credential.id))
          .get();
        if (existing !== undefined) return { ok: false, reason: "already_enrolled" };
        const used = tx
          .update(enrollments)
          .set({ usedAt: input.now })
          .where(and(eq(enrollments.id, enrollment.id), isNull(enrollments.usedAt)))
          .run();
        if (used.changes !== 1) return { ok: false, reason: "enrollment_invalid" };
        tx.insert(passkeys)
          .values({
            id: credential.id,
            orgId: enrollment.orgId,
            userId: enrollment.userId,
            publicKey: Buffer.from(credential.publicKey),
            counter: credential.counter,
            transports: credential.transports ?? [],
            rpId: this.#rp.id,
            createdAt: input.now,
          })
          .run();
        return { ok: true, userId: enrollment.userId, passkeyId: credential.id };
      },
      { behavior: "immediate" },
    );
  }
}
