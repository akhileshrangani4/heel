import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EgressConfigError } from "../../src/runner/egress.ts";
import { type SandboxHost, type SandboxSpec, SandboxSpecError } from "../../src/runner/plan.ts";
import {
  exitCode,
  runSandboxed,
  sandboxErrorDetail,
  startSandboxed,
  statusShowsStarted,
} from "../../src/runner/run.ts";

// These tests stand a shell script in for bwrap: it sees the same argv, options
// pipe (fd 3) and status pipe (fd 4) and misbehaves on purpose, so the run
// lifecycle is covered on any host. e2e/runner covers the real sandbox.

const TOKEN = "ghp_runTestCredential0123456789";
const SPEC: SandboxSpec = {
  binary: "/usr/bin/gh",
  args: ["pr", "view"],
  workRoot: "/srv/agents/ci-bot",
  cwd: "/srv/agents/ci-bot",
  secretEnv: { GH_TOKEN: TOKEN },
};
const STARTED = `printf '{"child-pid": 42}\\n' >&4`;

let dir: string;
let scripts = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "heel-run-test-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A host whose "bwrap" is a /bin/sh script with the given body. bwrap gets an empty env, so commands need full paths. */
async function fakeBwrap(body: string): Promise<SandboxHost> {
  const path = join(dir, `bwrap-${scripts++}.sh`);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return {
    bwrap: path,
    prlimit: "/usr/bin/prlimit",
    node: process.execPath,
    relay: "/opt/heel/src/runner/relay.ts",
    arch: "x64",
    systemDirs: [],
  };
}

describe("runSandboxed", () => {
  it("I-34: scrubs the credential from bwrap's own error, even when it quotes its options", async () => {
    const host = await fakeBwrap(`/usr/bin/tr '\\000' ' ' <&3 >&2\nexit 1`);
    const result = await runSandboxed(host, SPEC);
    expect(result.outcome.kind).toBe("sandbox_error");
    const detail = result.outcome.kind === "sandbox_error" ? result.outcome.detail : "";
    expect(detail).toContain("--setenv GH_TOKEN [redacted by heel]");
    expect(detail).not.toContain(TOKEN);
    // Before the program starts, stderr is bwrap's and goes into the outcome, not to the caller.
    expect(result.stderr.length).toBe(0);
  });

  it("I-34: passes the program's output and exit code through, with the credential scrubbed", async () => {
    const host = await fakeBwrap(
      [
        "/bin/cat <&3 >/dev/null",
        STARTED,
        `printf 'out %s\\n' '${TOKEN}'`,
        `printf 'err %s\\n' '${TOKEN}' >&2`,
        "exit 3",
      ].join("\n"),
    );
    const result = await runSandboxed(host, SPEC);
    expect(result.outcome).toEqual({ kind: "exited", code: 3 });
    expect(result.stdout.toString()).toBe("out [redacted by heel]\n");
    expect(result.stderr.toString()).toBe("err [redacted by heel]\n");
  });

  it("reports a bwrap that can't be started as a sandbox error", async () => {
    const result = await runSandboxed(
      { ...(await fakeBwrap("")), bwrap: join(dir, "missing") },
      SPEC,
    );
    expect(result.outcome.kind).toBe("sandbox_error");
    expect(result.outcome.kind === "sandbox_error" && result.outcome.detail).toMatch(
      /^can't start bwrap: .*ENOENT/,
    );
  });

  it("kills a program that passes the wall-time limit", async () => {
    const host = await fakeBwrap(`${STARTED}\nexec /bin/sleep 30`);
    const result = await runSandboxed(host, { ...SPEC, limits: { wallTimeMs: 200 } });
    expect(result.outcome).toEqual({ kind: "limit", limit: "time" });
  });

  it("kills a program that passes the output limit", async () => {
    const host = await fakeBwrap(`${STARTED}\nexec /usr/bin/head -c 1000000 /dev/zero`);
    const result = await runSandboxed(host, { ...SPEC, limits: { maxOutputBytes: 1000 } });
    expect(result.outcome).toEqual({ kind: "limit", limit: "output" });
    expect(result.stdout.length).toBeLessThanOrEqual(1000);
  });

  it("kills the sandbox when the signal is already aborted", async () => {
    const host = await fakeBwrap(`${STARTED}\nexec /bin/sleep 30`);
    const result = await runSandboxed(host, SPEC, { signal: AbortSignal.abort() });
    expect(result.outcome).toEqual({ kind: "aborted" });
  });

  it("closes the egress proxy and removes its directory once the program ends", async () => {
    // The script prints its options, which include the --bind of the proxy socket.
    const host = await fakeBwrap(`${STARTED}\n/usr/bin/tr '\\000' '\\n' <&3`);
    const result = await runSandboxed(host, {
      ...SPEC,
      network: { kind: "egress", allow: ["api.github.com"] },
    });
    expect(result.outcome).toEqual({ kind: "exited", code: 0 });
    const options = result.stdout.toString().split("\n");
    const socket = options.find(
      (_option, i) => options[i - 1] === "--bind" && options[i + 1] === "/heel/run/egress.sock",
    );
    expect(socket).toMatch(/egress\.sock$/);
    expect(existsSync(dirname(socket ?? "/nonexistent/x"))).toBe(false);
  });
});

