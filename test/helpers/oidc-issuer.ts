import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A mock OpenID Provider for tests: discovery, JWKS, token and userinfo over
 * real HTTP on loopback. The authorization step (a browser at the IdP) is a
 * method call, `authorize()`, that returns the callback URL the IdP would
 * redirect to. Like a real IdP it enforces PKCE: the token endpoint refuses a
 * code_verifier whose S256 hash isn't the code_challenge it was given.
 */

export interface TokenRequest {
  form: URLSearchParams;
  authorization: string | undefined;
}

interface IssuedCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  nonce: string | null;
  scope: string;
}

export interface MockIssuerOptions {
  /** Advertised in discovery; default ["S256"]. Null omits the field. */
  codeChallengeMethods?: string[] | null;
  /** When set, the token endpoint requires HTTP Basic with this secret. */
  clientSecret?: string;
}

const KID = "test-key-1";

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** Pure: an RS256 compact JWS over `payload`. */
function signJwt(payload: Record<string, unknown>, key: KeyObject, kid: string): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const body = base64url(JSON.stringify(payload));
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${body}`), key);
  return `${header}.${body}.${base64url(signature)}`;
}

/**
 * RFC 6749 §2.3.1: client_secret_basic form-urlencodes the id and secret
 * before base64, so decode both halves the same way.
 */
function decodeBasic(header: string | undefined): { id: string; secret: string } | null {
  if (!header?.startsWith("Basic ")) return null;
  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) return null;
  const formDecode = (part: string) => decodeURIComponent(part.replaceAll("+", " "));
  return { id: formDecode(decoded.slice(0, colon)), secret: formDecode(decoded.slice(colon + 1)) };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

export class MockIssuer {
  readonly #server: Server;
  readonly #options: MockIssuerOptions;
  readonly #signingKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
  readonly #codes = new Map<string, IssuedCode>();
  #url = "";

  /** Every request the token endpoint received, in order. */
  readonly tokenRequests: TokenRequest[] = [];
  /** Merged over the default ID token claims; `undefined` deletes a claim. */
  idTokenOverrides: Record<string, unknown> = {};
  /** Extra ID token claims, e.g. `{ groups: ["heel-admins"] }`. */
  idTokenClaims: Record<string, unknown> = {};
  /** Claims userinfo returns besides `sub`. */
  userinfoClaims: Record<string, unknown> = {};
  /** Signs ID tokens with a key that isn't in the JWKS. */
  signWithForeignKey = false;
  subject = "user-123";

  private constructor(options: MockIssuerOptions) {
    this.#options = options;
    this.#server = createServer((request, response) => {
      this.#handle(request, response).catch((error: unknown) => {
        json(response, 500, { error: "server_error", error_description: String(error) });
      });
    });
  }

  static async start(options: MockIssuerOptions = {}): Promise<MockIssuer> {
    const issuer = new MockIssuer(options);
    await new Promise<void>((resolve) => issuer.#server.listen(0, "127.0.0.1", resolve));
    const { port } = issuer.#server.address() as AddressInfo;
    issuer.#url = `http://127.0.0.1:${port}`;
    return issuer;
  }

  get url(): URL {
    return new URL(this.#url);
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  /**
   * Plays the browser leg: reads the authorization request, remembers the
   * PKCE challenge and nonce against a fresh code, and returns the redirect.
   */
  authorize(authorizationUrl: URL): URL {
    const params = authorizationUrl.searchParams;
    const redirectUri = params.get("redirect_uri");
    const clientId = params.get("client_id");
    if (!redirectUri || !clientId)
      throw new Error("authorization request lacks redirect_uri or client_id");
    const code = base64url(randomBytes(16));
    this.#codes.set(code, {
      clientId,
      redirectUri,
      codeChallenge: params.get("code_challenge"),
      codeChallengeMethod: params.get("code_challenge_method"),
      nonce: params.get("nonce"),
      scope: params.get("scope") ?? "",
    });
    const callback = new URL(redirectUri);
    callback.searchParams.set("code", code);
    const state = params.get("state");
    if (state !== null) callback.searchParams.set("state", state);
    callback.searchParams.set("iss", this.#url);
    return callback;
  }

  /** The redirect an IdP sends when the person declines. */
  deny(authorizationUrl: URL, error = "access_denied"): URL {
    const params = authorizationUrl.searchParams;
    const callback = new URL(params.get("redirect_uri") ?? "");
    callback.searchParams.set("error", error);
    const state = params.get("state");
    if (state !== null) callback.searchParams.set("state", state);
    callback.searchParams.set("iss", this.#url);
    return callback;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? "/", this.#url).pathname;
    if (request.method === "GET" && path === "/.well-known/openid-configuration") {
      const methods = this.#options.codeChallengeMethods;
      json(response, 200, {
        issuer: this.#url,
        authorization_endpoint: `${this.#url}/authorize`,
        token_endpoint: `${this.#url}/token`,
        jwks_uri: `${this.#url}/jwks`,
        userinfo_endpoint: `${this.#url}/userinfo`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
        ...(methods === null ? {} : { code_challenge_methods_supported: methods ?? ["S256"] }),
      });
      return;
    }
    if (request.method === "GET" && path === "/jwks") {
      const jwk = this.#signingKey.publicKey.export({ format: "jwk" });
      json(response, 200, { keys: [{ ...jwk, kid: KID, use: "sig", alg: "RS256" }] });
      return;
    }
    if (request.method === "POST" && path === "/token") {
      await this.#token(request, response);
      return;
    }
    if (request.method === "GET" && path === "/userinfo") {
      if (request.headers.authorization !== "Bearer access-token") {
        json(response, 401, { error: "invalid_token" });
        return;
      }
      json(response, 200, { sub: this.subject, ...this.userinfoClaims });
      return;
    }
    json(response, 404, { error: "not_found" });
  }

  async #token(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const form = new URLSearchParams(await readBody(request));
    this.tokenRequests.push({ form, authorization: request.headers.authorization });
    const issued = this.#codes.get(form.get("code") ?? "");
    if (form.get("grant_type") !== "authorization_code" || !issued) {
      json(response, 400, { error: "invalid_grant" });
      return;
    }
    // Codes are single use.
    this.#codes.delete(form.get("code") ?? "");
    if (this.#options.clientSecret !== undefined) {
      const basic = decodeBasic(request.headers.authorization);
      if (basic?.id !== issued.clientId || basic.secret !== this.#options.clientSecret) {
        json(response, 401, { error: "invalid_client" });
        return;
      }
    }
    if (form.get("redirect_uri") !== issued.redirectUri) {
      json(response, 400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
      return;
    }
    if (issued.codeChallenge !== null) {
      const verifier = form.get("code_verifier") ?? "";
      const computed = createHash("sha256").update(verifier).digest("base64url");
      if (issued.codeChallengeMethod !== "S256" || computed !== issued.codeChallenge) {
        json(response, 400, {
          error: "invalid_grant",
          error_description: "PKCE verification failed",
        });
        return;
      }
    }
    const now = Math.floor(Date.now() / 1_000);
    const claims: Record<string, unknown> = {
      iss: this.#url,
      sub: this.subject,
      aud: issued.clientId,
      iat: now,
      exp: now + 300,
      ...(issued.nonce === null ? {} : { nonce: issued.nonce }),
      ...this.idTokenClaims,
    };
    for (const [name, value] of Object.entries(this.idTokenOverrides)) {
      if (value === undefined) delete claims[name];
      else claims[name] = value;
    }
    const key = this.signWithForeignKey
      ? generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
      : this.#signingKey.privateKey;
    json(response, 200, {
      access_token: "access-token",
      token_type: "Bearer",
      expires_in: 300,
      id_token: signJwt(claims, key, KID),
    });
  }
}
