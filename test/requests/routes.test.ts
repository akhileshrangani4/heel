import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { revokeAgent } from "../../src/gateway/agents.ts";
import { findRequest, requestConnection } from "../../src/requests/connection.ts";
import { accounts } from "../../src/store/schema.ts";
import type { KeyCheck } from "../../src/vault/key-check.ts";
import { removeAccount } from "../../src/vault/manage.ts";
import { attribute, humanPlaneHarness } from "../helpers/human-plane.ts";
import { oneRule } from "../helpers/pipeline.ts";

/** Connection requests on the human plane (roadmap 2.5): only the agent's owner sees and decides them. */

const READS = oneRule("{ kind: read }", "allow");

function setUp(
  details: Parameters<typeof requestConnection>[2] = {
    service: "gmail",
    alias: "inbox-new",
    why: "so I can triage your work mail",
  },
  checkKey?: (provider: string, key: string) => Promise<KeyCheck>,
) {
  let fetched = 0;
  const h = humanPlaneHarness({
    owner: READS,
    ...(checkKey === undefined ? {} : { checkKey }),
    upstreamOAuth: {
      fetch: async () => {
        fetched++;
        return new Response("{}", { status: 500 });
      },
    },
  });
  const asked = requestConnection(
    h.t.db,
    { orgId: h.t.orgId, ownerId: h.t.ownerId, agentId: h.agent.agentId },
    details,
    h.clock.now,
  );
  if (!asked.ok) throw new Error(asked.problem);
  return { h, id: asked.requestId, fetched: () => fetched };
}

const accountNamed = (h: ReturnType<typeof humanPlaneHarness>, alias: string) =>
  h.t.db.select().from(accounts).where(eq(accounts.alias, alias)).get();

describe("connection requests on the approval page", () => {
  it("shows the request in heel's words and what the owner's rules would let the agent do", async () => {
    const { h, id } = setUp();
    const owner = await h.signIn(await h.enroll());
    const list = await (await h.fetch("/approvals", { as: owner })).text();
    expect(list).toContain("wants to connect <mark>Gmail</mark>");
    const page = await (await h.fetch(`/requests/${id}`, { as: owner })).text();
    expect(page).toContain("wants to connect Gmail");
    expect(page).toContain("inbox-new");
    expect(page).toMatch(/its own words; heel didn(&#39;|')t check them/);
    // The owner's read rule names no account, so it covers the new one: say so.
    expect(page).toContain("These rules cover every account");
    expect(page).toContain("Runs on its own");
  });

  it("connects it with a passkey, from the stored request, and only then", async () => {
    const { h, id, fetched } = setUp();
    const owner = await h.signIn(await h.enroll());
    const page = await (await h.fetch(`/requests/${id}`, { as: owner })).text();
    expect(accountNamed(h, "inbox-new")).toBeUndefined();

    const added = await h.ceremony(
      owner,
      { url: "/requests/challenge", body: { requestId: id, hash: attribute(page, "data-hash") } },
      "/requests/confirm",
    );
    expect(added.status).toBe(200);
    expect(accountNamed(h, "inbox-new")).toMatchObject({
      provider: "gmail",
      ownerId: h.t.ownerId,
      status: "reconnect_required",
    });
    expect(findRequest(h.t.db, h.t.orgId, id)).toMatchObject({ status: "approved" });
    // Gmail signs in next, on heel's own page: the request page offers it.
    const after = await (await h.fetch(`/requests/${id}?approved`, { as: owner })).text();
    expect(after).toContain("Sign in to Gmail");
    expect(fetched()).toBe(0);
  });

  it("contacts an MCP server the agent named only after approval", async () => {
    const { h, id, fetched } = setUp({
      service: "mcp",
      alias: "tracker-new",
      url: "https://mcp.example.com/mcp",
      why: "to read your tickets",
    });
    const owner = await h.signIn(await h.enroll());
    const page = await (await h.fetch(`/requests/${id}`, { as: owner })).text();
    expect(page).toContain("the MCP server at mcp.example.com");
    expect(page).toContain("https://mcp.example.com/mcp");
    await h.ceremony(
      owner,
      { url: "/requests/challenge", body: { requestId: id, hash: attribute(page, "data-hash") } },
      "/requests/confirm",
    );
    expect(accountNamed(h, "tracker-new")).toMatchObject({
      provider: "mcp:tracker-new",
      // heel contacts it, its redirects and its sign-in only on public hosts.
      settings: { publicOnly: true },
    });
    expect(fetched()).toBe(0);
  });

  it("won't connect over a name that's taken, and says so to the owner only", async () => {
    // The harness already has a gmail-work account.
    const { h, id } = setUp({ service: "gmail", alias: "gmail-work" });
    const owner = await h.signIn(await h.enroll());
    const page = await (await h.fetch(`/requests/${id}`, { as: owner })).text();
    expect(page).toContain("already has an account named gmail-work");
    expect(page).not.toContain("data-hash");
  });

  it("someone else can't see, connect or reject it; rejecting connects nothing", async () => {
    const { h, id } = setUp();
    const owner = await h.signIn(await h.enroll());
    h.addUser("sam", "admin");
    const sam = await h.signIn(await h.enroll("sam"));
    expect((await h.fetch(`/requests/${id}`, { as: sam })).status).toBe(404);
    const challenge = await h.fetch("/requests/challenge", {
      as: sam,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: id, hash: "x" }),
    });
    expect(challenge.status).toBe(404);

    const rejected = await h.fetch(`/requests/${id}/reject`, {
      as: owner,
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: owner.csrf }).toString(),
    });
    expect(rejected.status).toBe(303);
    expect(findRequest(h.t.db, h.t.orgId, id)?.status).toBe("rejected");
    expect(accountNamed(h, "inbox-new")).toBeUndefined();
  });
});

