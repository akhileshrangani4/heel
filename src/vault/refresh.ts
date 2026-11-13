import type { Secret } from "./secret.ts";

/**
 * OAuth refresh hooks. Each provider definition (D5, D9, D11, D12) registers
 * a refresher that exchanges a refresh token at its token endpoint; the vault
 * owns when to call it, single-flighting, and persisting what comes back
 * (spec: research STK §4, vault and refresh rules).
 */

export interface OAuthTokens {
  accessToken: string;
  /** A rotated refresh token, when the provider issued one. */
  refreshToken?: string;
  /** Milliseconds since the epoch; absent when the provider gave no lifetime. */
  expiresAt?: number;
  scope?: string;
}

export interface OAuthRefreshRequest {
  accountId: string;
  provider: string;
  refreshToken: Secret;
}

/** Throws (or rejects) when the grant can no longer be refreshed. */
export type OAuthRefresher = (request: OAuthRefreshRequest) => Promise<OAuthTokens>;

/** Finds the refresher for a provider; undefined when it has none. */
export type RefresherLookup = (provider: string) => OAuthRefresher | undefined;

export const noRefreshers: RefresherLookup = () => undefined;
