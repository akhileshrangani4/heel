import { randomBytes } from "node:crypto";
import type { FetchLike } from "@modelcontextprotocol/client";
import type { Hono } from "hono";
import { rulesPaths } from "../../src/config/rules.ts";
import type { BuiltInGoogleClient } from "../../src/definitions/google/builtin.ts";
import type { GoogleClient } from "../../src/definitions/google/oauth.ts";
import { UpstreamSignIns } from "../../src/definitions/mcp/upstream-oauth.ts";
import type { MicrosoftClient } from "../../src/definitions/microsoft/oauth.ts";
import { LOCAL_OWNER_NAME } from "../../src/store/install.ts";
import type { OidcClient } from "../../src/teams/oidc.ts";
import { KEY_BYTES } from "../../src/vault/crypto.ts";
import type { KeyCheck } from "../../src/vault/key-check.ts";
import { Vault } from "../../src/vault/vault.ts";
import { createHumanApp } from "../../src/web/app.ts";
import { CSRF_HEADER } from "../../src/web/http.ts";
import { createEnrollment, Passkeys, relyingPartyFor } from "../../src/web/passkeys.ts";
import { type ApprovalHarness, approvalHarness } from "./approvals.ts";
import { SoftAuthenticator } from "./authenticator.ts";
import { captureLogger } from "./log.ts";
import type { HarnessOptions } from "./pipeline.ts";

/**
 * The human plane over the same store as an approval harness, driven the
 * way a browser drives it: real HTTP requests to the Hono app, real WebAuthn
 * ceremonies signed by a software authenticator, and the session cookie and
 * CSRF token carried between requests.
 */

export const PUBLIC_URL = new URL("https://heel.example.com");
/** A stand-in VAPID public key; the human plane only hands it to the page. */
export const TEST_VAPID_PUBLIC_KEY = "BHeelTestVapidPublicKey";
/** The agent plane's public URL, so the OAuth routes (A2) are on in these tests. */
export const AGENT_URL = new URL("https://agents.heel.example.com/");
const ORIGIN = PUBLIC_URL.origin;

/** One signed-in browser: its passkey, session cookie and CSRF token. */
export interface Browser {
  authenticator: SoftAuthenticator;
  cookie: string;
  csrf: string;
  /** The whole `set-cookie` heel answered the sign-in with, attributes and all. */
  setCookie: string;
}

export interface HumanPlaneHarness extends ApprovalHarness {
  app: Hono;
  /** A vault on the harness's store. */
  vault: Vault;
  /** Sign-ins to OAuth upstreams in progress (D5c). */
  signIns: UpstreamSignIns;
  /** A request from heel's own origin, carrying a browser's cookie and CSRF header if given. */
  fetch(path: string, init?: RequestInit & { as?: Browser; csrf?: boolean }): Promise<Response>;
  /** Enrolls a passkey for `userName` through `/enroll/<token>`. */
  enroll(userName?: string): Promise<SoftAuthenticator>;
  /** Signs in through `/sign-in` and returns the signed-in browser. */
  signIn(authenticator: SoftAuthenticator): Promise<Browser>;
  /**
   * Runs a passkey ceremony: posts `start` for a challenge, signs it, and
   * posts the assertion to `finish`. Returns the finish response.
   */
  ceremony(
    as: Browser,
    start: { url: string; body: unknown },
    finish: string,
    /** Fields sent beside the signed answer, as a page's options are (a pasted key). */
    extra?: Record<string, unknown>,
  ): Promise<Response>;
}

/** What a challenge endpoint answers: the challenge id and the WebAuthn options to sign. */
export interface IssuedChallenge {
  challengeId: string;
  // biome-ignore lint/suspicious/noExplicitAny: WebAuthn options go straight to the authenticator.
  options: any;
}

/** A challenge endpoint's JSON answer. */
export async function issued(response: Response): Promise<IssuedChallenge> {
  return (await response.json()) as IssuedChallenge;
}

/** The value of one attribute in rendered HTML, e.g. `data-challenge-id`. */
export function attribute(html: string, name: string): string {
  const match = new RegExp(`${name}="([^"]*)"`).exec(html);
  if (match?.[1] === undefined) throw new Error(`no ${name} in the page`);
  return match[1];
}

