import * as oidc from "openid-client";
import { isLoopbackUrl, type OidcConfig } from "../config/schema.ts";
import type { UserRole } from "../store/schema.ts";
import { Secret } from "../vault/secret.ts";
import { loadSecret } from "../vault/secret-file.ts";
import { readGroupsClaim, roleForGroups } from "./roles.ts";

/**
 * The OIDC relying party for team sign-in (spec: Teams, "Sign-in"): discovery,
 * the authorization-code flow with PKCE (S256), and ID token validation —
 * issuer, audience, nonce, expiry, and the signature against the issuer's
 * JWKS. This is a library: D13b stores the pending sign-in in the human
 * plane's session and mounts the callback at `OidcConfig.redirectUri`.
 *
 * An OIDC sign-in never decides anything; every decision still needs a fresh
 * passkey assertion (I-56). This module only answers "who is this, and what
 * role do their groups grant?".
 */

/** Environment variable that carries the client secret; it beats `client_secret_file`. */
export const OIDC_CLIENT_SECRET_ENV = "HEEL_OIDC_CLIENT_SECRET";

/** How long a person has to finish signing in at the IdP. */
export const SIGN_IN_TTL_MS = 10 * 60 * 1_000;

/** Seconds; applies to discovery, JWKS, token and userinfo requests. */
const IDP_TIMEOUT_SECONDS = 10;

export type OidcErrorCode =
  /** The issuer's discovery document could not be fetched or is unusable. */
  | "discovery_failed"
  /** The issuer does not advertise S256 PKCE; heel never signs in without it. */
  | "pkce_unsupported"
  /** The pending sign-in is older than SIGN_IN_TTL_MS. */
  | "sign_in_expired"
  /** The IdP sent the person back with an OAuth error (e.g. access_denied). */
  | "idp_error"
  /** The IdP's token endpoint refused the code (e.g. a PKCE verifier mismatch). */
  | "token_exchange_failed"
  /** The callback or the ID token failed validation (state, iss, aud, nonce, exp, signature). */
  | "response_invalid"
  /** The groups claim exists but is not a string or a list of strings. */
  | "groups_malformed";

export class OidcError extends Error {
  override readonly name = "OidcError";
  readonly code: OidcErrorCode;