describe("what an agent can't do with a connection request", () => {
  it("can't name a host that resolves inside the network; heel checks before approving", async () => {
    let fetched = 0;
    const h = humanPlaneHarness({
      owner: READS,
      upstreamOAuth: {
        fetch: async () => {
          fetched++;
          return new Response("{}");
        },
      },
      resolveHost: async () => ["10.0.0.5"],
    });
    const asked = requestConnection(
      h.t.db,
      { orgId: h.t.orgId, ownerId: h.t.ownerId, agentId: h.agent.agentId },
      { service: "mcp", alias: "looks-public", url: "https://mcp.looks-public.example/mcp" },
      h.clock.now,
    );
    if (!asked.ok) throw new Error(asked.problem);
    const owner = await h.signIn(await h.enroll());
    const page = await (await h.fetch(`/requests/${asked.requestId}`, { as: owner })).text();
    const done = await h.ceremony(
      owner,
      {
        url: "/requests/challenge",
        body: { requestId: asked.requestId, hash: attribute(page, "data-hash") },
      },
      "/requests/confirm",
    );
    expect(done.status).toBe(409);
    expect(await done.text()).toContain("private address");
    expect(accountNamed(h, "looks-public")).toBeUndefined();
    expect(findRequest(h.t.db, h.t.orgId, asked.requestId)?.status).toBe("pending");
    expect(fetched).toBe(0);
  });

  it("an account made from a request can be removed, and the request keeps its history", async () => {
    const { h, id } = setUp();
    const owner = await h.signIn(await h.enroll());
    const page = await (await h.fetch(`/requests/${id}`, { as: owner })).text();
    await h.ceremony(
      owner,
      { url: "/requests/challenge", body: { requestId: id, hash: attribute(page, "data-hash") } },
      "/requests/confirm",
    );
    expect(accountNamed(h, "inbox-new")).toBeDefined();
    removeAccount(h.t.db, h.t.orgId, "inbox-new", h.clock.now);
    expect(accountNamed(h, "inbox-new")).toBeUndefined();
    expect(findRequest(h.t.db, h.t.orgId, id)).toMatchObject({
      status: "approved",
      accountId: null,
    });
  });

  it("a revoked agent's request can't be connected", async () => {
    const { h, id } = setUp();
    revokeAgent(h.t.db, h.t.orgId, h.agent.agentName, h.clock.now);
    const owner = await h.signIn(await h.enroll());
    const page = await (await h.fetch(`/requests/${id}`, { as: owner })).text();
    expect(page).toContain("has been revoked");
    expect(page).not.toContain("data-hash");
  });
});

