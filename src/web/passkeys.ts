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
import { type ChallengePurpose, enrollments, passkeys, users } from "../store/schema.ts";
import {
  type ChallengeBinding,
  type ChallengeRow,
  claimChallenge,
  issueChallenge,
} from "./challenges.ts";

/** How long a `heel user enroll` link stays valid (Q-N2). */
export const ENROLLMENT_TTL_MS = 15 * 60_000;

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
 * `heel user enroll <user>` (Q-N2): a one-time link, valid 15 minutes, that
 * adds a passkey for that user. The same command adds a device or recovers a
 * lost passkey. It runs only over the admin socket; no agent-plane or
 * human-plane route creates one (I-58).
 */
export function createEnrollment(
  db: HeelDb,
  input: { orgId: string; userName: string; publicUrl: URL; now: Date },
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
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(input.now.getTime() + ENROLLMENT_TTL_MS);
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
      })
      .run();
  });
  return { url: new URL(enrollmentPath(token), input.publicUrl).href, expiresAt };
}

export interface OpenEnrollment {
  id: string;
  orgId: string;
  userId: string;
  userName: string;
  expiresAt: Date;
}

/** The unused, unexpired enrollment a link token names; null otherwise. */
export function findEnrollment(db: HeelDb, token: string, now: Date): OpenEnrollment | null {
  const row = db
    .select({
      id: enrollments.id,
      orgId: enrollments.orgId,
      userId: enrollments.userId,
      userName: users.name,
      expiresAt: enrollments.expiresAt,
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
  };
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
  | "already_enrolled";

export type OptionsResult<T> =
  | { ok: true; challengeId: string; options: T }
  | { ok: false; reason: PasskeyRefusal };

export interface AssertionRequest {
  orgId: string;
  /** The signed-in person who must answer; null for sign-in. */
  userId: string | null;
  purpose: Exclude<ChallengePurpose, "enroll">;
  binding: ChallengeBinding;
  now: Date;
}

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
    return {
      ok: true,
      challengeId: row.id,
      options: await this.#requestOptions(Buffer.from(row.challenge, "base64url"), []),
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
      // Sign-in names no credential: the authenticator offers its discoverable passkeys.
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
  async verifyAssertion(input: {
    orgId: string;
    challengeId: string;
    purpose: Exclude<ChallengePurpose, "enroll">;
    userId: string | null;
    response: unknown;
    now: Date;
  }): Promise<
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
    this.#db
      .update(passkeys)
      .set({ counter: verified.authenticationInfo.newCounter, lastUsedAt: input.now })
      .where(eq(passkeys.id, passkey.id))
      .run();
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
            createdAt: input.now,
          })
          .run();
        return { ok: true, userId: enrollment.userId, passkeyId: credential.id };
      },
      { behavior: "immediate" },
    );
  }
}