  constructor(code: OidcErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

export interface OidcSettings
  extends Pick<
    OidcConfig,
    "issuer" | "clientId" | "redirectUri" | "scopes" | "groupsClaim" | "roles"
  > {
  /** Null for a public client, which relies on PKCE alone. */
  clientSecret: Secret | null;
}

/**
 * Builds client settings from heel.yaml's `oidc:` section. The secret comes
 * from HEEL_OIDC_CLIENT_SECRET, else `client_secret_file`; with neither, heel
 * is a public client. A configured file that is missing or loosely permissioned
 * throws SecretFileError rather than silently downgrading to a public client.
 */
export function oidcSettings(
  config: OidcConfig,
  env: Readonly<Record<string, string | undefined>>,
): OidcSettings {
  const fromEnv = env[OIDC_CLIENT_SECRET_ENV];
  let clientSecret: Secret | null = null;
  if (fromEnv !== undefined && fromEnv !== "") clientSecret = new Secret(fromEnv);
  else if (config.clientSecretFile !== null) {
    clientSecret = loadSecret(env, OIDC_CLIENT_SECRET_ENV, config.clientSecretFile);
  }
  return {
    issuer: config.issuer,
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    scopes: config.scopes,
    groupsClaim: config.groupsClaim,
    roles: config.roles,
    clientSecret,
  };
}

/**
 * What the human plane must keep, server-side, between redirecting a person
 * to the IdP and handling the callback. All three values are secrets: never
 * put them in a cookie the browser can read or in a log.
 */
export interface PendingSignIn {
  state: string;
  nonce: string;
  codeVerifier: string;
  expiresAt: Date;
}

export interface SignInStart {
  authorizationUrl: URL;
  pending: PendingSignIn;
}

/** Who signed in, and what their IdP groups grant. */
export interface OidcIdentity {
  issuer: string;
  subject: string;
  /** For display and as the heel user name: preferred_username, then name, email, sub. */
  name: string;
  email: string | null;
  groups: string[];
  /** Null when no group is mapped to a role: the person may not sign in. */
  role: UserRole | null;
}

export interface OidcClientOptions {
  now?: () => Date;
}

function stringClaim(claims: Readonly<Record<string, unknown>>, name: string): string | null {
  const value = claims[name];
  return typeof value === "string" && value !== "" ? value : null;
}

/** Pure: the display name heel uses for a set of claims. */
export function displayName(claims: Readonly<Record<string, unknown>>, subject: string): string {
  return (
    stringClaim(claims, "preferred_username") ??
    stringClaim(claims, "name") ??
    stringClaim(claims, "email") ??
    subject
  );
}

/** Errors openid-client raises for a bad or refused response, as opposed to a fault in heel. */
function classifyGrantError(error: unknown): OidcError | null {
  if (error instanceof oidc.AuthorizationResponseError) {
    return new OidcError("idp_error", `the IdP returned ${error.error}`, { cause: error });
  }
  if (error instanceof oidc.ResponseBodyError) {
    return new OidcError("token_exchange_failed", `the IdP refused the code: ${error.error}`, {
      cause: error,
    });
  }
  if (error instanceof oidc.ClientError) {
    return new OidcError("response_invalid", error.message, { cause: error });
  }
  return null;
}

export class OidcClient {
  readonly #config: oidc.Configuration;
  readonly #settings: OidcSettings;
  readonly #now: () => Date;

  private constructor(config: oidc.Configuration, settings: OidcSettings, now: () => Date) {
    this.#config = config;
    this.#settings = settings;
    this.#now = now;
  }

  /**
   * Fetches the issuer's discovery document and builds a client. ID token
   * signatures are always checked against the issuer's JWKS, even though the
   * token arrives over TLS from the token endpoint.
   */
  static async discover(
    settings: OidcSettings,
    options: OidcClientOptions = {},
  ): Promise<OidcClient> {
    const execute: Array<(config: oidc.Configuration) => void> = [oidc.enableNonRepudiationChecks];
    // Config validation already limits plain http to loopback issuers.
    if (settings.issuer.protocol === "http:" && isLoopbackUrl(settings.issuer)) {
      execute.push(oidc.allowInsecureRequests);
    }
    const auth = settings.clientSecret
      ? oidc.ClientSecretBasic(settings.clientSecret.reveal())
      : oidc.None();
    let config: oidc.Configuration;
    try {
      config = await oidc.discovery(settings.issuer, settings.clientId, undefined, auth, {
        execute,
        timeout: IDP_TIMEOUT_SECONDS,
      });
    } catch (error) {
      throw new OidcError(
        "discovery_failed",
        `could not discover ${settings.issuer.href}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (!config.serverMetadata().supportsPKCE("S256")) {
      throw new OidcError(
        "pkce_unsupported",
        `${settings.issuer.href} does not advertise S256 in code_challenge_methods_supported`,
      );
    }
    return new OidcClient(config, settings, options.now ?? (() => new Date()));
  }

  /** Starts a sign-in: the URL to redirect the person to, and what to keep until they return. */
  async beginSignIn(): Promise<SignInStart> {
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const authorizationUrl = oidc.buildAuthorizationUrl(this.#config, {
      redirect_uri: this.#settings.redirectUri.href,
      response_type: "code",
      scope: this.#settings.scopes.join(" "),
      code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: "S256",
      state,
      nonce,
    });
    const expiresAt = new Date(this.#now().getTime() + SIGN_IN_TTL_MS);
    return { authorizationUrl, pending: { state, nonce, codeVerifier, expiresAt } };
  }

  /**
   * Finishes a sign-in from the callback URL the IdP redirected to. Validates
   * state, exchanges the code with the PKCE verifier, and validates the ID
   * token; then maps the groups claim to a role. Groups are read from the ID
   * token, or from userinfo when the ID token doesn't carry the claim.
   */
  async completeSignIn(callbackUrl: URL, pending: PendingSignIn): Promise<OidcIdentity> {
    if (this.#now().getTime() >= pending.expiresAt.getTime()) {
      throw new OidcError("sign_in_expired", "the sign-in took too long; start again");
    }
    let tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
    try {
      tokens = await oidc.authorizationCodeGrant(this.#config, callbackUrl, {
        pkceCodeVerifier: pending.codeVerifier,
        expectedState: pending.state,
        expectedNonce: pending.nonce,
        idTokenExpected: true,
      });
    } catch (error) {
      throw classifyGrantError(error) ?? error;
    }
    const claims = tokens.claims();
    if (!claims) throw new OidcError("response_invalid", "the IdP returned no ID token");

    let groupsClaim = readGroupsClaim(claims, this.#settings.groupsClaim);
    if (groupsClaim.state === "absent" && this.#config.serverMetadata().userinfo_endpoint) {
      let userinfo: oidc.UserInfoResponse;
      try {
        userinfo = await oidc.fetchUserInfo(this.#config, tokens.access_token, claims.sub);
      } catch (error) {
        throw classifyGrantError(error) ?? error;
      }
      groupsClaim = readGroupsClaim(userinfo, this.#settings.groupsClaim);
    }
    if (groupsClaim.state === "malformed") {
      throw new OidcError(
        "groups_malformed",
        `the "${this.#settings.groupsClaim}" claim is not a list of group names`,
      );
    }
    const groups = groupsClaim.state === "present" ? groupsClaim.groups : [];
    return {
      issuer: claims.iss,
      subject: claims.sub,
      name: displayName(claims, claims.sub),
      email: stringClaim(claims, "email"),
      groups,
      role: roleForGroups(groups, this.#settings.roles),
    };
  }
}