describe("services that use a pasted key (2.5, part 2)", () => {
  const KEY = "ghp_pasted-on-heels-page-only";

  it("asks the owner for the key on the page, and stores it in the vault only", async () => {
    const { h, id } = setUp({ service: "github", alias: "gh-new", why: "to read your PRs" });
    const owner = await h.signIn(await h.enroll());
    const page = await (await h.fetch(`/requests/${id}`, { as: owner })).text();
    expect(page).toContain("wants to connect GitHub");
    expect(page).toContain('name="key"');
    expect(page).toContain("gh auth token");
    expect(page).toContain('data-heel-options="request-key"');

    const done = await h.ceremony(
      owner,
      { url: "/requests/challenge", body: { requestId: id, hash: attribute(page, "data-hash") } },
      "/requests/confirm",
      { key: KEY },
    );
    expect(done.status).toBe(200);
    const answer = await done.text();
    expect(answer).not.toContain(KEY);
    const account = accountNamed(h, "gh-new");
    expect(account).toMatchObject({ provider: "github", status: "active" });
    expect(h.vault.get(account?.id ?? "")).toMatchObject({ type: "static" });
    expect(JSON.stringify(findRequest(h.t.db, h.t.orgId, id))).not.toContain(KEY);
    const after = await (await h.fetch(`/requests/${id}?approved`, { as: owner })).text();
    expect(after).toContain("is connected");
    expect(after).not.toContain(KEY);
  });

  it("won't store a key the service rejects; the request keeps waiting for a good one", async () => {
    const asked: string[] = [];
    const { h, id } = setUp({ service: "github", alias: "gh-new" }, async (provider, key) => {
      asked.push(`${provider}:${key}`);
      return key === KEY
        ? { status: "ok" }
        : { status: "rejected", message: "GitHub rejected this key (wrong, expired or revoked)" };
    });
    const owner = await h.signIn(await h.enroll());
    const page = await (await h.fetch(`/requests/${id}`, { as: owner })).text();
    const bad = await h.ceremony(
      owner,
      { url: "/requests/challenge", body: { requestId: id, hash: attribute(page, "data-hash") } },
      "/requests/confirm",
      { key: "ghp_placeholder" },
    );
    expect(bad.status).toBe(409);
    expect(await bad.text()).toContain("GitHub rejected this key");
    expect(accountNamed(h, "gh-new")).toBeUndefined();
    expect(findRequest(h.t.db, h.t.orgId, id)?.status).toBe("pending");

    const good = await h.ceremony(
      owner,
      { url: "/requests/challenge", body: { requestId: id, hash: attribute(page, "data-hash") } },
      "/requests/confirm",
      { key: KEY },
    );
    expect(good.status).toBe(200);
    expect(accountNamed(h, "gh-new")).toMatchObject({ status: "active" });
    expect(asked).toEqual(["github:ghp_placeholder", `github:${KEY}`]);
  });

  it("connects a key heel couldn't check, and says so", async () => {
    const { h, id } = setUp({ service: "notion", alias: "notion-new" }, async () => ({
      status: "unchecked",
      message: "heel couldn't check this key",
    }));
    const owner = await h.signIn(await h.enroll());
    const page = await (await h.fetch(`/requests/${id}`, { as: owner })).text();
    const done = await h.ceremony(
      owner,
      { url: "/requests/challenge", body: { requestId: id, hash: attribute(page, "data-hash") } },
      "/requests/confirm",
      { key: KEY },
    );
    expect(done.status).toBe(200);
    const next = ((await done.json()) as { next: string }).next;
    expect(next).toContain("unchecked");
    const after = await (await h.fetch(next, { as: owner })).text();
    expect(after).toContain("so it connected it as it is");
  });

  it("won't connect without a key, and the request keeps waiting", async () => {
    const { h, id } = setUp({ service: "stripe", alias: "stripe-new" });
    const owner = await h.signIn(await h.enroll());
    const page = await (await h.fetch(`/requests/${id}`, { as: owner })).text();
    expect(page).toContain("rk_");
    const done = await h.ceremony(
      owner,
      { url: "/requests/challenge", body: { requestId: id, hash: attribute(page, "data-hash") } },
      "/requests/confirm",
    );
    expect(done.status).toBe(400);
    expect(accountNamed(h, "stripe-new")).toBeUndefined();
    expect(findRequest(h.t.db, h.t.orgId, id)?.status).toBe("pending");
  });

  it("a sign-in service takes no key, even if one is sent", async () => {
    const { h, id } = setUp();
    const owner = await h.signIn(await h.enroll());
    const page = await (await h.fetch(`/requests/${id}`, { as: owner })).text();
    expect(page).not.toContain('name="key"');
    await h.ceremony(
      owner,
      { url: "/requests/challenge", body: { requestId: id, hash: attribute(page, "data-hash") } },
      "/requests/confirm",
      { key: "should-be-ignored" },
    );
    const account = accountNamed(h, "inbox-new");
    expect(account?.status).toBe("reconnect_required");
  });
});