export function humanPlaneHarness(
  options: HarnessOptions & {
    /** Turns on sign-in to OAuth upstreams (D5c), reaching them through this `fetch`. */
    upstreamOAuth?: { fetch: FetchLike };
    /** Turns on Gmail sign-in (D9a-1); needs `upstreamOAuth` for its fetch. */
    /** Turns on built-in mail sign-in; needs `upstreamOAuth` for its fetch. */
    providerClients?: { google?: GoogleClient; microsoft?: MicrosoftClient };
    /** Turns on team sign-in (D13b). */
    oidc?: { client: () => Promise<OidcClient>; name: string };
    /** Turns on adding proposed rules (roadmap 2.1), to the owner files under this home. */
    rulesHome?: string;
    /** Checks pasted keys (roadmap T12); none when absent, as in every other test. */
    checkKey?: (provider: string, key: string) => Promise<KeyCheck>;
    /** heel's built-in Google client (roadmap 1.14), used when `providerClients.google` is unset. */
    builtInGoogle?: BuiltInGoogleClient;
    /** What host names resolve to (connection requests check this before approval). */
    resolveHost?: (host: string) => Promise<readonly string[]>;
  } = {},
): HumanPlaneHarness {
  const h = approvalHarness(options);
  const vault = Vault.open(h.t.db, { bytes: randomBytes(KEY_BYTES), source: "test" });
  const signIns = new UpstreamSignIns();
  const { logger } = captureLogger();
  const passkeys = new Passkeys(h.t.db, relyingPartyFor(PUBLIC_URL));
  const app = createHumanApp({
    db: h.t.db,
    orgId: h.t.orgId,
    log: logger,
    publicUrl: PUBLIC_URL,
    passkeys,
    approvals: h.store,
    pauses: h.pauseStore,
    rules: h.rules,
    vapidPublicKey: TEST_VAPID_PUBLIC_KEY,
    agentPublicUrl: AGENT_URL,
    upstreamOAuth:
      options.upstreamOAuth === undefined
        ? null
        : { signIns, vault, fetch: options.upstreamOAuth.fetch },
    providerClients: {
      google: options.providerClients?.google ?? null,
      microsoft: options.providerClients?.microsoft ?? null,
    },
    watchFallback: false,
    ...(options.oidc === undefined ? {} : { oidc: options.oidc }),
    ...(options.builtInGoogle === undefined ? {} : { builtInGoogle: options.builtInGoogle }),
    // No real DNS in tests: every name resolves to a public documentation address unless a test says otherwise.
    resolveHost: options.resolveHost ?? (async () => ["93.184.216.34"]),
    ...(options.rulesHome === undefined
      ? {}
      : { ruleFiles: { paths: rulesPaths(options.rulesHome), reload: () => {} } }),
    ...(options.checkKey === undefined ? {} : { checkKey: options.checkKey }),
    now: () => h.clock.now,
  });

  const fetchAs: HumanPlaneHarness["fetch"] = async (path, init = {}) => {
    const { as, csrf = true, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (!headers.has("origin")) headers.set("origin", ORIGIN);
    if (as !== undefined) {
      headers.set("cookie", as.cookie);
      if (csrf) headers.set(CSRF_HEADER, as.csrf);
    }
    return app.request(new URL(path, PUBLIC_URL), { ...rest, headers });
  };
  const postJson = (path: string, body: unknown, as?: Browser) =>
    fetchAs(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(as !== undefined && { as }),
    });

  return Object.assign(h, {
    app,
    vault,
    signIns,
    fetch: fetchAs,

    async enroll(userName = LOCAL_OWNER_NAME) {
      const link = createEnrollment(h.t.db, {
        orgId: h.t.orgId,
        userName,
        publicUrl: PUBLIC_URL,
        now: h.clock.now,
      });
      const path = new URL(link.url).pathname;
      const options = await issued(await postJson(`${path}/options`, {}));
      const authenticator = new SoftAuthenticator();
      const done = await postJson(path, {
        challengeId: options.challengeId,
        response: authenticator.register(options.options, ORIGIN),
      });
      if (!done.ok) throw new Error(`enrollment refused: ${await done.text()}`);
      return authenticator;
    },

    async signIn(authenticator: SoftAuthenticator) {
      const page = await (await fetchAs("/sign-in")).text();
      const challengeId = attribute(page, "data-challenge-id");
      const options = await issued(await postJson("/sign-in/options", { challengeId }));
      const done = await postJson("/sign-in", {
        challengeId,
        response: authenticator.assert(options.options, ORIGIN),
      });
      if (!done.ok) throw new Error(`sign-in refused: ${await done.text()}`);
      const setCookie = done.headers.get("set-cookie") ?? "";
      const cookie = setCookie.split(";")[0] ?? "";
      const signedIn = await (await fetchAs("/pause", { headers: { cookie } })).text();
      const csrf = /const CSRF = "([^"]+)"/.exec(signedIn)?.[1];
      if (csrf === undefined) throw new Error("no CSRF token on the signed-in page");
      return { authenticator, cookie, csrf, setCookie };
    },

    async ceremony(
      as: Browser,
      start: { url: string; body: unknown },
      finish: string,
      extra: Record<string, unknown> = {},
    ) {
      const response = await postJson(start.url, start.body, as);
      if (!response.ok) return response;
      const { challengeId, options } = await issued(response);
      return postJson(
        finish,
        { challengeId, response: as.authenticator.assert(options, ORIGIN), ...extra },
        as,
      );
    },
  });
}
