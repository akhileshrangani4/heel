import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { OAuthRefresher, OAuthTokens } from "../../vault/refresh.ts";
import { RefreshUnavailableError } from "../../vault/refresh.ts";
import type { Secret } from "../../vault/secret.ts";

/**
 * Signing in to Google for a Gmail account (D9a-1). heel is a confidential
 * web-server client registered by the operator (`providers.google` in
 * heel.yaml); Google offers no dynamic registration.
 *
 * Facts from Google's "Using OAuth 2.0 for Web Server Applications":
 * - `access_type=offline` returns a refresh token; `prompt=consent` makes
 *   Google issue one again when the person has consented before.
 * - The token response's `scope` is the space-separated list actually
 *   granted. People can untick scopes, so heel checks it.
 * - A revoked or expired grant answers `invalid_grant`.
 *
 * Scopes (Gmail API "Choose Gmail API scopes"): `gmail.modify` covers
 * reading, labels, trash and sending; `gmail.settings.basic` covers filters.
 * Permanent delete needs the full `mail.google.com` scope, which heel never
 * asks for, so a delete is always a trash.
 */

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/";

export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
export const GMAIL_SETTINGS_SCOPE = "https://www.googleapis.com/auth/gmail.settings.basic";
export const GMAIL_SCOPES = [GMAIL_MODIFY_SCOPE, GMAIL_SETTINGS_SCOPE] as const;

/** Environment variable carrying the client secret; it beats `client_secret_file`. */
export const GOOGLE_CLIENT_SECRET_ENV = "HEEL_GOOGLE_CLIENT_SECRET";

/** The operator's OAuth client, from heel.yaml and the secret file. */
export interface GoogleClient {
  clientId: string;
  clientSecret: Secret;
  /** `public_url` + GOOGLE_CALLBACK_PATH. */
  redirectUri: URL;
}

export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Why heel refused a finished sign-in; the message is safe to show the person. */
export class GoogleSignInError extends Error {
  override readonly name = "GoogleSignInError";
}

/** A PKCE verifier and its S256 challenge (RFC 7636). */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Pure: the URL that starts a sign-in. */
export function googleAuthorizeUrl(
  client: Pick<GoogleClient, "clientId" | "redirectUri">,
  input: { state: string; challenge: string },
): URL {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri.toString(),
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url;
}

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
});

const ErrorResponseSchema = z.object({ error: z.string() });

function toTokens(body: z.output<typeof TokenResponseSchema>, now: Date): OAuthTokens {
  return {
    accessToken: body.access_token,
    ...(body.refresh_token === undefined ? {} : { refreshToken: body.refresh_token }),
    ...(body.expires_in === undefined
      ? {}
      : { expiresAt: now.getTime() + body.expires_in * 1_000 }),
    ...(body.scope === undefined ? {} : { scope: body.scope }),
  };
}

/** Pure: the granted scopes, from a token response's space-separated `scope`. */
export function grantedScopes(scope: string | undefined): Set<string> {
  return new Set((scope ?? "").split(" ").filter((s) => s !== ""));
}

async function postToken(
  fetch: FetchFn,
  form: Record<string, string>,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    signal,
  });
}

/**
 * Exchanges the code Google sent back. Refuses a sign-in that came back
 * without a refresh token (heel would lose the account within the hour) or
 * without `gmail.modify` (no tool could run).
 */
export async function exchangeGoogleCode(
  deps: { fetch: FetchFn; now: () => Date },
  client: GoogleClient,
  input: { code: string; verifier: string },
): Promise<OAuthTokens> {
  const response = await postToken(
    deps.fetch,
    {
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.verifier,
      client_id: client.clientId,
      client_secret: client.clientSecret.reveal(),
      redirect_uri: client.redirectUri.toString(),
    },
    AbortSignal.timeout(10_000),
  );
  if (!response.ok) throw new GoogleSignInError("Google didn't accept the sign-in.");
  const body = TokenResponseSchema.safeParse(await response.json());
  if (!body.success) throw new GoogleSignInError("Google's answer didn't parse.");
  if (body.data.refresh_token === undefined) {
    throw new GoogleSignInError(
      "Google sent no refresh token. Remove heel's access and try again.",
    );
  }
  if (!grantedScopes(body.data.scope).has(GMAIL_MODIFY_SCOPE)) {
    throw new GoogleSignInError("heel needs access to read and manage mail. Tick every box.");
  }
  return toTokens(body.data, deps.now());
}

/**
 * The vault's refresher for Gmail accounts. A revoked or expired grant
 * (`invalid_grant`) is final and the account needs signing in again; any
 * other failure (a 5xx, a timeout, the network) is temporary and leaves the
 * account as it is.
 */
export function googleRefresher(
  deps: { fetch: FetchFn; now: () => Date },
  client: GoogleClient,
): OAuthRefresher {
  return async ({ refreshToken }) => {
    let response: Response;
    try {
      response = await postToken(
        deps.fetch,
        {
          grant_type: "refresh_token",
          refresh_token: refreshToken.reveal(),
          client_id: client.clientId,
          client_secret: client.clientSecret.reveal(),
        },
        AbortSignal.timeout(10_000),
      );
    } catch (error) {
      throw new RefreshUnavailableError("Google's token endpoint couldn't be reached", {
        cause: error,
      });
    }
    if (!response.ok) {
      const body = ErrorResponseSchema.safeParse(await response.json().catch(() => null));
      if (body.success && body.data.error === "invalid_grant") {
        throw new Error("Google revoked or expired the grant (invalid_grant)");
      }
      throw new RefreshUnavailableError(`Google's token endpoint answered ${response.status}`);
    }
    const body = TokenResponseSchema.safeParse(await response.json());
    if (!body.success) throw new RefreshUnavailableError("Google's token answer didn't parse");
    return toTokens(body.data, deps.now());
  };
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
  if (!response.ok) throw new GoogleSignInError("heel couldn't read the mailbox's address.");
  const body = ProfileSchema.safeParse(await response.json());
  if (!body.success) throw new GoogleSignInError("heel couldn't read the mailbox's address.");
  return body.data.emailAddress.toLowerCase();
}
