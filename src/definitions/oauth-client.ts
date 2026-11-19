import { z } from "zod";
import {
  type OAuthRefresher,
  type OAuthTokens,
  RefreshUnavailableError,
} from "../vault/refresh.ts";
import type { Secret } from "../vault/secret.ts";
import type { FetchFn } from "./sign-in.ts";

/**
 * heel as a confidential OAuth client of a provider (Google, Microsoft):
 * the token endpoint calls both share. Each provider names its endpoint and
 * which error codes mean the grant is gone for good.
 */

/** An operator-registered OAuth client, from heel.yaml and a secret file. */
export interface ConfidentialClient {
  clientId: string;
  clientSecret: Secret;
  /** `public_url` + the provider's callback path. */
  redirectUri: URL;
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

function postToken(fetch: FetchFn, tokenUrl: string, form: Record<string, string>) {
  return fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(10_000),
  });
}

/** The code exchange (RFC 6749 §4.1.3, with PKCE). Null when the provider refused or answered nonsense. */
export async function exchangeCode(
  deps: { fetch: FetchFn; now: () => Date },
  tokenUrl: string,
  client: ConfidentialClient,
  input: { code: string; verifier: string; redirectUri?: string; extra?: Record<string, string> },
): Promise<OAuthTokens | null> {
  const response = await postToken(deps.fetch, tokenUrl, {
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.verifier,
    client_id: client.clientId,
    client_secret: client.clientSecret.reveal(),
    redirect_uri: input.redirectUri ?? client.redirectUri.toString(),
    ...input.extra,
  });
  if (!response.ok) return null;
  const body = TokenResponseSchema.safeParse(await response.json().catch(() => null));
  return body.success ? toTokens(body.data, deps.now()) : null;
}

/**
 * The vault's refresher for one provider. An answer whose `error` is in
 * `finalErrors` means the grant is gone and the account must sign in again;
 * any other failure (a 5xx, a timeout, the network) is temporary and
 * leaves the account as it is. A rotated refresh token comes back in the
 * tokens, and the vault stores it before handing out the access token.
 */
export function oauthRefresher(input: {
  fetch: FetchFn;
  now: () => Date;
  label: string;
  tokenUrl: string;
  client: ConfidentialClient;
  finalErrors: ReadonlySet<string>;
  extra?: Record<string, string>;
}): OAuthRefresher {
  return async ({ refreshToken }) => {
    let response: Response;
    try {
      response = await postToken(input.fetch, input.tokenUrl, {
        grant_type: "refresh_token",
        refresh_token: refreshToken.reveal(),
        client_id: input.client.clientId,
        client_secret: input.client.clientSecret.reveal(),
        ...input.extra,
      });
    } catch (error) {
      throw new RefreshUnavailableError(`${input.label}'s token endpoint couldn't be reached`, {
        cause: error,
      });
    }
    if (!response.ok) {
      const body = ErrorResponseSchema.safeParse(await response.json().catch(() => null));
      if (body.success && input.finalErrors.has(body.data.error)) {
        throw new Error(`${input.label} revoked or expired the grant (${body.data.error})`);
      }
      throw new RefreshUnavailableError(
        `${input.label}'s token endpoint answered ${response.status}`,
      );
    }
    const body = TokenResponseSchema.safeParse(await response.json().catch(() => null));
    if (!body.success)
      throw new RefreshUnavailableError(`${input.label}'s token answer didn't parse`);
    return toTokens(body.data, input.now());
  };
}
