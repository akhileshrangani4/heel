import { randomBytes } from "node:crypto";
import {
  auth,
  type FetchLike,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { eq } from "drizzle-orm";
import type { HeelDb } from "../../store/db.ts";
import type { AccountRecord } from "../../store/directory.ts";
import { accounts } from "../../store/schema.ts";
import { type Vault, VaultError } from "../../vault/vault.ts";
import { type HttpUpstream, upstreamSettings } from "./settings.ts";

/**
 * heel as the OAuth client of a remote MCP server that wants sign-in (D5c,
 * spec: Upstream MCP servers). The SDK does the protocol (discovery, dynamic
 * registration, PKCE, refresh); this provider decides where its state lives:
 *
 * - what the server registered heel as: the account's settings (public);
 * - the tokens: the vault, like every other credential (I-02);
 * - a sign-in in progress (its state and PKCE verifier): memory, for ten
 *   minutes. A restart in the middle just means signing in again.
 *
 * A server that answers registration with a client secret is refused, so no
 * secret ever lands in settings: heel registers as a public client.
 */

/** Where every upstream sends the person back after they sign in. */
export const UPSTREAM_CALLBACK_PATH = "/oauth/upstream/callback";

const SIGN_IN_TTL_MS = 10 * 60_000;

export interface PendingSignIn {
  accountId: string;
  /** The person who started it; only they can finish it. */
  userId: string;
  verifier: string;
  expiresAt: number;
}

/** Sign-ins in progress, by their OAuth `state`. */
export class UpstreamSignIns {
  readonly #byState = new Map<string, PendingSignIn>();

  open(input: Omit<PendingSignIn, "expiresAt" | "verifier">, now: Date): string {
    for (const [state, pending] of this.#byState) {
      if (pending.expiresAt <= now.getTime()) this.#byState.delete(state);
    }
    const state = randomBytes(24).toString("base64url");
    this.#byState.set(state, { ...input, verifier: "", expiresAt: now.getTime() + SIGN_IN_TTL_MS });
    return state;
  }

  get(state: string, now: Date): PendingSignIn | null {
    const pending = this.#byState.get(state);
    if (pending === undefined || pending.expiresAt <= now.getTime()) return null;
    return pending;
  }

  /** Takes the sign-in out: a state works once. */
  take(state: string, now: Date): PendingSignIn | null {
    const pending = this.get(state, now);
    this.#byState.delete(state);
    return pending;
  }
}

export interface UpstreamOAuthDeps {
  db: HeelDb;
  vault: Vault;
  /** The human plane's public URL; the callback lives there. */
  publicUrl: URL;
  now: () => Date;
}

function httpUpstream(db: HeelDb, accountId: string): HttpUpstream {
  const row = db
    .select({ settings: accounts.settings })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .get();
  const upstream = row === undefined ? null : upstreamSettings(row.settings);
  if (upstream === null || upstream.transport !== "http")
    throw new Error(`account ${accountId} isn't a remote MCP server`);
  return upstream;
}

/**
 * The OAuth client provider for one account. `signIn` is set only while a
 * person is signing in: it holds their state and receives the authorization
 * URL to send their browser to.
 */
export class UpstreamOAuthProvider implements OAuthClientProvider {
  readonly #deps: UpstreamOAuthDeps;
  readonly #accountId: string;
  readonly #signIn: { state: string; pending: PendingSignIn } | null;
  /** Where to send the person's browser, once `auth` asks to redirect. */
  authorizationUrl: URL | null = null;

  constructor(
    deps: UpstreamOAuthDeps,
    accountId: string,
    signIn: { state: string; pending: PendingSignIn } | null = null,
  ) {
    this.#deps = deps;
    this.#accountId = accountId;
    this.#signIn = signIn;
  }

  get redirectUrl(): string {
    return new URL(UPSTREAM_CALLBACK_PATH, this.#deps.publicUrl).toString();
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "heel",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    if (this.#signIn === null) throw new Error("no sign-in in progress for this account");
    return this.#signIn.state;
  }

  clientInformation(): StoredOAuthClientInformation | undefined {
    return httpUpstream(this.#deps.db, this.#accountId).oauthClient as
      | StoredOAuthClientInformation
      | undefined;
  }

  saveClientInformation(info: StoredOAuthClientInformation): void {
    if ("client_secret" in info && info.client_secret !== undefined) {
      throw new Error(
        "the server registered heel as a confidential client; heel only connects as a public one",
      );
    }
    const upstream = httpUpstream(this.#deps.db, this.#accountId);
    this.#deps.db
      .update(accounts)
      .set({ settings: { ...upstream, oauthClient: info } })
      .where(eq(accounts.id, this.#accountId))
      .run();
  }

  tokens(): StoredOAuthTokens | undefined {
    let credential: ReturnType<Vault["get"]>;
    try {
      credential = this.#deps.vault.get(this.#accountId);
    } catch (error) {
      if (error instanceof VaultError && error.code === "no_credential") return undefined;
      throw error;
    }
    if (credential.type !== "oauth") return undefined;
    const now = this.#deps.now().getTime();
    return {
      access_token: credential.accessToken.reveal(),
      token_type: "Bearer",
      ...(credential.refreshToken === null
        ? {}
        : { refresh_token: credential.refreshToken.reveal() }),
      ...(credential.expiresAt === null
        ? {}
        : { expires_in: Math.max(0, Math.floor((credential.expiresAt.getTime() - now) / 1_000)) }),
      ...(credential.scope === null ? {} : { scope: credential.scope }),
    } as StoredOAuthTokens;
  }

  /** Stores new tokens in the vault, which also marks the account usable. */
  saveTokens(tokens: StoredOAuthTokens): void {
    const previous = this.tokens();
    const refreshToken = tokens.refresh_token ?? previous?.refresh_token;
    this.#deps.vault.put(this.#accountId, {
      type: "oauth",
      accessToken: tokens.access_token,
      ...(refreshToken === undefined ? {} : { refreshToken }),
      ...(tokens.expires_in === undefined
        ? {}
        : { expiresAt: this.#deps.now().getTime() + tokens.expires_in * 1_000 }),
      ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
    });
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
  }

  saveCodeVerifier(verifier: string): void {
    if (this.#signIn === null) throw new Error("no sign-in in progress for this account");
    this.#signIn.pending.verifier = verifier;
  }

  codeVerifier(): string {
    if (this.#signIn === null || this.#signIn.pending.verifier === "") {
      throw new Error("no sign-in in progress for this account");
    }
    return this.#signIn.pending.verifier;
  }
}

/**
 * Starts a sign-in for an account: discovers the server's authorization
 * server, registers heel if needed, and returns the URL to send the person's
 * browser to.
 */
export async function startUpstreamSignIn(
  deps: UpstreamOAuthDeps & { signIns: UpstreamSignIns; fetch?: FetchLike },
  account: AccountRecord,
  userId: string,
): Promise<URL> {
  const upstream = httpUpstream(deps.db, account.id);
  const state = deps.signIns.open({ accountId: account.id, userId }, deps.now());
  const pending = deps.signIns.get(state, deps.now());
  if (pending === null) throw new Error("the sign-in expired before it started");
  const provider = new UpstreamOAuthProvider(deps, account.id, { state, pending });
  const result = await auth(provider, {
    serverUrl: upstream.url,
    ...(deps.fetch === undefined ? {} : { fetchFn: deps.fetch }),
  });
  if (result !== "REDIRECT" || provider.authorizationUrl === null) {
    throw new Error("the server didn't ask for sign-in");
  }
  return provider.authorizationUrl;
}

/** Finishes a sign-in with the code the server sent back; the tokens go to the vault. */
export async function finishUpstreamSignIn(
  deps: UpstreamOAuthDeps & { fetch?: FetchLike },
  signIn: { state: string; pending: PendingSignIn },
  callback: URLSearchParams,
): Promise<void> {
  const code = callback.get("code");
  if (code === null) throw new Error(callback.get("error") ?? "the server sent no code");
  const upstream = httpUpstream(deps.db, signIn.pending.accountId);
  const provider = new UpstreamOAuthProvider(deps, signIn.pending.accountId, signIn);
  const result = await auth(provider, {
    serverUrl: upstream.url,
    authorizationCode: code,
    ...(deps.fetch === undefined ? {} : { fetchFn: deps.fetch }),
  });
  if (result !== "AUTHORIZED") throw new Error("the server didn't accept the sign-in");
}
