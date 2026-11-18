import { describe, expect, it, onTestFinished } from "vitest";
import { mcpPassthrough } from "../../src/definitions/mcp/passthrough.ts";
import { upstreamSettings } from "../../src/definitions/mcp/settings.ts";
import { UpstreamPool } from "../../src/definitions/mcp/upstream.ts";
import { UPSTREAM_CALLBACK_PATH } from "../../src/definitions/mcp/upstream-oauth.ts";
import { findAccount } from "../../src/store/directory.ts";
import { ConnectError, connectAccount } from "../../src/vault/connect.ts";
import { humanPlaneHarness, PUBLIC_URL } from "../helpers/human-plane.ts";
import { captureLogger } from "../helpers/log.ts";
import { oauthUpstream, UPSTREAM_MCP_URL } from "../helpers/oauth-upstream.ts";

/**
 * Remote MCP servers that want OAuth sign-in (D5c): the owner signs in from
 * the Connections page, heel keeps the tokens in its vault, and calls go
 * upstream with them. The upstream here is a fake with its own
 * authorization server; heel uses the MCP SDK's OAuth client against it.
 */

function form(fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  };
}

function setUp() {
  const upstream = oauthUpstream();
  const h = humanPlaneHarness({ upstreamOAuth: { fetch: upstream.fetch } });
  connectAccount(
    h.t.db,
    h.vault,
    {
      orgId: h.t.orgId,
      ownerId: h.t.ownerId,
      provider: "mcp",
      alias: "linear",
      url: UPSTREAM_MCP_URL,
      oauth: true,
    },
    new Date(),
  );
  const pool = new UpstreamPool({
    vault: h.vault,
    log: captureLogger().logger,
    fetch: upstream.fetch,
    oauth: { db: h.t.db, vault: h.vault, publicUrl: PUBLIC_URL, now: () => h.clock.now },
  });
  onTestFinished(() => pool.close());
  return { h, upstream, pool };
}

/** The browser's part: start on Connections, follow the server's consent redirect, land on heel's callback. */
async function signIn(
  h: ReturnType<typeof setUp>["h"],
  upstream: ReturnType<typeof setUp>["upstream"],
  as: Awaited<ReturnType<typeof h.signIn>>,
) {
  const started = await h.fetch("/connections/sign-in", {
    as,
    ...form({ csrf: as.csrf, alias: "linear" }),
  });
  expect(started.status).toBe(303);
  const authorize = started.headers.get("location") ?? "";
  expect(new URL(authorize).origin).toBe("https://auth.upstream.test");
  const consented = await upstream.fetch(authorize);
  const callback = new URL(consented.headers.get("location") ?? "");
  expect(callback.origin + callback.pathname).toBe(
    new URL(UPSTREAM_CALLBACK_PATH, PUBLIC_URL).toString(),
  );
  return callback;
}

describe("remote MCP servers that want OAuth sign-in", () => {
  it("need their owner to sign in first; calls are denied until then", async () => {
    const { h } = setUp();
    const owner = await h.signIn(await h.enroll());
    expect(findAccount(h.t.db, h.t.orgId, "linear")?.status).toBe("reconnect_required");
    const page = await (await h.fetch("/connections", { as: owner })).text();
    expect(page).toContain("Needs sign-in");
  });

  it("I-02: signing in keeps the tokens in the vault, and calls go upstream with them, scrubbed", async () => {
    const { h, upstream, pool } = setUp();
    const owner = await h.signIn(await h.enroll());

    const callback = await signIn(h, upstream, owner);
    const landed = await h.fetch(callback.pathname + callback.search, { as: owner });
    expect(landed.headers.get("location")).toMatch(/connected=1/);

    const account = findAccount(h.t.db, h.t.orgId, "linear");
    if (account === null) throw new Error("no account");
    expect(account.status).toBe("active");
    // What the server registered heel as is public, and stored with the account; tokens aren't.
    expect(upstreamSettings(account.settings)).toMatchObject({
      oauth: true,
      oauthClient: { client_id: "client-1" },
    });
    expect(JSON.stringify(account.settings)).not.toMatch(/upstream-access|upstream-refresh/);
    expect(h.vault.get(account.id).type).toBe("oauth");

    const signal = AbortSignal.timeout(10_000);
    expect((await pool.listTools(account, signal)).map((tool) => tool.name)).toEqual(["echo_auth"]);
    const result = await mcpPassthrough(account, pool).execute(
      {
        orgId: account.orgId,
        agentId: "agt_test",
        ownerId: account.ownerId,
        surface: "mcp",
        account: "linear",
        provider: account.provider,
        tool: "echo_auth",
        args: {},
        items: 1,
      },
      signal,
    );
    expect(result).toMatchObject({ content: [{ text: "auth: Bearer [redacted by heel]" }] });
    expect(JSON.stringify(result)).not.toMatch(/upstream-access/);
  });

  it("lets only the person who started a sign-in finish it, once", async () => {
    const { h, upstream } = setUp();
    const owner = await h.signIn(await h.enroll());
    h.addUser("sam", "member");
    const sam = await h.signIn(await h.enroll("sam"));

    const callback = await signIn(h, upstream, owner);
    const stolen = await h.fetch(callback.pathname + callback.search, { as: sam });
    expect(stolen.headers.get("location")).toMatch(/failed=/);
    // The stolen attempt used the state up: the owner has to start again.
    const late = await h.fetch(callback.pathname + callback.search, { as: owner });
    expect(late.headers.get("location")).toMatch(/failed=/);
    expect(findAccount(h.t.db, h.t.orgId, "linear")?.status).toBe("reconnect_required");
  });

  it("refuses --oauth with a token, or on a local server", () => {
    const { h } = setUp();
    const connect = (input: Partial<Parameters<typeof connectAccount>[2]>) => () =>
      connectAccount(
        h.t.db,
        h.vault,
        { orgId: h.t.orgId, ownerId: h.t.ownerId, provider: "mcp", alias: "x", ...input },
        new Date(),
      );
    expect(
      connect({ url: UPSTREAM_MCP_URL, oauth: true, credential: { type: "static", value: "t" } }),
    ).toThrow(ConnectError);
    expect(
      connect({
        stdio: { command: "/usr/bin/true", args: [], egress: [], credentialEnv: null, mounts: [] },
        oauth: true,
      }),
    ).toThrow(/remote/);
  });
});
