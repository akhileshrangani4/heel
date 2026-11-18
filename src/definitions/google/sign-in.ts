import { eq } from "drizzle-orm";
import { z } from "zod";
import type { HeelDb } from "../../store/db.ts";
import type { AccountRecord } from "../../store/directory.ts";
import { accounts } from "../../store/schema.ts";
import type { Vault } from "../../vault/vault.ts";
import type { PendingSignIn, UpstreamSignIns } from "../mcp/upstream-oauth.ts";
import {
  exchangeGoogleCode,
  type FetchFn,
  type GoogleClient,
  GoogleSignInError,
  gmailMailbox,
  googleAuthorizeUrl,
  pkcePair,
} from "./oauth.ts";

/**
 * Signing a Gmail account in from the Connections page (D9a-1).
 *
 * The first sign-in records the mailbox's address in the account's settings.
 * Signing in again must land on the same mailbox: an account names exactly
 * one mailbox, and rules written for `gmail-work` must never start applying
 * to another one (I-74).
 */

/** What a Gmail account stores in `settings`. */
const GmailSettingsSchema = z.object({ mailbox: z.string().min(1) });
export type GmailSettings = z.output<typeof GmailSettingsSchema>;

/** The account's mailbox, or null before its first sign-in. */
export function gmailSettings(settings: Record<string, unknown>): GmailSettings | null {
  const parsed = GmailSettingsSchema.safeParse(settings);
  return parsed.success ? parsed.data : null;
}

export interface GoogleSignInDeps {
  db: HeelDb;
  vault: Vault;
  client: GoogleClient;
  signIns: UpstreamSignIns;
  fetch: FetchFn;
  now: () => Date;
}

/** Opens a sign-in and returns the Google URL to send the person's browser to. */
export function startGoogleSignIn(
  deps: GoogleSignInDeps,
  account: AccountRecord,
  userId: string,
): URL {
  const state = deps.signIns.open({ accountId: account.id, userId }, deps.now());
  const pending = deps.signIns.get(state, deps.now());
  if (pending === null) throw new Error("the sign-in expired before it started");
  const { verifier, challenge } = pkcePair();
  pending.verifier = verifier;
  return googleAuthorizeUrl(deps.client, { state, challenge });
}

/**
 * Finishes a sign-in: exchanges the code, reads which mailbox it opened, and
 * stores the tokens. Throws `GoogleSignInError` with a message for the person.
 */
export async function finishGoogleSignIn(
  deps: GoogleSignInDeps,
  pending: PendingSignIn,
  callback: URLSearchParams,
): Promise<{ mailbox: string }> {
  const code = callback.get("code");
  if (code === null) throw new GoogleSignInError("Google sent no code; the sign-in was cancelled.");
  const tokens = await exchangeGoogleCode(deps, deps.client, {
    code,
    verifier: pending.verifier,
  });
  const mailbox = await gmailMailbox(deps.fetch, tokens.accessToken, AbortSignal.timeout(10_000));

  const row = deps.db
    .select({ settings: accounts.settings })
    .from(accounts)
    .where(eq(accounts.id, pending.accountId))
    .get();
  if (row === undefined) throw new GoogleSignInError("The account was removed.");
  const previous = gmailSettings(row.settings);
  if (previous !== null && previous.mailbox !== mailbox) {
    throw new GoogleSignInError(
      `This account is ${previous.mailbox}; you signed in as ${mailbox}. Connect a new account for it.`,
    );
  }
  if (previous === null) {
    deps.db
      .update(accounts)
      .set({ settings: { mailbox } })
      .where(eq(accounts.id, pending.accountId))
      .run();
  }
  deps.vault.put(pending.accountId, {
    type: "oauth",
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken === undefined ? {} : { refreshToken: tokens.refreshToken }),
    ...(tokens.expiresAt === undefined ? {} : { expiresAt: tokens.expiresAt }),
    ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
  });
  return { mailbox };
}
