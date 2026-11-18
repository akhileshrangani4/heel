import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { githubRest } from "../../src/definitions/http/rest.ts";
import { UpstreamPool } from "../../src/definitions/mcp/upstream.ts";
import { definitionRegistry } from "../../src/definitions/registry.ts";
import { addAgent } from "../../src/gateway/agents.ts";
import { createAgentApp } from "../../src/gateway/app.ts";
import { createPipeline } from "../../src/gateway/pipeline/pipeline.ts";
import { SqliteApprovalStore } from "../../src/store/approvals.ts";
import { SqlitePauseStore } from "../../src/store/pauses.ts";
import { KEY_BYTES } from "../../src/vault/crypto.ts";
import { Vault } from "../../src/vault/vault.ts";
import { captureLogger } from "../helpers/log.ts";
import { compileRules } from "../helpers/pipeline.ts";
import { addAccount, testStore } from "../helpers/store.ts";

/** GitHub's REST paths through the HTTP proxy (D7b part two): heel's own GitHub tools, or `github.api`. */

const HEAD = "c".repeat(40);
const TOKEN = "github-test-token-not-real";

function fakeGitHub() {
  const sent: { method: string; path: string; body: unknown }[] = [];
  const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input.toString());
    const method = init?.method ?? "GET";
    sent.push({
      method,
      path: url.pathname,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const p = url.pathname;
    if (method === "GET" && /^\/repos\/acme\/web\/pulls\/\d+$/.test(p)) {
      return Response.json({
        number: 12,
        state: "open",
        merged: false,
        head: { sha: HEAD },
        base: { ref: "main" },
      });
    }
    if (p.endsWith("/files"))
      return Response.json(url.searchParams.get("page") === "1" ? [{ filename: "a.ts" }] : []);
    if (p.endsWith("/check-runs"))
      return Response.json({
        total_count: 1,
        check_runs: [{ name: "ci", status: "completed", conclusion: "success" }],
      });
    if (p.endsWith("/check-suites")) return Response.json({ total_count: 0, check_suites: [] });
    if (p.endsWith("/status"))
      return Response.json({ state: "pending", total_count: 0, statuses: [] });
    if (p.includes("/rules/branches/")) return Response.json([]);
    if (method === "PUT" && p.endsWith("/merge")) return Response.json({ merged: true });
    if (method === "POST" && p.endsWith("/comments"))
      return Response.json({ id: 1, html_url: "u" }, { status: 201 });
    if (p === "/repos/acme/web/hooks") return Response.json({ id: 9 }, { status: 201 });
    return Response.json({}, { status: 404 });
  };
  return { fetch, sent };
}

