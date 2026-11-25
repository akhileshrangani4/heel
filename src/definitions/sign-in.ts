import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { HeelDb } from "../store/db.ts";
import type { AccountRecord } from "../store/directory.ts";
import { accounts } from "../store/schema.ts";
import type { OAuthTokens } from "../vault/refresh.ts";
import type { Vault } from "../vault/vault.ts";
import type { PendingSignIn, UpstreamSignIns } from "./mcp/upstream-oauth.ts";

/**
 * Signing a built-in mail account in from the Connections page: Gmail with
 * Google, Outlook with Microsoft. Each provider supplies the
 * three steps that differ; the flow around them is the same.
 *
 * - The sign-in state is bound to the person who started it and works once.
 * - PKCE (S256) protects the code exchange.
 * - The first sign-in records the mailbox's address in the account's
 *   settings. Signing in again must land on the same mailbox: an account
 *   names exactly one mailbox, and rules written for `gmail-work` must never
 *   start applying to another one (I-74).
 */

export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Why heel refused a finished sign-in; the message is safe to show the person. */
export class SignInError extends Error {
  override readonly name = "SignInError";
}

/** One provider's part of signing in. */
export interface ProviderSignIn {
  /** Who to name in messages, e.g. "Google". */
  label: string;
  /** Where the provider sends the person back. */
  callbackPath: string;
  /** The OAuth client this signs in with, stored with the tokens so they refresh with it. */
  clientId: string;
  /**
   * Set for a client that sends people back to a loopback address on heel's
   * host (heel's built-in Google client): each sign-in gets its own, which
   * the caller passes to `authorizeUrl` and `exchange` alike.
   */
  loopback?: true;
  authorizeUrl(input: { state: string; challenge: string; redirectUri?: string }): URL;
  /** Exchanges the code; throws `SignInError` for a sign-in heel refuses. */
  exchange(input: { code: string; verifier: string; redirectUri?: string }): Promise<OAuthTokens>;
  /** The mailbox the access token opens, lower-cased. */
  mailbox(accessToken: string, signal: AbortSignal): Promise<string>;
}

/** A PKCE verifier and its S256 challenge (RFC 7636). */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Pure: the granted scopes, from a token response's space-separated `scope`. */
export function grantedScopes(scope: string | undefined): Set<string> {
  return new Set((scope ?? "").split(" ").filter((s) => s !== ""));
}

/** What a built-in mail account stores in `settings`. */
const MailboxSettingsSchema = z.object({ mailbox: z.string().min(1) });
export type MailboxSettings = z.output<typeof MailboxSettingsSchema>;

/** The account's mailbox, or null before its first sign-in. */
export function mailboxSettings(settings: Record<string, unknown>): MailboxSettings | null {
  const parsed = MailboxSettingsSchema.safeParse(settings);
  return parsed.success ? parsed.data : null;
}

/** Opens a sign-in and returns the provider's URL to send the person's browser to. */
export function startSignIn(
  deps: { signIns: UpstreamSignIns; now: () => Date },
  provider: ProviderSignIn,
  account: AccountRecord,
  userId: string,
  /** A loopback provider's redirect for this sign-in; the exchange reuses it. */
  redirectUri?: string,
): { url: URL; state: string } {
  const state = deps.signIns.open(
    { accountId: account.id, userId, ...(redirectUri === undefined ? {} : { redirectUri }) },
    deps.now(),
  );
  const pending = deps.signIns.get(state, deps.now());
  if (pending === null) throw new Error("the sign-in expired before it started");
  const { verifier, challenge } = pkcePair();
  pending.verifier = verifier;
  return {
    url: provider.authorizeUrl({
      state,
      challenge,
      ...(redirectUri === undefined ? {} : { redirectUri }),
    }),
    state,
  };
}

/**
 * Finishes a sign-in: exchanges the code, reads which mailbox it opened, and
 * stores the tokens. Throws `SignInError` with a message for the person.
 */
export async function finishSignIn(
  deps: { db: HeelDb; vault: Vault },
  provider: ProviderSignIn,
  pending: PendingSignIn,
  callback: URLSearchParams,
): Promise<{ mailbox: string }> {
  const code = callback.get("code");
  if (code === null) throw new SignInError("No code came back; the sign-in was cancelled.");
  const tokens = await provider.exchange({
    code,
    verifier: pending.verifier,
    ...(pending.redirectUri === undefined ? {} : { redirectUri: pending.redirectUri }),
  });
  if (tokens.refreshToken === undefined) {
    throw new SignInError(
      `${provider.label} sent no refresh token. Remove heel's access and try again.`,
    );
  }
  const mailbox = await provider.mailbox(tokens.accessToken, AbortSignal.timeout(10_000));

  const row = deps.db
    .select({ settings: accounts.settings })
    .from(accounts)
    .where(eq(accounts.id, pending.accountId))
    .get();
  if (row === undefined) throw new SignInError("The account was removed.");
  const previous = mailboxSettings(row.settings);
  if (previous !== null && previous.mailbox !== mailbox) {
    throw new SignInError(
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
    refreshToken: tokens.refreshToken,
    ...(tokens.expiresAt === undefined ? {} : { expiresAt: tokens.expiresAt }),
    ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
    clientId: provider.clientId,
  });
  return { mailbox };
}
