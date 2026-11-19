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
  runs?: { name?: string; status: string; conclusion: string | null }[];
  statuses?: { context: string; state: string }[];
  suites?: { status: string; conclusion: string | null; latest_check_runs_count: number }[];
  /** Contexts the base branch's rules require. */
  required?: string[];
  files?: string[];
  pullState?: "open" | "closed";
  base?: string;
  fail?: boolean;
}

function github(state: FakeGitHub) {
  const seen: string[] = [];
  const fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input.toString());
    const p = url.pathname;
    seen.push(p);
    if (state.fail === true) return new Response("{}", { status: 502 });
    if (/^\/repos\/acme\/web\/pulls\/\d+$/.test(p)) {
      return Response.json({
        head: { sha: state.head ?? HEAD },
        base: { ref: state.base ?? "main" },
        state: state.pullState ?? "open",
        merged: false,
      });
    }
    if (p.endsWith("/files")) {
      const page = Number(url.searchParams.get("page") ?? "1");
      const files = page === 1 ? (state.files ?? ["src/app.ts"]) : [];
      return Response.json(files.map((filename) => ({ filename })));
    }
    if (p.endsWith("/check-runs")) {
      const runs = state.runs ?? [{ name: "ci", status: "completed", conclusion: "success" }];
      return Response.json({ total_count: runs.length, check_runs: runs });
    }
    if (p.endsWith("/check-suites")) {
      const suites = state.suites ?? [];
      return Response.json({ total_count: suites.length, check_suites: suites });
    }
    if (p.endsWith("/status")) {
      const statuses = state.statuses ?? [];
      const failing = statuses.some((s) => s.state !== "success");
      return Response.json({
        state: statuses.length === 0 ? "pending" : failing ? "failure" : "success",
        total_count: statuses.length,
        statuses,
      });
    }
    if (p === `/repos/acme/web/rules/branches/${state.base ?? "main"}`) {
      const required = state.required ?? [];
      return Response.json(
        required.length === 0
          ? []
          : [
              {
                type: "required_status_checks",
                parameters: { required_status_checks: required.map((context) => ({ context })) },
              },
            ],
      );
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
  it("passes a required check that ran green", async () => {
    const h = cliPipeline({ owner: MERGE_WHEN_GREEN, fetch: github({ required: ["ci"] }).fetch });
    const answer = await h.run({
      argv: ["gh", "pr", "merge", "12", "-R", "acme/web"],
      cwd: h.repo,
    });
    expect(answer.body["status"]).toBe("ran");
  });

  it("refuses a pull request URL naming another repo than -R", async () => {
    const h = cliPipeline({ owner: MERGE_WHEN_GREEN, fetch: github({}).fetch });
    const answer = await h.run({
      argv: ["gh", "pr", "merge", "https://github.com/acme/prod/pull/7", "-R", "acme/web"],
      cwd: h.repo,
    });
    expect(answer).toMatchObject({ status: 403, body: { reason: "unsupported" } });
    expect(h.started).toEqual([]);
  });

  it("treats a merge that lands a workflow as persistence", async () => {
    const h = cliPipeline({
      owner: MERGE_WHEN_GREEN,
      fetch: github({ files: ["src/a.ts", ".github/workflows/cron.yml"] }).fetch,
    });
    const answer = await h.run({
      argv: ["gh", "pr", "merge", "12", "-R", "acme/web"],
      cwd: h.repo,
    });
    expect(answer).toMatchObject({ status: 403, body: { reason: "persistence_unnamed" } });
  });

  it("refuses a closed pull request", async () => {
    const h = cliPipeline({
      owner: MERGE_WHEN_GREEN,
      fetch: github({ pullState: "closed" }).fetch,
    });
    const answer = await h.run({
      argv: ["gh", "pr", "merge", "12", "-R", "acme/web"],
      cwd: h.repo,
    });
    expect(answer).toMatchObject({ status: 403, body: { reason: "unsupported" } });
  });

  it("passes the base branch as args.base, as the GitHub service does", async () => {
    const rules = `rules:
  - match: { action: github.merge, repo: acme/web, args.base: main }
    then: ask
  - match: { action: github.merge, repo: acme/web, checks: passing }
    then: allow
`;
    const toMain = cliPipeline({ owner: rules, fetch: github({}).fetch });
    const asked = await toMain.run({
      argv: ["gh", "pr", "merge", "12", "-R", "acme/web"],
      cwd: toMain.repo,
    });
    expect(asked.status).toBe(202);
    expect(toMain.started).toEqual([]);

    const toRelease = cliPipeline({ owner: rules, fetch: github({ base: "release-2" }).fetch });
    const ran = await toRelease.run({
      argv: ["gh", "pr", "merge", "12", "-R", "acme/web"],
      cwd: toRelease.repo,
    });
    expect(ran.body["status"]).toBe("ran");
  });

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
    expect(ghPull("https://github.com/../acme/pull/7")).toBeUndefined();
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
    ["no checks at all", { runs: [] }],
    ["only skipped checks", { runs: [{ status: "completed", conclusion: "skipped" }] }],
    ["a failing commit status", { statuses: [{ context: "deploy", state: "failure" }] }],
    [
      "a required check that hasn't reported, behind a green status",
      { runs: [], statuses: [{ context: "cla", state: "success" }], required: ["ci/build"] },
    ],
    [
      "a fork run waiting for approval",
      {
        runs: [],
        statuses: [{ context: "cla", state: "success" }],
        suites: [
          { status: "completed", conclusion: "action_required", latest_check_runs_count: 0 },
        ],
      },
    ],
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
