import { createHash } from "node:crypto";
import {
  Client,
  type OAuthClientProvider,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { UpstreamPool } from "../../src/definitions/mcp/upstream.ts";
import { definitionRegistry } from "../../src/definitions/registry.ts";
import { createAgentApp } from "../../src/gateway/app.ts";
import { createMcpSurface } from "../../src/gateway/mcp/server.ts";
import { createPipeline } from "../../src/gateway/pipeline/pipeline.ts";
import { verifierMatches } from "../../src/oauth/rules.ts";
import { SqliteApprovalStore } from "../../src/store/approvals.ts";
import { SqlitePauseStore } from "../../src/store/pauses.ts";
import { agents, agentTokens } from "../../src/store/schema.ts";
import {
  AGENT_URL,
  type Browser,
  type HumanPlaneHarness,
  humanPlaneHarness,
  PUBLIC_URL,
} from "../helpers/human-plane.ts";
import { captureLogger } from "../helpers/log.ts";
import { compileRules } from "../helpers/pipeline.ts";

/**
 * OAuth for cloud connectors (A2), driven by the MCP SDK's own OAuth client
 * the way Claude, ChatGPT or Grok would: discovery from the agent plane's
 * 401, dynamic registration, PKCE, the person connecting with a passkey on
 * heel's page, the code exchange, and then authenticated MCP calls.
 */

const REDIRECT = "https://connector.example.com/oauth/callback";

/** heel's two planes, reached by host: agents.heel.example.com and heel.example.com. */
function planes(h: HumanPlaneHarness) {
  const { logger } = captureLogger();
  const upstream = new UpstreamPool({ vault: null, log: logger });
  const pipeline = createPipeline({
    db: h.t.db,
    rules: { set: compileRules({ owner: "rules: []\n" }) },
    definitions: definitionRegistry({ upstream, gmail: null }),
    pauses: new SqlitePauseStore(),
    approvals: new SqliteApprovalStore(),
    log: logger,
    alerts: { raise: () => {} },
    watch: false,
  });
  const agentApp = createAgentApp({
    db: h.t.db,
    log: logger,
    // The human plane issues tokens on the harness clock; the agent plane must check them on it.
    now: () => h.clock.now,
    mcp: createMcpSurface({
      db: h.t.db,
      pipeline,
      definitions: definitionRegistry({ upstream, gmail: null }),
      log: logger,
      version: "test",
    }),
    oauth: { agentPublicUrl: AGENT_URL, authorizationServer: PUBLIC_URL },
  });
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const host = new URL(request.url).host;
    if (host === AGENT_URL.host) return agentApp.fetch(request);
    if (host === PUBLIC_URL.host) return h.app.fetch(request);
    throw new Error(`no route to ${host}`);
  };
}

