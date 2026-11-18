import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, lt } from "drizzle-orm";
import { canonicalJson } from "../core/canonical.ts";
import type { HeelDb } from "../store/db.ts";
import { newId } from "../store/ids.ts";
import { type ChallengePurpose, webauthnChallenges } from "../store/schema.ts";

/** How long a person has to answer the passkey prompt. */
export const CHALLENGE_TTL_MS = 5 * 60_000;

/** What an assertion authorizes, e.g. `{ intent, approvalId, callHash }`. Values are plain strings. */
export type ChallengeBinding = Readonly<Record<string, string>>;

export type ChallengeRow = typeof webauthnChallenges.$inferSelect;

/**
 * Pure: the challenge bytes an authenticator signs. They are a hash over a
 * fresh nonce and the canonical purpose and binding, so a signed assertion
 * commits to exactly the decision the person confirmed (I-56): an assertion
 * for one approval, call hash or intent can't be replayed for another.
 */
export function deriveChallenge(
  nonce: Uint8Array,
  purpose: ChallengePurpose,
  binding: ChallengeBinding,
): Buffer {
  return createHash("sha256").update(nonce).update(canonicalJson({ purpose, binding })).digest();
}

export interface IssueChallengeInput {
  orgId: string;
  /** Who must answer; null for sign-in, where the passkey names the person. */
  userId: string | null;
  purpose: ChallengePurpose;
  binding: ChallengeBinding;
  now: Date;
}

export interface IssuedChallenge {
  id: string;
  /** The raw challenge bytes, for the WebAuthn options. */
  bytes: Buffer;
  expiresAt: Date;
}

/**
 * Stores a one-time challenge. Expired rows are pruned first, so a sign-in
 * page that anyone can load can't grow the table without bound.
 */
export function issueChallenge(db: HeelDb, input: IssueChallengeInput): IssuedChallenge {
  const bytes = deriveChallenge(randomBytes(32), input.purpose, input.binding);
  const expiresAt = new Date(input.now.getTime() + CHALLENGE_TTL_MS);
  const id = newId("challenge");
  db.transaction((tx) => {
    tx.delete(webauthnChallenges).where(lt(webauthnChallenges.expiresAt, input.now)).run();
    tx.insert(webauthnChallenges)
      .values({
        id,
        orgId: input.orgId,
        userId: input.userId,
        purpose: input.purpose,
        challenge: bytes.toString("base64url"),
        binding: { ...input.binding },
        createdAt: input.now,
        expiresAt,
      })
      .run();
  });
  return { id, bytes, expiresAt };
}

/** A challenge that can still be answered, without claiming it; null otherwise. */
export function openChallenge(
  db: HeelDb,
  orgId: string,
  id: string,
  purpose: ChallengePurpose,
  now: Date,
): ChallengeRow | null {
  const row = db
    .select()
    .from(webauthnChallenges)
    .where(
      and(
        eq(webauthnChallenges.orgId, orgId),
        eq(webauthnChallenges.id, id),
        eq(webauthnChallenges.purpose, purpose),
        isNull(webauthnChallenges.usedAt),
      ),
    )
    .get();
  if (row === undefined || row.expiresAt.getTime() <= now.getTime()) return null;
  return row;
}

export type ChallengeRefusal = "unknown_challenge" | "challenge_used" | "challenge_expired";

export type ClaimResult = { ok: true; row: ChallengeRow } | { ok: false; reason: ChallengeRefusal };

export interface ClaimInput {
  orgId: string;
  id: string;
  purpose: ChallengePurpose;
  /**
   * The person answering. A challenge issued to a user can be claimed only
   * by that user; a sign-in challenge (no user) by anyone.
   */
  userId: string | null;
  now: Date;
}

/**
 * Marks a challenge used, exactly once. Every attempt burns it, before the
 * signature is checked, so a failed assertion can't be retried against the
 * same challenge and two concurrent answers can't both succeed.
 */
export function claimChallenge(db: HeelDb, input: ClaimInput): ClaimResult {
  return db.transaction(
    (tx): ClaimResult => {
      const row = tx
        .select()
        .from(webauthnChallenges)
        .where(and(eq(webauthnChallenges.orgId, input.orgId), eq(webauthnChallenges.id, input.id)))
        .get();
      // A challenge for another purpose or person reads as unknown: it isn't this caller's.
      if (row === undefined || row.purpose !== input.purpose) {
        return { ok: false, reason: "unknown_challenge" };
      }
      if (row.userId !== null && row.userId !== input.userId) {
        return { ok: false, reason: "unknown_challenge" };
      }
      if (row.usedAt !== null) return { ok: false, reason: "challenge_used" };
      const claimed = tx
        .update(webauthnChallenges)
        .set({ usedAt: input.now })
        .where(and(eq(webauthnChallenges.id, row.id), isNull(webauthnChallenges.usedAt)))
        .run();
      if (claimed.changes !== 1) return { ok: false, reason: "challenge_used" };
      if (row.expiresAt.getTime() <= input.now.getTime()) {
        return { ok: false, reason: "challenge_expired" };
      }
      return { ok: true, row: { ...row, usedAt: input.now } };
    },
    { behavior: "immediate" },
  );
}
