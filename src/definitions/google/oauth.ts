import { z } from "zod";
import type { OAuthRefresher } from "../../vault/refresh.ts";
import { type ConfidentialClient, exchangeCode, oauthRefresher } from "../oauth-client.ts";
import { type FetchFn, grantedScopes, type ProviderSignIn, SignInError } from "../sign-in.ts";

/**
 * Signing in to Google for a Gmail account (D9a-1). heel is a confidential
 * web-server client registered by the operator (`providers.google` in
 * heel.yaml); Google offers no dynamic registration.
 *
 * Facts from Google's "Using OAuth 2.0 for Web Server Applications":
 * - `access_type=offline` returns a refresh token; `prompt=consent` makes
 *   Google issue one again when the person has consented before.
 *   `prompt=select_account` shows Google's account list every time, so
 *   someone signed in to several accounts can pick (or switch) the right one.
 * - The token response's `scope` is the space-separated list actually
 *   granted. People can untick scopes, so heel checks it.
 * - A revoked or expired grant answers `invalid_grant`.
 *
 * Scopes (Gmail API "Choose Gmail API scopes"): `gmail.modify` covers
 * reading, labels, trash and sending; `gmail.settings.basic` covers filters.
 * Permanent delete needs the full `mail.google.com` scope, which heel never
 * asks for, so a delete is always a trash.
 */

export type { FetchFn } from "../sign-in.ts";

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/";

export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
export const GMAIL_SETTINGS_SCOPE = "https://www.googleapis.com/auth/gmail.settings.basic";
export const GMAIL_SCOPES = [GMAIL_MODIFY_SCOPE, GMAIL_SETTINGS_SCOPE] as const;

/** Environment variable carrying the client secret; it beats `client_secret_file`. */
export const GOOGLE_CLIENT_SECRET_ENV = "HEEL_GOOGLE_CLIENT_SECRET";

/** The operator's Google client. */
export type GoogleClient = ConfidentialClient;

/** Pure: the URL that starts a sign-in. */
export function googleAuthorizeUrl(
  client: Pick<GoogleClient, "clientId" | "redirectUri">,
  input: { state: string; challenge: string; redirectUri?: string },
  scopes: readonly string[] = GMAIL_SCOPES,
): URL {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: input.redirectUri ?? client.redirectUri.toString(),
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    prompt: "select_account consent",
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url;
}

/** The vault's refresher for Gmail accounts: `invalid_grant` means sign in again. */
export function googleRefresher(
  deps: { fetch: FetchFn; now: () => Date },
  client: GoogleClient,
): OAuthRefresher {
  return oauthRefresher({
    ...deps,
    label: "Google",
    tokenUrl: GOOGLE_TOKEN_URL,
    client,
    finalErrors: new Set(["invalid_grant"]),
  });
}

const ProfileSchema = z.object({ emailAddress: z.string().min(1) });

/** The mailbox a token belongs to (`users.getProfile`). */
export async function gmailMailbox(
  fetch: FetchFn,
  accessToken: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(new URL("users/me/profile", GMAIL_API_BASE), {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new SignInError("heel couldn't read the mailbox's address.");
  const body = ProfileSchema.safeParse(await response.json());
  if (!body.success) throw new SignInError("heel couldn't read the mailbox's address.");
  return body.data.emailAddress.toLowerCase();
}

/**
 * What one kind of Google account asks for and checks: Gmail and Google
 * Calendar accounts sign in through the same client, with different scopes.
 */
export interface GoogleProfile {
  scopes: readonly string[];
  /** Without this scope granted, no tool could run, so the sign-in is refused. */
  required: string;
  missing: string;
  /** The address the token opens: the mailbox, or the primary calendar's id. */
  address(fetch: FetchFn, accessToken: string, signal: AbortSignal): Promise<string>;
}

export const GMAIL_PROFILE: GoogleProfile = {
  scopes: GMAIL_SCOPES,
  required: GMAIL_MODIFY_SCOPE,
  missing: "heel needs access to read and manage mail. Tick every box.",
  address: gmailMailbox,
};

export const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3/";
/** Events on every calendar the person can edit (Calendar API "Choose scopes"). */
export const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
/** The calendar list, read-only. */
export const CALENDAR_LIST_SCOPE = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";

const PrimarySchema = z.object({ id: z.string().min(1) });

/** The primary calendar's id (calendarList.get "primary"), read rather than assumed. */
export async function primaryCalendar(
  fetch: FetchFn,
  accessToken: string,
  signal: AbortSignal,
): Promise<string> {
  // calendarList/primary, not calendars/primary: `calendars.get` doesn't accept
  // the events scope, and the primary id only "usually" matches the address.
  const response = await fetch(new URL("users/me/calendarList/primary", CALENDAR_API_BASE), {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    signal,
  });
  const body = response.ok ? PrimarySchema.safeParse(await response.json()) : null;
  if (!body?.success) throw new SignInError("heel couldn't read the primary calendar.");
  return body.data.id.toLowerCase();
}

export const CALENDAR_PROFILE: GoogleProfile = {
  scopes: [CALENDAR_EVENTS_SCOPE, CALENDAR_LIST_SCOPE],
  required: CALENDAR_EVENTS_SCOPE,
  missing: "heel needs access to your calendar's events. Tick every box.",
  address: primaryCalendar,
};

/**
 * Google's part of signing an account in, for one kind of account. With
 * `loopback`, the client is heel's built-in desktop client: each sign-in
 * passes its own loopback redirect, and `client.redirectUri` is unused.
 */
export function googleSignIn(
  deps: { fetch: FetchFn; now: () => Date },
  client: GoogleClient,
  callbackPath: string,
  profile: GoogleProfile = GMAIL_PROFILE,
  options: { loopback?: boolean } = {},
): ProviderSignIn {
  return {
    label: "Google",
    callbackPath,
    clientId: client.clientId,
    ...(options.loopback === true ? { loopback: true as const } : {}),
    authorizeUrl: (input) => googleAuthorizeUrl(client, input, profile.scopes),
    async exchange(input) {
      const tokens = await exchangeCode(deps, GOOGLE_TOKEN_URL, client, input);
      if (tokens === null) throw new SignInError("Google didn't accept the sign-in.");
      if (!grantedScopes(tokens.scope).has(profile.required)) {
        throw new SignInError(profile.missing);
      }
      return tokens;
    },
    mailbox: (accessToken, signal) => profile.address(deps.fetch, accessToken, signal),
  };
}