function setUp(owner: string) {
  const t = testStore();
  const gh = fakeGitHub();
  const accountId = addAccount(t, "github", "github");
  const vault = Vault.open(t.db, { bytes: randomBytes(KEY_BYTES), source: "test" });
  vault.put(accountId, { type: "static", value: TOKEN });
  const { logger } = captureLogger();
  const pipeline = createPipeline({
    db: t.db,
    rules: { set: compileRules({ owner }) },
    definitions: definitionRegistry({
      upstream: new UpstreamPool({ vault: null, log: logger }),
      gmail: null,
      github: { vault, fetch: gh.fetch },
    }),
    pauses: new SqlitePauseStore(),
    approvals: new SqliteApprovalStore(),
    log: logger,
    alerts: { raise: () => {} },
    watch: false,
  });
  const app = createAgentApp({ db: t.db, log: logger, http: { db: t.db, pipeline, log: logger } });
  const { token } = addAgent(t.db, { orgId: t.orgId, ownerId: t.ownerId, name: "bot" }, new Date());
  const request = (path: string, method = "GET", body?: unknown) =>
    app.request(new URL(path, "http://localhost"), {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { request, sent: gh.sent };
}

const RULES = `rules:
  - match: { action: github.merge, repo: acme/web, checks: passing }
    then: allow
  - match: { action: github.comment, repo: acme/web }
    then: allow
  - match: { repo: acme/web }
    then: allow
`;

describe("GitHub's REST paths", () => {
  it("merge through PUT .../merge, pinned to the head heel read", async () => {
    const h = setUp(RULES);
    const response = await h.request("/http/github/repos/acme/web/pulls/12/merge", "PUT", {
      merge_method: "squash",
    });
    expect(response.status).toBe(200);
    expect(h.sent.find((s) => s.method === "PUT")?.body).toMatchObject({
      sha: HEAD,
      merge_method: "squash",
    });
  });

  it("refuse a merge whose sha isn't the head", async () => {
    const h = setUp(RULES);
    const response = await h.request("/http/github/repos/acme/web/pulls/12/merge", "PUT", {
      sha: "d".repeat(40),
    });
    expect(response.status).toBe(403);
    expect(h.sent.some((s) => s.method === "PUT")).toBe(false);
  });

  it("comment through POST .../issues/{n}/comments", async () => {
    const h = setUp(RULES);
    const response = await h.request("/http/github/repos/acme/web/issues/12/comments", "POST", {
      body: "lgtm",
    });
    expect(response.status).toBe(200);
  });

  it("send an unmapped path as github.api, which a broad allow doesn't cover", async () => {
    const h = setUp(RULES);
    const response = await h.request("/http/github/repos/acme/web/hooks", "POST", {
      config: { url: "https://evil.example" },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ reason: "persistence_unnamed" });
    expect(h.sent).toEqual([]);
  });

  it("send github.api when a rule names it", async () => {
    const h = setUp("rules:\n  - match: { action: github.api }\n    then: allow\n");
    const response = await h.request("/http/github/repos/acme/web/hooks", "POST", { config: {} });
    expect(response.status).toBe(200);
    expect(h.sent[0]).toMatchObject({ method: "POST", path: "/repos/acme/web/hooks" });
  });

  it("refuse a mapped route carrying a field the tool doesn't take", () => {
    expect(
      githubRest({
        method: "PUT",
        path: "/repos/acme/web/pulls/1/merge",
        query: {},
        json: { merge_method: "merge", bypass: true },
      }),
    ).toBeNull();
    expect(
      githubRest({ method: "GET", path: "/repos/acme/web/pulls", query: { page: "x" } }),
    ).toBeNull();
  });
});

describe("github_api over MCP", () => {
  function mcp(owner: string) {
    const t = testStore();
    const gh = fakeGitHub();
    const accountId = addAccount(t, "github", "github");
    const vault = Vault.open(t.db, { bytes: randomBytes(KEY_BYTES), source: "test" });
    vault.put(accountId, { type: "static", value: TOKEN });
    const { logger } = captureLogger();
    const pipeline = createPipeline({
      db: t.db,
      rules: { set: compileRules({ owner }) },
      definitions: definitionRegistry({
        upstream: new UpstreamPool({ vault: null, log: logger }),
        gmail: null,
        github: { vault, fetch: gh.fetch },
      }),
      pauses: new SqlitePauseStore(),
      approvals: new SqliteApprovalStore(),
      log: logger,
      alerts: { raise: () => {} },
      watch: false,
    });
    const { agentId } = addAgent(
      t.db,
      { orgId: t.orgId, ownerId: t.ownerId, name: "bot" },
      new Date(),
    );
    const agent = {
      orgId: t.orgId,
      agentId,
      agentName: "bot",
      ownerId: t.ownerId,
      tokenId: "tok_1",
    };
    const call = (args: Record<string, unknown>) =>
      pipeline.run({ agent, surface: "mcp", account: "github", tool: "github_api", args });
    return { call, sent: gh.sent };
  }

  const NAMED =
    'rules:\n  - match: { action: github.api, args.path: { matches: "/repos/acme/web/.*" } }\n    then: allow\n';

  it.each([
    "/repos/acme/web/../../../user/keys",
    "/repos/acme/web/%2e%2e/%2e%2e/%2e%2e/graphql",
    "/repos/acme/web//hooks",
    "/graphql",
    "/repositories/123/pulls/1/merge",
    "/repos/acme/web/pulls/12/merge",
    "/repos/acme/web/pulls/01/merge",
    "/repos/acme/web/contents/.github/workflows/x.yml",
  ])("refuses %s", async (path) => {
    const h = mcp(NAMED);
    const result = await h.call({ method: "PUT", path, query: {} });
    expect(result).toMatchObject({ status: "denied", reason: "unsupported" });
    expect(h.sent).toEqual([]);
  });

  it("isn't named by a rule on a tool called api", async () => {
    const h = mcp("rules:\n  - match: { tool: api }\n    then: allow\n");
    expect(
      (await h.call({ method: "POST", path: "/repos/acme/web/hooks", query: {} })).status,
    ).toBe("denied");
  });
});
