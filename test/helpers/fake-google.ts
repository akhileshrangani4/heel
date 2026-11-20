import { createHash } from "node:crypto";
import {
  GMAIL_API_BASE,
  GMAIL_MODIFY_SCOPE,
  GMAIL_SCOPES,
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_TOKEN_URL,
  type GoogleClient,
} from "../../src/definitions/google/oauth.ts";
import { Secret } from "../../src/vault/secret.ts";
import { PUBLIC_URL } from "./human-plane.ts";

/**
 * A fake of Google's OAuth endpoints and the Gmail profile read, reached
 * through `fetch`. It checks what Google checks (client, secret, redirect
 * URI, PKCE) so a test proves heel sends them. Tokens are low-entropy
 * placeholders.
 */

export const TEST_GOOGLE_CLIENT: GoogleClient = {
  clientId: "heel-test.apps.googleusercontent.com",
  clientSecret: new Secret("test-client-secret"),
  redirectUri: new URL("/oauth/google/callback", PUBLIC_URL),
};

interface IssuedCode {
  challenge: string;
  redirectUri: string;
  mailbox: string;
  scope: string;
}

export class FakeGoogle {
  /** The mailbox the next consent signs in to. */
  mailbox = "alice@company.com";
  /** The scopes the next consent grants; people can untick some. */
  grantedScope: string = GMAIL_SCOPES.join(" ");
  /** False to answer a code exchange without a refresh token. */
  issueRefreshToken = true;
  /** How the token endpoint answers a refresh. */
  refresh: "ok" | "revoked" | "down" = "ok";
  readonly #codes = new Map<string, IssuedCode>();
  readonly #accessTokens = new Map<string, string>();
  #counter = 0;

  /** The person's part: consents on Google's page; returns heel's callback URL. */
  consent(authorizeUrl: string): URL {
    const url = new URL(authorizeUrl);
    if (url.origin + url.pathname !== GOOGLE_AUTHORIZE_URL) throw new Error("not Google's page");
    const params = url.searchParams;
    if (params.get("client_id") !== TEST_GOOGLE_CLIENT.clientId) throw new Error("wrong client");
    if (
      params.get("access_type") !== "offline" ||
      params.get("prompt") !== "select_account consent"
    ) {
      throw new Error("heel must ask for offline access with consent");
    }
    if (params.get("code_challenge_method") !== "S256") throw new Error("no PKCE");
    const code = `code-${++this.#counter}`;
    this.#codes.set(code, {
      challenge: params.get("code_challenge") ?? "",
      redirectUri: params.get("redirect_uri") ?? "",
      mailbox: this.mailbox,
      scope: this.grantedScope,
    });
    const callback = new URL(params.get("redirect_uri") ?? "");
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", params.get("state") ?? "");
    return callback;
  }

  readonly fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input.toString());
    if (url.toString() === GOOGLE_TOKEN_URL) return this.#token(init);
    if (url.toString() === new URL("users/me/profile", GMAIL_API_BASE).toString()) {
      const mailbox = this.#mailboxFor(init);
      return mailbox === null
        ? Response.json({ error: { code: 401 } }, { status: 401 })
        : Response.json({ emailAddress: mailbox, messagesTotal: 0 });
    }
    if (url.toString() === "https://www.googleapis.com/calendar/v3/users/me/calendarList/primary") {
      const mailbox = this.#mailboxFor(init);
      return mailbox === null
        ? Response.json({ error: { code: 401 } }, { status: 401 })
        : Response.json({ id: mailbox, primary: true });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  };

  #mailboxFor(init: RequestInit | undefined): string | null {
    const header = new Headers(init?.headers).get("authorization") ?? "";
    return this.#accessTokens.get(header.replace(/^Bearer /, "")) ?? null;
  }

  #issue(mailbox: string): string {
    const token = `access-${++this.#counter}`;
    this.#accessTokens.set(token, mailbox);
    return token;
  }

  #token(init: RequestInit | undefined): Response {
    const form = new URLSearchParams(String(init?.body ?? ""));
    if (
      form.get("client_id") !== TEST_GOOGLE_CLIENT.clientId ||
      form.get("client_secret") !== TEST_GOOGLE_CLIENT.clientSecret.reveal()
    ) {
      return Response.json({ error: "invalid_client" }, { status: 401 });
    }
    if (form.get("grant_type") === "refresh_token") {
      if (this.refresh === "revoked") {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      if (this.refresh === "down") return new Response("unavailable", { status: 503 });
      const mailbox = (form.get("refresh_token") ?? "").replace(/^refresh-/, "");
      return Response.json({
        access_token: this.#issue(mailbox),
        expires_in: 3599,
        scope: GMAIL_MODIFY_SCOPE,
        token_type: "Bearer",
      });
    }
    const issued = this.#codes.get(form.get("code") ?? "");
    this.#codes.delete(form.get("code") ?? "");
    const challenge = createHash("sha256")
      .update(form.get("code_verifier") ?? "")
      .digest("base64url");
    if (
      issued === undefined ||
      issued.challenge !== challenge ||
      issued.redirectUri !== form.get("redirect_uri")
    ) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    return Response.json({
      access_token: this.#issue(issued.mailbox),
      expires_in: 3599,
      ...(this.issueRefreshToken && { refresh_token: `refresh-${issued.mailbox}` }),
      scope: issued.scope,
      token_type: "Bearer",
    });
  }
}
