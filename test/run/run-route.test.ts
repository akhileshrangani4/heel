import { mkdirSync, mkdtempSync, renameSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cliPipeline, GH_TEST_TOKEN } from "../helpers/cli-pipeline.ts";

/** `/run` (D8b): the CLI runner's endpoint, through the real pipeline, with a fake sandbox. */

const ALLOW_GH = `rules:
  - match: { command: gh }
    then: allow
`;

describe("/run", () => {
  it("runs an allowed command in the sandbox with heel's binary and the credential", async () => {
    const h = cliPipeline({ owner: ALLOW_GH, stdout: "#12 fix it\n" });
    const answer = await h.run({ argv: ["gh", "pr", "list", "-R", "acme/web"], cwd: h.repo });
    expect(answer).toEqual({
      status: 200,
      body: { status: "ran", exitCode: 0, stdout: "#12 fix it\n", stderr: "" },
    });
    const [spec] = h.started;
    expect(spec?.binary).toBe("/usr/bin/gh");
    expect(spec?.args).toEqual(["pr", "list", "-R", "acme/web"]);
    expect(spec?.workRoot).toBe(h.root);
    expect(spec?.cwd).toBe(h.repo);
    expect(spec?.secretEnv).toEqual({ GH_TOKEN: GH_TEST_TOKEN });
    // git never reads the checkout, gh never reads the repo from it, and there's no /proc.
    expect(spec?.env).toMatchObject({ GIT_DIR: "/dev/null", GH_REPO: "acme/web" });
    expect(spec?.proc).toBe(false);
    expect(spec?.network).toEqual({ kind: "egress", allow: ["api.github.com", "github.com"] });
  });

  it("passes the command's own exit code through", async () => {
    const h = cliPipeline({ owner: ALLOW_GH, outcome: { kind: "exited", code: 4 } });
    const answer = await h.run({ argv: ["gh", "pr", "list", "-R", "acme/web"], cwd: h.repo });
    expect(answer.body).toMatchObject({ status: "ran", exitCode: 4 });
  });

  it("reports a sandbox limit as an error, not as the command's exit", async () => {
    const h = cliPipeline({ owner: ALLOW_GH, outcome: { kind: "limit", limit: "time" } });
    const answer = await h.run({ argv: ["gh", "pr", "list", "-R", "acme/web"], cwd: h.repo });
    expect(answer.body).toMatchObject({ status: "error", stopped: "time" });
  });

  it("denies a directory outside the agent's work roots", async () => {
    const h = cliPipeline({ owner: ALLOW_GH });
    const answer = await h.run({ argv: ["gh", "pr", "list", "-R", "acme/web"], cwd: tmpdir() });
    expect(answer).toMatchObject({ status: 403, body: { reason: "workdir_not_allowed" } });
    expect(h.started).toEqual([]);
  });

  it("follows symlinks before checking the directory", async () => {
    const h = cliPipeline({ owner: ALLOW_GH });
    const outside = join(h.root, "..", `outside-${Date.now()}`);
    mkdirSync(outside);
    symlinkSync(outside, join(h.repo, "escape"));
    const answer = await h.run({
      argv: ["gh", "pr", "list", "-R", "acme/web"],
      cwd: join(h.repo, "escape"),
    });
    expect(answer).toMatchObject({ status: 403, body: { reason: "workdir_not_allowed" } });
    expect(h.started).toEqual([]);
  });

  it("denies a command that prints the credential, whatever the rules say", async () => {
    const h = cliPipeline({ owner: ALLOW_GH });
    const answer = await h.run({ argv: ["gh", "auth", "token"], cwd: h.repo });
    expect(answer).toMatchObject({ status: 403, body: { reason: "credential_exposure" } });
    expect(h.started).toEqual([]);
  });

  it("denies a command heel can't parse", async () => {
    const h = cliPipeline({ owner: ALLOW_GH });
    const answer = await h.run({ argv: ["gh", "my-alias"], cwd: h.repo });
    expect(answer).toMatchObject({ status: 403, body: { reason: "unsupported" } });
  });

  it("answers an ask with the approval to check back on", async () => {
    const h = cliPipeline({ owner: "rules:\n  - match: { command: gh }\n    then: ask\n" });
    const answer = await h.run({ argv: ["gh", "pr", "list", "-R", "acme/web"], cwd: h.repo });
    expect(answer.status).toBe(202);
    expect(answer.body).toMatchObject({ status: "pending", approvalId: expect.any(String) });
    expect(h.started).toEqual([]);
  });

  it("treats a command with no CLI account as unknown", async () => {
    const h = cliPipeline({ owner: ALLOW_GH });
    const answer = await h.run({ argv: ["kubectl", "get", "pods"], cwd: h.repo });
    expect(answer).toMatchObject({ status: 404, body: { reason: "unknown_endpoint" } });
  });

  it("requires -R, so the repo rules see is the one gh uses", async () => {
    const h = cliPipeline({ owner: ALLOW_GH });
    const answer = await h.run({ argv: ["gh", "pr", "merge", "5"], cwd: h.repo });
    expect(answer).toMatchObject({ status: 403, body: { reason: "unsupported" } });
    expect(h.started).toEqual([]);
  });

  it.each([
    ["--body-file", "/proc/self/environ"],
    ["--body-file", "../../proc/self/environ"],
    ["-F", "x=@/proc/self/environ"],
    ["--body-file", "/heel/run/egress.sock"],
    ["--body-file", "/dev/fd/3"],
  ])("refuses an argument naming the sandbox's own files: %s %s", async (flag, value) => {
    const h = cliPipeline({ owner: ALLOW_GH });
    const answer = await h.run({
      argv: ["gh", "issue", "create", "-R", "acme/web", "--title", "t", flag, value],
      cwd: h.repo,
    });
    expect(answer).toMatchObject({ status: 403, body: { reason: "unsupported" } });
  });

  it("refuses a work root whose path now leads somewhere else", async () => {
    const h = cliPipeline({ owner: ALLOW_GH });
    const moved = `${h.root}.moved`;
    renameSync(h.root, moved);
    const elsewhere = mkdtempSync(join(tmpdir(), "heel-elsewhere-"));
    symlinkSync(elsewhere, h.root);
    const answer = await h.run({ argv: ["gh", "pr", "list", "-R", "acme/web"], cwd: h.root });
    expect(answer).toMatchObject({ status: 403, body: { reason: "workdir_not_allowed" } });
    expect(h.started).toEqual([]);
  });

  it("refuses a relative directory", async () => {
    const h = cliPipeline({ owner: ALLOW_GH });
    const answer = await h.run({ argv: ["gh", "pr", "list", "-R", "acme/web"], cwd: "repo" });
    expect(answer).toMatchObject({ status: 400, body: { reason: "invalid_request" } });
  });

  it("refuses every command as a heel error when the sandbox isn't available", async () => {
    const h = cliPipeline({ owner: ALLOW_GH, sandbox: false });
    const answer = await h.run({ argv: ["gh", "pr", "list", "-R", "acme/web"], cwd: h.repo });
    expect(answer).toMatchObject({
      status: 503,
      body: { status: "error", reason: "sandbox_unavailable" },
    });
    expect(h.started).toEqual([]);
  });

  it("refuses a CLI account reached from another surface", async () => {
    const h = cliPipeline({ owner: ALLOW_GH });
    const result = await h.pipeline.run({
      agent: h.agent,
      surface: "mcp",
      account: "github",
      tool: "gh",
      args: { argv: ["gh", "pr", "list", "-R", "acme/web"], cwd: h.repo },
    });
    expect(result).toMatchObject({ status: "denied", reason: "unsupported" });
    expect(h.started).toEqual([]);
  });
});