/** An OAuth client provider that keeps everything in memory and records where it was sent. */
function memoryProvider(): OAuthClientProvider & { authorizationUrl: URL | null } {
  let client: unknown;
  let tokens: unknown;
  let verifier = "";
  return {
    authorizationUrl: null,
    get redirectUrl() {
      return REDIRECT;
    },
    get clientMetadata() {
      return {
        client_name: "Claude",
        redirect_uris: [REDIRECT],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },
    clientInformation: () => client as never,
    saveClientInformation: (info) => {
      client = info;
    },
    tokens: () => tokens as never,
    saveTokens: (saved) => {
      tokens = saved;
    },
    redirectToAuthorization(url) {
      this.authorizationUrl = url;
    },
    saveCodeVerifier: (saved) => {
      verifier = saved;
    },
    codeVerifier: () => verifier,
  };
}

/** What the person does in the browser: open the authorize URL, connect with a passkey. */
async function consent(h: HumanPlaneHarness, owner: Browser, url: URL): Promise<URL> {
  const page = await h.fetch(url.pathname + url.search, { as: owner });
  expect(await page.text()).toContain("Connect Claude?");
  const q = url.searchParams;
  const done = await h.ceremony(
    owner,
    {
      url: "/oauth/authorize/challenge",
      body: {
        clientId: q.get("client_id"),
        redirectUri: q.get("redirect_uri"),
        codeChallenge: q.get("code_challenge"),
        state: q.get("state") ?? "",
        resource: q.get("resource") ?? AGENT_URL.toString(),
      },
    },
    "/oauth/authorize/confirm",
  );
  expect(done.status).toBe(200);
  return new URL(((await done.json()) as { next: string }).next);
}

describe("connecting a cloud agent with OAuth", () => {
  it("runs the MCP SDK's OAuth flow end to end: register, consent with a passkey, exchange, call", async () => {
    const h = humanPlaneHarness();
    const owner = await h.signIn(await h.enroll());
    const fetch = planes(h);
    const provider = memoryProvider();
    const mcpUrl = new URL("/mcp?tools=direct", AGENT_URL);

    // 1. The first connect is refused and sends the person to heel's consent page.
    const first = new StreamableHTTPClientTransport(mcpUrl, { fetch, authProvider: provider });
    await expect(new Client({ name: "claude", version: "1" }).connect(first)).rejects.toThrow(
      UnauthorizedError,
    );
    const authorizationUrl = provider.authorizationUrl;
    if (authorizationUrl === null) throw new Error("the client was never sent to authorize");
    expect(authorizationUrl.origin).toBe(PUBLIC_URL.origin);

    // 2. They connect with a passkey; heel sends the app back with a code.
    const callback = await consent(h, owner, authorizationUrl);
    expect(callback.origin + callback.pathname).toBe(REDIRECT);
    await first.finishAuth(callback.searchParams);

    // 3. The app reconnects with its token and lists tools as the new agent.
    const client = new Client({ name: "claude", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(mcpUrl, { fetch, authProvider: provider }),
    );
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("heel_status");
    expect(h.t.db.select({ name: agents.name }).from(agents).all()).toContainEqual({
      name: "claude",
    });
  });

  it("names the authorization server in every 401 and in the protected-resource metadata", async () => {
    const h = humanPlaneHarness();
    const fetch = planes(h);

    const refused = await fetch(new URL("/mcp?tools=direct", AGENT_URL), { method: "POST" });
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://agents.heel.example.com/.well-known/oauth-protected-resource"',
    );

    const metadata = await (
      await fetch(new URL("/.well-known/oauth-protected-resource/mcp", AGENT_URL))
    ).json();
    expect(metadata).toMatchObject({
      resource: "https://agents.heel.example.com/mcp",
      authorization_servers: [PUBLIC_URL.origin],
    });
    const server = await (
      await fetch(new URL("/.well-known/oauth-authorization-server", PUBLIC_URL))
    ).json();
    expect(server).toMatchObject({ code_challenge_methods_supported: ["S256"] });
  });
});

describe("the token endpoint", () => {
  /** Registers a client and runs consent by hand, returning a code and its verifier. */
  async function codeFor(h: HumanPlaneHarness, owner: Browser) {
    const registered = await h.fetch("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] }),
    });
    const { client_id: clientId } = (await registered.json()) as { client_id: string };
    const verifier = "v".repeat(64);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    expect(verifierMatches(verifier, challenge)).toBe(true);
    const authorize = new URL("/oauth/authorize", PUBLIC_URL);
    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "s1",
    })) {
      authorize.searchParams.set(key, value);
    }
    const callback = await consent(h, owner, authorize);
    return { clientId, verifier, code: callback.searchParams.get("code") ?? "" };
  }

  function token(h: HumanPlaneHarness, fields: Record<string, string>) {
    return h.fetch("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "" },
      body: new URLSearchParams(fields).toString(),
    });
  }

  it("trades a code once, only with its verifier, and rotates refresh tokens", async () => {
    const h = humanPlaneHarness();
    const owner = await h.signIn(await h.enroll());
    const { clientId, verifier, code } = await codeFor(h, owner);
    const exchange = {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: REDIRECT,
    };

    expect((await token(h, { ...exchange, code_verifier: "w".repeat(64) })).status).toBe(400);
    const pair = (await (await token(h, { ...exchange, code_verifier: verifier })).json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    expect(pair.expires_in).toBe(3_600);
    // A code works once.
    expect((await token(h, { ...exchange, code_verifier: verifier })).status).toBe(400);

    const refreshed = await token(h, {
      grant_type: "refresh_token",
      refresh_token: pair.refresh_token,
    });
    expect(refreshed.status).toBe(200);
    // The old refresh token is spent.
    expect(
      (await token(h, { grant_type: "refresh_token", refresh_token: pair.refresh_token })).status,
    ).toBe(400);
    expect(
      h.t.db
        .select({ kind: agentTokens.kind })
        .from(agentTokens)
        .all()
        .map((t) => t.kind)
        .sort(),
    ).toEqual(["oauth_access", "oauth_access", "oauth_refresh", "oauth_refresh"]);
  });

  it("I-03: a refresh token never authenticates a call, and an access token stops at its expiry", async () => {
    const h = humanPlaneHarness();
    const owner = await h.signIn(await h.enroll());
    const { clientId, verifier, code } = await codeFor(h, owner);
    const pair = (await (
      await token(h, {
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      })
    ).json()) as { access_token: string; refresh_token: string };
    const fetch = planes(h);
    const call = (bearer: string) =>
      fetch(new URL("/approvals/apr_x", AGENT_URL), {
        headers: { authorization: `Bearer ${bearer}` },
      });

    expect((await call(pair.access_token)).status).toBe(404);
    expect((await call(pair.refresh_token)).status).toBe(401);
    h.clock.advance(60 * 60_000);
    expect((await call(pair.access_token)).status).toBe(401);
  });

  it("refuses a redirect URI the client didn't register, without redirecting there", async () => {
    const h = humanPlaneHarness();
    const owner = await h.signIn(await h.enroll());
    const registered = await h.fetch("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] }),
    });
    const { client_id } = (await registered.json()) as { client_id: string };

    const page = await h.fetch(
      `/oauth/authorize?client_id=${client_id}&redirect_uri=${encodeURIComponent("https://evil.example/cb")}&code_challenge=${"a".repeat(43)}&code_challenge_method=S256`,
      { as: owner },
    );

    expect(page.status).toBe(200);
    expect(await page.text()).toContain("asked to return somewhere");
  });

  it("refuses to register a client that isn't public, or redirects over plain http", async () => {
    const h = humanPlaneHarness();
    const register = (body: unknown) =>
      h.fetch("/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "" },
        body: JSON.stringify(body),
      });
    expect(
      (
        await register({
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: "client_secret_basic",
        })
      ).status,
    ).toBe(400);
    expect((await register({ redirect_uris: ["http://evil.example/cb"] })).status).toBe(400);
  });

  it("an app that registers again under the same name stays the same agent (Codex signs in that way)", async () => {
    const h = humanPlaneHarness();
    const owner = await h.signIn(await h.enroll());
    const fetch = planes(h);
    const mcpUrl = new URL("/mcp?tools=direct", AGENT_URL);

    async function signIn(provider: ReturnType<typeof memoryProvider>, replacing: boolean) {
      const transport = new StreamableHTTPClientTransport(mcpUrl, {
        fetch,
        authProvider: provider,
      });
      await expect(new Client({ name: "c", version: "1" }).connect(transport)).rejects.toThrow(
        UnauthorizedError,
      );
      const url = provider.authorizationUrl;
      if (url === null) throw new Error("never sent to authorize");
      const page = await (await h.fetch(url.pathname + url.search, { as: owner })).text();
      expect(page.includes("signed in as claude before")).toBe(replacing);
      await transport.finishAuth((await consent(h, owner, url)).searchParams);
    }
    async function listsTools(provider: ReturnType<typeof memoryProvider>) {
      const client = new Client({ name: "c", version: "1" });
      try {
        await client.connect(
          new StreamableHTTPClientTransport(mcpUrl, { fetch, authProvider: provider }),
        );
        await client.listTools();
        return true;
      } catch {
        return false;
      }
    }

    const first = memoryProvider();
    await signIn(first, false);
    const second = memoryProvider();
    await signIn(second, true);
    const names = h.t.db
      .select({ name: agents.name })
      .from(agents)
      .all()
      .map((a) => a.name);
    expect(names.filter((n) => n.startsWith("claude"))).toEqual(["claude"]);
    expect(await listsTools(second)).toBe(true);
    // The earlier sign-in stops working.
    first.authorizationUrl = null;
    expect(await listsTools(first)).toBe(false);
  });

  it("names on the consent page the agent the passkey will really connect (red-team round 3)", async () => {
    const h = humanPlaneHarness();
    const owner = await h.signIn(await h.enroll());
    // Any app can register under any name, including an existing agent's.
    const registered = await h.fetch("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "" },
      body: JSON.stringify({ client_name: "inbox-bot", redirect_uris: [REDIRECT] }),
    });
    const { client_id: clientId } = (await registered.json()) as { client_id: string };
    const authorize = new URL("/oauth/authorize", PUBLIC_URL);
    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: "c".repeat(43),
      code_challenge_method: "S256",
      state: "s1",
    })) {
      authorize.searchParams.set(key, value);
    }
    const page = await (await h.fetch(authorize.pathname + authorize.search, { as: owner })).text();
    const said = page.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
    expect(said).toContain("as a new agent inbox-bot-2.");
    expect(said).not.toContain("as a new agent inbox-bot.");
  });
});
