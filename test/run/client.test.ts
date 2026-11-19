import { describe, expect, it } from "vitest";
import { main } from "../../src/cli/main.ts";
import { runCommand } from "../../src/cli/run.ts";

/** The `heel run` client (D8b): what it posts, and the exit codes the spec gives each answer. */

function io(env: Record<string, string> = {}) {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      env: { HEEL_TOKEN: "heel_test", HEEL_URL: "http://127.0.0.1:7071", ...env },
      stdin: (async function* (): AsyncGenerator<string> {})(),
      stdout: { write: (s: string) => (stdout += s) },
      stderr: { write: (s: string) => (stderr += s) },
      cwd: () => "/work/repo",
    },
    out: () => stdout,
    err: () => stderr,
  };
}

function answering(body: unknown) {
  const sent: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: URL, init: RequestInit) => {
    sent.push({ url: url.toString(), init });
    return new Response(JSON.stringify(body));
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}

describe("heel run", () => {
  it("posts the argv, cwd and run id with the agent's token", async () => {
    const h = io({ HEEL_RUN_ID: "run-7" });
    const f = answering({ status: "ran", exitCode: 0, stdout: "ok\n", stderr: "" });
    const code = await runCommand(["--", "gh", "pr", "list"], h.io, {
      fetch: f.fetch,
      cwd: () => "/work/repo",
    });
    expect(code).toBe(0);
    expect(h.out()).toBe("ok\n");
    expect(f.sent[0]?.url).toBe("http://127.0.0.1:7071/run");
    expect(JSON.parse(String(f.sent[0]?.init.body))).toEqual({
      argv: ["gh", "pr", "list"],
      cwd: "/work/repo",
      runId: "run-7",
    });
    const headers = f.sent[0]?.init.headers as Record<string, string> | undefined;
    expect(headers?.["authorization"]).toBe("Bearer heel_test");
  });

  it.each([
    [{ status: "ran", exitCode: 3, stdout: "", stderr: "" }, 3],
    [{ status: "pending", approvalId: "apr_1" }, 75],
    [{ status: "busy", limit: "agent", message: "send this again" }, 75],
    [{ status: "denied", reason: "no_rule_matched" }, 77],
    [{ status: "expired", approvalId: "apr_1" }, 77],
    [{ status: "paused", scope: "all" }, 69],
    [{ status: "error", stopped: "time" }, 70],
  ])("exits for %o with %i", async (answer, exit) => {
    const h = io();
    const code = await runCommand(["--", "gh", "pr", "list"], h.io, {
      fetch: answering(answer).fetch,
      cwd: () => "/w",
    });
    expect(code).toBe(exit);
    if (answer.status !== "ran") expect(h.err()).toBe(`heel: ${JSON.stringify(answer)}\n`);
  });

  it("exits 70 when heel can't be reached", async () => {
    const h = io();
    const fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof globalThis.fetch;
    expect(await runCommand(["--", "gh"], h.io, { fetch, cwd: () => "/w" })).toBe(70);
    expect(h.err()).toContain("couldn't reach heel");
  });

  it("with --json, writes the whole answer to stdout", async () => {
    const h = io();
    const answer = { status: "pending", approvalId: "apr_1" };
    const code = await runCommand(["--json", "--", "gh", "pr", "list"], h.io, {
      fetch: answering(answer).fetch,
      cwd: () => "/w",
    });
    expect(code).toBe(75);
    expect(JSON.parse(h.out())).toEqual(answer);
    expect(h.err()).toBe("");
  });

  it.each([[["run", "gh", "pr"]], [["run", "--"]], [["run", "--bogus", "--", "gh"]]])(
    "exits 64 on a usage error: %o",
    async (argv) => {
      const h = io();
      expect(await main(argv, h.io)).toBe(64);
    },
  );

  it("exits 64 without HEEL_TOKEN", async () => {
    const h = io({ HEEL_TOKEN: "" });
    expect(await main(["run", "--", "gh"], h.io)).toBe(64);
  });

  it.each(["", "127.0.0.1:7300", "localhost:7300", "ftp://127.0.0.1:7300"])(
    "exits 64 when HEEL_URL is %o, not an http(s) URL",
    async (url) => {
      const h = io({ HEEL_URL: url });
      expect(await main(["run", "--", "gh"], h.io)).toBe(64);
      expect(h.err()).toContain("HEEL_URL isn't an http:// or https:// URL");
    },
  );
});
