import { z } from "zod";
import type { OAuthRefresher } from "../../vault/refresh.ts";
import { type ConfidentialClient, exchangeCode, oauthRefresher } from "../oauth-client.ts";
import { type FetchFn, grantedScopes, type ProviderSignIn, SignInError } from "../sign-in.ts";

/**
 * Signing in to Microsoft for an Outlook account (D9b). heel is a
 * confidential web app registered by the operator (`providers.microsoft`
 * in heel.yaml), using delegated permissions.
 *
 * Facts from the Microsoft identity platform docs (research: graph-research
 * §1):
 * - Endpoints are `login.microsoftonline.com/<tenant>/oauth2/v2.0/…`, where
 *   tenant is `common`, `organizations`, `consumers` or a tenant id.
 * - PKCE is recommended for confidential clients too.
 * - A refresh token comes back only when `offline_access` is asked for, and
 *   each refresh returns a new one. The vault stores it before using the
 *   access token.
 * - A dead grant answers `invalid_grant`, or `interaction_required` when MFA
 *   or Conditional Access wants the person back. Both mean sign in again.
 *
 * Scopes (Graph permissions reference, all delegated, no admin consent):
 * `Mail.ReadWrite` (read, drafts, move, delete), `Mail.Send`,
 * `MailboxSettings.ReadWrite` (inbox rules) and `User.Read` (the address).
 */

export const GRAPH_API_BASE = "https://graph.microsoft.com/v1.0/";

export const OUTLOOK_SCOPES = [
  "openid",
  "offline_access",
  "User.Read",
  "Mail.ReadWrite",
  "Mail.Send",
  "MailboxSettings.ReadWrite",
] as const;

/** Without these, no Outlook tool could run. */
const REQUIRED_SCOPES = ["Mail.ReadWrite", "Mail.Send"] as const;

/** Environment variable carrying the client secret; it beats `client_secret_file`. */
export const MICROSOFT_CLIENT_SECRET_ENV = "HEEL_MICROSOFT_CLIENT_SECRET";

/** The operator's Microsoft app registration. */
export interface MicrosoftClient extends ConfidentialClient {
  /** `common`, `organizations`, `consumers` or a tenant id. */
  tenant: string;
}

function endpoint(client: MicrosoftClient, path: "authorize" | "token"): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(client.tenant)}/oauth2/v2.0/${path}`;
}

/** Pure: whether a token response granted a scope; Microsoft may name it with the Graph prefix. */
export function hasScope(scope: string | undefined, wanted: string): boolean {
  const lower = wanted.toLowerCase();
  return [...grantedScopes(scope)].some((granted) => {
    const name = granted.toLowerCase();
    return name === lower || name === `https://graph.microsoft.com/${lower}`;
  });
}

/** Pure: the URL that starts a sign-in. */
export function microsoftAuthorizeUrl(
  client: MicrosoftClient,
  input: { state: string; challenge: string },
): URL {
  const url = new URL(endpoint(client, "authorize"));
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri.toString(),
    response_type: "code",
    response_mode: "query",
    scope: OUTLOOK_SCOPES.join(" "),
    prompt: "select_account",
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url;
}

/** The vault's refresher for Outlook accounts. */
export function microsoftRefresher(
  deps: { fetch: FetchFn; now: () => Date },
  client: MicrosoftClient,
): OAuthRefresher {
  return oauthRefresher({
    ...deps,
    label: "Microsoft",
    tokenUrl: endpoint(client, "token"),
    client,
    finalErrors: new Set(["invalid_grant", "interaction_required"]),
    extra: { scope: OUTLOOK_SCOPES.join(" ") },
  });
}

const MeSchema = z.object({
  mail: z.string().nullable().optional(),
  userPrincipalName: z.string().nullable().optional(),
});

/**
 * The mailbox a token belongs to: `mail`, the user's SMTP address. Only
 * when that is empty, `userPrincipalName`, which matches it by convention.
 */
export async function outlookMailbox(
  fetch: FetchFn,
  accessToken: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(new URL("me?$select=mail,userPrincipalName", GRAPH_API_BASE), {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    signal,
  });
  const body = response.ok ? MeSchema.safeParse(await response.json()) : null;
  const address = body?.success ? (body.data.mail ?? body.data.userPrincipalName) : null;
  if (address === null || address === undefined || address === "") {
    throw new SignInError("heel couldn't read the mailbox's address.");
  }
  return address.toLowerCase();
}

/** Microsoft's part of signing an Outlook account in. */
export function microsoftSignIn(
  deps: { fetch: FetchFn; now: () => Date },
  client: MicrosoftClient,
  callbackPath: string,
): ProviderSignIn {
  return {
    label: "Microsoft",
    callbackPath,
    authorizeUrl: (input) => microsoftAuthorizeUrl(client, input),
    async exchange(input) {
      const tokens = await exchangeCode(deps, endpoint(client, "token"), client, {
        ...input,
        extra: { scope: OUTLOOK_SCOPES.join(" ") },
      });
      if (tokens === null) throw new SignInError("Microsoft didn't accept the sign-in.");
      if (!REQUIRED_SCOPES.every((scope) => hasScope(tokens.scope, scope))) {
        throw new SignInError(
          "heel needs permission to read, manage and send mail. Accept every one.",
        );
      }
      return tokens;
    },
    mailbox: (accessToken, signal) => outlookMailbox(deps.fetch, accessToken, signal),
  };
}