describe("startSandboxed", () => {
  it("kill() stops a running program and settles as aborted", async () => {
    const host = await fakeBwrap(`${STARTED}\nexec /bin/sleep 30`);
    const sandboxed = await startSandboxed(host, SPEC);
    sandboxed.stdout.resume();
    sandboxed.stderr.resume();
    sandboxed.kill();
    expect(await sandboxed.done).toEqual({ kind: "aborted" });
  });

  it("closes stdin unless the spec asks for a pipe", async () => {
    const host = await fakeBwrap(`${STARTED}\nexit 0`);
    const ignored = await startSandboxed(host, SPEC);
    const piped = await startSandboxed(host, { ...SPEC, stdin: "pipe" });
    expect(ignored.stdin).toBeNull();
    expect(piped.stdin).not.toBeNull();
    for (const sandboxed of [ignored, piped]) {
      sandboxed.stdout.resume();
      sandboxed.stderr.resume();
      await sandboxed.done;
    }
  });

  it("throws before anything runs for a spec that would weaken the sandbox", async () => {
    const host = await fakeBwrap(`${STARTED}\nexit 0`);
    await expect(startSandboxed(host, { ...SPEC, cwd: "/etc" })).rejects.toThrow(SandboxSpecError);
    await expect(
      startSandboxed(host, { ...SPEC, network: { kind: "egress", allow: ["https://x"] } }),
    ).rejects.toThrow(EgressConfigError);
  });
});

describe("statusShowsStarted", () => {
  it("looks for bwrap's child-pid report", () => {
    expect(statusShowsStarted('{ "child-pid": 1234 }\n')).toBe(true);
    expect(statusShowsStarted('{"child-pid":7,"cgroup-namespace":1}')).toBe(true);
    expect(statusShowsStarted("")).toBe(false);
    expect(statusShowsStarted('{"exit-code": 1}')).toBe(false);
  });
});

describe("sandboxErrorDetail", () => {
  it("keeps bwrap's first non-empty line", () => {
    expect(sandboxErrorDetail("\n  bwrap: Can't find source path /x  \nmore\n", 1)).toBe(
      "bwrap: Can't find source path /x",
    );
  });

  it("says bwrap exited when it printed nothing", () => {
    expect(sandboxErrorDetail("", 1)).toBe("bwrap exited with status 1 before the program started");
  });
});

describe("exitCode", () => {
  it("reports a signal as 128 + n, as a shell does", () => {
    expect(exitCode(0, null)).toBe(0);
    expect(exitCode(null, "SIGKILL")).toBe(137);
    expect(exitCode(null, "SIGTERM")).toBe(143);
  });
});
