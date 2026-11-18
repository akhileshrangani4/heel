import { describe, expect, it } from "vitest";
import { ghPull } from "../../src/definitions/cli/gh.ts";
import { cliPipeline } from "../helpers/cli-pipeline.ts";

/**
 * `gh pr merge` through `heel run` (D11): pinned to the head heel checked,
 * and `checks: passing` read on that commit.
 */

const HEAD = "a".repeat(40);

interface FakeGitHub {
  head?: string;
  runs?: { status: string; conclusion: string | null }[];
  statuses?: { state: string; total: number };
  fail?: boolean;
}

function github(state: FakeGitHub) {
  const seen: string[] = [];
  const fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input.toString());
    seen.push(url.pathname);
    if (state.fail === true) return new Response("{}", { status: 502 });
    if (/^\/repos\/acme\/web\/pulls\/\d+$/.test(url.pathname)) {
      return Response.json({ head: { sha: state.head ?? HEAD }, state: "open", merged: false });
    }
    if (url.pathname.endsWith("/check-runs")) {
      const runs = state.runs ?? [{ status: "completed", conclusion: "success" }];
      return Response.json({ total_count: runs.length, check_runs: runs });
    }
    if (url.pathname.endsWith("/status")) {
      const s = state.statuses ?? { state: "pending", total: 0 };
      return Response.json({ state: s.state, total_count: s.total });
    }
    return new Response("{}", { status: 404 });
  };
  return { fetch, seen };
}

const MERGE_WHEN_GREEN = `rules:
  - match: { action: github.merge, repo: acme/web, checks: passing }
    then: allow
`;

describe("gh pr merge", () => {
  it("adds --match-head-commit with the head heel checked, and merges when checks pass", async () => {
    const gh = github({});
    const h = cliPipeline({ owner: MERGE_WHEN_GREEN, fetch: gh.fetch });
    const answer = await h.run({
      argv: ["gh", "pr", "merge", "12", "-R", "acme/web", "--squash"],
      cwd: h.repo,
    });
    expect(answer.body["status"]).toBe("ran");
    expect(h.started[0]?.args).toEqual([
      "pr",
      "merge",
      "12",
      "-R",
      "acme/web",
      "--squash",
      "--match-head-commit",
      HEAD,
    ]);
    expect(gh.seen).toContain(`/repos/acme/web/commits/${HEAD}/check-runs`);
  });

  it("reads the repo and number from a pull request URL", async () => {
    expect(ghPull("https://github.com/Acme/Web/pull/7")).toEqual({ number: 7, repo: "acme/web" });
    expect(ghPull("#7")).toEqual({ number: 7 });
    expect(ghPull("my-branch")).toBeUndefined();
    const h = cliPipeline({ owner: MERGE_WHEN_GREEN, fetch: github({}).fetch });
    const answer = await h.run({
      argv: ["gh", "pr", "merge", "https://github.com/acme/web/pull/7"],
      cwd: h.repo,
    });
    expect(answer.body["status"]).toBe("ran");
  });

  it.each<[string, FakeGitHub]>([
    ["a failing check run", { runs: [{ status: "completed", conclusion: "failure" }] }],
    ["a check still running", { runs: [{ status: "in_progress", conclusion: null }] }],
    ["no checks at all", { runs: [], statuses: { state: "pending", total: 0 } }],
    ["a failing commit status", { statuses: { state: "failure", total: 1 } }],
  ])("doesn't let the rule match on %s", async (_label, state) => {
    const h = cliPipeline({ owner: MERGE_WHEN_GREEN, fetch: github(state).fetch });
    const answer = await h.run({
      argv: ["gh", "pr", "merge", "12", "-R", "acme/web"],
      cwd: h.repo,
    });
    expect(answer).toMatchObject({ status: 403, body: { status: "denied" } });
    expect(h.started).toEqual([]);
  });

  it.each([["--admin"], ["--auto"]])("fails checks: passing with %s", async (flag) => {
    const h = cliPipeline({ owner: MERGE_WHEN_GREEN, fetch: github({}).fetch });
    const answer = await h.run({
      argv: ["gh", "pr", "merge", "12", "-R", "acme/web", flag],
      cwd: h.repo,
    });
    expect(answer.status).toBe(403);
    expect(h.started).toEqual([]);
  });

  it("refuses a merge heel can't pin: no number, or no repo", async () => {
    const h = cliPipeline({ owner: MERGE_WHEN_GREEN, fetch: github({}).fetch });
    for (const argv of [
      ["gh", "pr", "merge", "-R", "acme/web"],
      ["gh", "pr", "merge", "12"],
      ["gh", "pr", "merge", "my-branch", "-R", "acme/web"],
    ]) {
      const answer = await h.run({ argv, cwd: h.repo });
      expect(answer, argv.join(" ")).toMatchObject({
        status: 403,
        body: { reason: "unsupported" },
      });
    }
  });

  it("refuses a --match-head-commit that isn't the head", async () => {
    const h = cliPipeline({ owner: MERGE_WHEN_GREEN, fetch: github({}).fetch });
    const answer = await h.run({
      argv: ["gh", "pr", "merge", "12", "-R", "acme/web", "--match-head-commit", "b".repeat(40)],
      cwd: h.repo,
    });
    expect(answer).toMatchObject({ status: 403, body: { reason: "unsupported" } });
  });

  it("denies when GitHub can't be read", async () => {
    const h = cliPipeline({ owner: MERGE_WHEN_GREEN, fetch: github({ fail: true }).fetch });
    const answer = await h.run({
      argv: ["gh", "pr", "merge", "12", "-R", "acme/web"],
      cwd: h.repo,
    });
    expect(answer).toMatchObject({ status: 403, body: { reason: "lookup_unavailable" } });
    expect(h.started).toEqual([]);
  });
});
