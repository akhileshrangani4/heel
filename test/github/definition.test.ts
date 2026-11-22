import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { accountModule } from "../../src/codemode/stubs.ts";
import { GITHUB_TOOLS, isWorkflowPath } from "../../src/definitions/github/definition.ts";
import { UpstreamPool } from "../../src/definitions/mcp/upstream.ts";
import { definitionRegistry } from "../../src/definitions/registry.ts";
import { addAgent } from "../../src/gateway/agents.ts";
import { createPipeline } from "../../src/gateway/pipeline/pipeline.ts";
import { SqliteApprovalStore } from "../../src/store/approvals.ts";
import { SqlitePauseStore } from "../../src/store/pauses.ts";
import { KEY_BYTES } from "../../src/vault/crypto.ts";
import { Vault } from "../../src/vault/vault.ts";
import { captureLogger } from "../helpers/log.ts";
import { compileRules } from "../helpers/pipeline.ts";
import { addAccount, testStore } from "../helpers/store.ts";

/** The GitHub definition (D11) through the real pipeline, against a fake GitHub API. */

const HEAD = "c".repeat(40);
const TOKEN = "github-test-token-not-real";

interface Sent {
  method: string;
  path: string;
  body: unknown;
}

function fakeGitHub(
  options: { checks?: "pass" | "fail"; mergeStatus?: number; files?: { filename: string }[] } = {},
) {
  const sent: Sent[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input.toString());
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    sent.push({ method, path: url.pathname, body });
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== `Bearer ${TOKEN}`) return Response.json({}, { status: 401 });
    const p = url.pathname;
    if (method === "GET" && /^\/repos\/acme\/web\/pulls\/\d+$/.test(p)) {
      if (p.endsWith("/404")) return Response.json({}, { status: 404 });
      return Response.json({
        number: 12,
        title: "Fix",
        state: "open",
        merged: false,
        head: { sha: HEAD, ref: "fix" },
        base: { ref: "main" },
        user: { login: "dev" },
        labels: [],
      });
    }
    if (method === "GET" && p === "/repos/acme/web/issues") {
      const issue = (number: number, extra: Record<string, unknown> = {}) => ({
        number,
        title: `Issue ${number}`,
        state: "open",
        body: null,
        user: { login: "dev" },
        labels: [{ name: "bug" }],
        html_url: `https://github.com/acme/web/issues/${number}`,
        created_at: "2026-11-20T10:00:00Z",
        updated_at: "2026-11-21T09:00:00Z",
        closed_at: null,
        comments: 3,
        ...extra,
      });
      return Response.json([issue(7), issue(8, { pull_request: { url: "x" } })]);
    }
    if (method === "GET" && p.endsWith("/check-runs")) {
      const conclusion = options.checks === "fail" ? "failure" : "success";
      return Response.json({
        total_count: 1,
        check_runs: [{ name: "ci", status: "completed", conclusion }],
      });
    }
    if (method === "GET" && p.endsWith("/status")) {
      return Response.json({ state: "pending", total_count: 0, statuses: [] });
    }
    if (method === "GET" && p.endsWith("/check-suites")) {
      return Response.json({ total_count: 0, check_suites: [] });
    }
    if (method === "GET" && p.endsWith("/files")) {
      const page = url.searchParams.get("page");
      return Response.json(page === "1" ? (options.files ?? [{ filename: "src/a.ts" }]) : []);
    }
    if (method === "GET" && p.startsWith("/repos/acme/web/rules/branches/")) {
      return Response.json([]);
    }
    if (method === "PUT" && p.endsWith("/merge")) {
      return Response.json(
        { merged: true, sha: "d".repeat(40) },
        { status: options.mergeStatus ?? 200 },
      );
    }
    if (method === "POST" && p.endsWith("/comments")) {
      return Response.json(
        { id: 1, html_url: "https://github.com/acme/web/pull/12#c1" },
        { status: 201 },
      );
    }
    if (method === "PUT" && p.includes("/contents/")) {
      return Response.json({ commit: { sha: "e".repeat(40) } }, { status: 201 });
    }
    return Response.json({}, { status: 404 });
  };
  return { fetch, sent };
}

function setUp(owner: string, gh = fakeGitHub()) {
  const t = testStore();
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
    { orgId: t.orgId, ownerId: t.ownerId, name: "coder" },
    new Date(),
  );
  const agent = {
    orgId: t.orgId,
    agentId,
    agentName: "coder",
    ownerId: t.ownerId,
    tokenId: "tok_1",
  };
  const call = (tool: string, args: Record<string, unknown>) =>
    pipeline.run({ agent, surface: "mcp", account: "github", tool, args });
  return { call, sent: gh.sent };
}

const MERGE_GREEN = `rules:
  - match: { action: github.merge, repo: acme/web, checks: passing }
    then: allow
  - match: { action: github.read }
    then: allow
  - match: { action: github.comment, repo: acme/web }
    then: allow
  - match: { action: github.push }
    then: allow
`;

/** A broad allow: it can still never admit a persistence call (I-70). */
const BROAD = `rules:
  - match: { action: github.push }
    then: allow
  - match: { repo: acme/web }
    then: allow
`;

describe("the GitHub definition", () => {
  it("lists issues with when they were opened and updated, in the shape its stub names (T14, T15)", async () => {
    const h = setUp(MERGE_GREEN);
    const result = await h.call("list_issues", { repo: "acme/web" });
    expect(result.status).toBe("allowed");
    const { issues } = (result as { result: { issues: Record<string, unknown>[] } }).result;
    // The pull request GitHub mixes in is left out.
    expect(issues.map((i) => i["number"])).toEqual([7]);
    expect(issues[0]).toMatchObject({
      created_at: "2026-11-20T10:00:00Z",
      updated_at: "2026-11-21T09:00:00Z",
      closed_at: null,
      comments: 3,
    });

    const listed = GITHUB_TOOLS.find((tool) => tool.name === "list_issues");
    const named = /\[(\{[^}]*\})/.exec(listed?.description ?? "")?.[1] ?? "";
    const keys = [...named.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(Object.keys(issues[0] ?? {}).sort()).toEqual([...keys].sort());

    // The outputSchema names the same keys (C5).
    const schema = listed?.outputSchema as {
      properties: { issues: { items: { properties: Record<string, unknown> } } };
    };
    expect(Object.keys(schema.properties.issues.items.properties).sort()).toEqual(
      Object.keys(issues[0] ?? {}).sort(),
    );

    const stubs = accountModule("github", GITHUB_TOOLS)?.stubs ?? "";
    expect(stubs).toContain('Returns {"issues": [{"number", "title"');
  });

  it("merges at the head heel read, after checks pass on it", async () => {
    const h = setUp(MERGE_GREEN);
    const result = await h.call("merge_pull_request", {
      repo: "Acme/Web",
      number: 12,
      method: "squash",
    });
    expect(result.status).toBe("allowed");
    const merge = h.sent.find((s) => s.method === "PUT");
    expect(merge?.path).toBe("/repos/acme/web/pulls/12/merge");
    expect(merge?.body).toMatchObject({ sha: HEAD, merge_method: "squash" });
    expect(h.sent.map((s) => s.path)).toContain(`/repos/acme/web/commits/${HEAD}/check-runs`);
  });

  it("treats a merge that lands a workflow as persistence", async () => {
    const h = setUp(
      MERGE_GREEN,
      fakeGitHub({ files: [{ filename: ".github/workflows/cron.yml" }] }),
    );
    const result = await h.call("merge_pull_request", { repo: "acme/web", number: 12 });
    expect(result).toMatchObject({ status: "denied", reason: "persistence_unnamed" });
    expect(h.sent.some((s) => s.method === "PUT")).toBe(false);
  });

  it("refuses a ref that walks the API path", async () => {
    const h = setUp(MERGE_GREEN);
    for (const ref of ["..", ".", "a/../b", "-x", "main.lock"]) {
      const result = await h.call("list_check_runs", { repo: "acme/web", ref });
      expect(result, ref).toMatchObject({ status: "denied", reason: "unsupported" });
    }
  });

  it("doesn't merge when a check fails", async () => {
    const h = setUp(MERGE_GREEN, fakeGitHub({ checks: "fail" }));
    const result = await h.call("merge_pull_request", { repo: "acme/web", number: 12 });
    expect(result.status).toBe("denied");
    expect(h.sent.some((s) => s.method === "PUT")).toBe(false);
  });

  it("denies a merge on a pull request that isn't there, before rules", async () => {
    const h = setUp(MERGE_GREEN);
    const result = await h.call("merge_pull_request", { repo: "acme/web", number: 404 });
    expect(result).toMatchObject({ status: "denied", reason: "not_available" });
  });

  it("passes GitHub's refusal of a merge through as an upstream error", async () => {
    const h = setUp(MERGE_GREEN, fakeGitHub({ mergeStatus: 409 }));
    const result = await h.call("merge_pull_request", { repo: "acme/web", number: 12 });
    expect(result).toMatchObject({ status: "upstream_error", upstreamStatus: 409 });
  });

  it("sets repo on every call, so a rule on one repo doesn't reach another", async () => {
    const h = setUp(MERGE_GREEN);
    expect(
      (await h.call("add_comment", { repo: "acme/web", number: 12, body: "lgtm" })).status,
    ).toBe("allowed");
    expect(
      (await h.call("add_comment", { repo: "acme/secret", number: 1, body: "lgtm" })).status,
    ).toBe("denied");
  });

  it("marks a workflow file as persistence, so a broad push allow doesn't cover it", async () => {
    expect(isWorkflowPath(".github/workflows/ci.yml")).toBe(true);
    expect(isWorkflowPath(".GitHub/Workflows/x.yml")).toBe(true);
    expect(isWorkflowPath("src/.github/workflows/x.yml")).toBe(false);
    const h = setUp(BROAD);
    const plain = await h.call("put_file", {
      repo: "acme/web",
      path: "README.md",
      content: "hi",
      message: "docs",
      branch: "main",
    });
    expect(plain.status).toBe("allowed");
    const workflow = await h.call("put_file", {
      repo: "acme/web",
      path: ".github/workflows/cron.yml",
      content: "on: schedule",
      message: "ci",
      branch: "main",
    });
    expect(workflow.status).toBe("denied");
  });

  it.each([
    ["a repo with a path segment", { repo: "acme/../web", number: 1 }],
    ["an extra argument", { repo: "acme/web", number: 1, bypass: true }],
  ])("refuses %s", async (_label, args) => {
    const h = setUp(MERGE_GREEN);
    expect(await h.call("get_pull_request", args)).toMatchObject({
      status: "denied",
      reason: "unsupported",
    });
  });

  it("refuses a file path that leaves the repo", async () => {
    const h = setUp(MERGE_GREEN);
    const result = await h.call("put_file", {
      repo: "acme/web",
      path: "../../etc/passwd",
      content: "x",
      message: "x",
      branch: "main",
    });
    expect(result).toMatchObject({ status: "denied", reason: "unsupported" });
  });
});
