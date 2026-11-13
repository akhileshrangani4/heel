/**
 * The sandbox runner under real bubblewrap (spec: CLI runner, "Sandbox").
 * A fake CLI (fake-cli.ts) runs inside the sandbox and reports what it can
 * see and do; the tests assert on that report and on the host around it.
 *
 * Locally the suite skips when this host can't run a sandbox. CI sets
 * HEEL_REQUIRE_SANDBOX, so there a skip is a failure. Egress tests use local
 * echo servers and IP-literal allowlist entries, so nothing needs the
 * internet.
 */
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type EgressDecision,
  probeSandbox,
  REDACTED,
  runSandboxed,
  type SandboxHost,
  type SandboxResult,
  type SandboxSpec,
  SandboxSpecError,
  startSandboxed,
} from "../../src/runner/index.ts";

const FAKE_CLI = fileURLToPath(new URL("./fake-cli.ts", import.meta.url));
const PROBE_ONCE = fileURLToPath(new URL("./probe-once.ts", import.meta.url));
const TOKEN = "ghp_e2eFakeCredential0123456789abcdefXYZ";
const TOKEN_SHA256 = createHash("sha256").update(TOKEN).digest("hex");

const probe = await probeSandbox();
if (!probe.ok && process.env["HEEL_REQUIRE_SANDBOX"] === "1") {
  throw new Error(`HEEL_REQUIRE_SANDBOX is set but the sandbox is unavailable: ${probe.detail}`);
}
const host: SandboxHost | undefined = probe.ok ? probe.host : undefined;

const canRunAsNobody = spawnSync("sudo", ["-n", "-u", "nobody", "true"]).status === 0;
const mustRunAsNobody = process.env["HEEL_REQUIRE_PRIVILEGED_TESTS"] === "1";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A work root with a `repo` checkout inside it, where the program starts. */
function workRoot(): { root: string; cwd: string } {
  const root = tempDir("heel-e2e-work-");
  const cwd = join(root, "repo");
  mkdirSync(cwd);
  return { root, cwd };
}

function requireHost(): SandboxHost {
  if (host === undefined) throw new Error("no sandbox host");
  return host;
}

/** The fake CLI as a sandbox spec: heel's Node runs it, mounted read-only from outside the work root. */
function fakeCli(args: readonly string[], extra: Partial<SandboxSpec> = {}): SandboxSpec {
  const { root, cwd } = workRoot();
  return {
    binary: requireHost().node,
    args: [FAKE_CLI, ...args],
    workRoot: root,
    cwd,
    secretEnv: { GH_TOKEN: TOKEN },
    readOnlyPaths: [FAKE_CLI],
    ...extra,
  };
}

function report(result: SandboxResult): Record<string, unknown> {
  expect(result.outcome, result.stderr.toString("utf8")).toEqual({ kind: "exited", code: 0 });
  const parsed: unknown = JSON.parse(result.stdout.toString("utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error("fake CLI printed no report");
  return parsed as Record<string, unknown>;
}

interface ProcessReport {
  readonly pid: number;
  readonly cmdline: readonly string[];
  readonly cmdlineHasCredential: boolean;
}

/** Host processes whose command line contains `marker`, with their argv. */
function hostProcessesWith(marker: string): { pid: number; cmdline: string[] }[] {
  return readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .flatMap((pid) => {
      let text: string;
      try {
        text = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      } catch {
        return []; // The process exited while we scanned.
      }
      const cmdline = text.split("\0").filter(Boolean);
      return cmdline.includes(marker) ? [{ pid: Number(pid), cmdline }] : [];
    });
}

/** Every host command line, joined, for scanning. */
function allHostCommandLines(): string {
  return readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .map((pid) => {
      try {
        return readFileSync(`/proc/${pid}/cmdline`, "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");
}

/** Starts the fake CLI sleeping with a unique marker and waits until its host process is visible. */
async function startSleeper(): Promise<{ pid: number; kill: () => Promise<void> }> {
  const marker = `heel-e2e-marker-${process.pid}-${Date.now()}`;
  const sandboxed = await startSandboxed(requireHost(), fakeCli(["sleep", "30000", marker]));
  sandboxed.stdout.resume();
  sandboxed.stderr.resume();
  const kill = async (): Promise<void> => {
    sandboxed.kill();
    await sandboxed.done;
  };
  cleanups.push(kill);
  for (let attempt = 0; attempt < 100; attempt++) {
    const program = hostProcessesWith(marker).find(
      ({ cmdline }) => cmdline[0] === requireHost().node && cmdline.includes(FAKE_CLI),
    );
    if (program !== undefined) return { pid: program.pid, kill };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the sandboxed program never appeared");
}

function runAsNobody(args: readonly string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "sudo",
      ["-n", "-u", "nobody", ...args],
      { encoding: "utf8", timeout: 10_000 },
      (error, _stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ code, stderr });
      },
    );
  });
}

/** A TCP server on host loopback that echoes what it receives. */
async function echoServer(): Promise<{ port: number; server: Server }> {
  const server = createServer((socket) => socket.pipe(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no echo port");
  return { port: address.port, server };
}

describe.skipIf(host === undefined)("sandbox runner under real bubblewrap", () => {
  describe("credential isolation", () => {
    it("I-34: the program gets the credential, and the output the agent receives never carries it", async () => {
      const result = await runSandboxed(requireHost(), fakeCli(["inspect", "GH_TOKEN"]));
      const seen = report(result);

      expect(seen["credentialSha256"]).toBe(TOKEN_SHA256);
      expect(result.stdout.includes(TOKEN)).toBe(false);
      expect(result.stderr.includes(TOKEN)).toBe(false);
      expect(seen["env"]).toEqual({
        GH_TOKEN: REDACTED.toString("utf8"),
        HOME: "/heel/home",
        TMPDIR: "/tmp",
        PATH: "/usr/local/bin:/usr/bin:/bin",
        PWD: expect.any(String),
      });
    });

    it("I-34: no command line, inside the sandbox or on the host, carries the credential", async () => {
      const seen = report(await runSandboxed(requireHost(), fakeCli(["inspect", "GH_TOKEN"])));
      const inside = seen["processes"] as ProcessReport[];
      expect(inside.length).toBeGreaterThan(0);
      expect(inside.filter((process) => process.cmdlineHasCredential)).toEqual([]);

      // While a sandbox holding the credential runs, any host user can read every command line.
      await startSleeper();
      expect(allHostCommandLines().includes(TOKEN)).toBe(false);
    });

    it("I-34: the sandbox sees only its own processes, never heel's", async () => {
      const seen = report(await runSandboxed(requireHost(), fakeCli(["inspect", "GH_TOKEN"])));
      const inside = seen["processes"] as ProcessReport[];
      // bwrap's init and the program; nothing from the host's pid namespace.
      expect(inside.length).toBeLessThanOrEqual(3);
      for (const process of inside) {
        expect(process.cmdline.join(" ")).not.toMatch(/vitest/);
      }
      expect(inside.map((process) => process.cmdline[0])).toContain(requireHost().node);
    });

    it.skipIf(!canRunAsNobody && !mustRunAsNobody)(
      "I-34: another Unix user can't read the sandboxed program's environment",
      async () => {
        const { pid } = await startSleeper();

        // Control: the credential really is in that environment, for heel's own user.
        expect(readFileSync(`/proc/${pid}/environ`, "utf8")).toContain(`GH_TOKEN=${TOKEN}`);

        const asAgent = await runAsNobody(["cat", `/proc/${pid}/environ`]);
        expect(asAgent.code).not.toBe(0);
        expect(asAgent.stderr).toMatch(/Permission denied/);
      },
    );

    it("scrubs the credential even when it straddles two output chunks", async () => {
      const result = await runSandboxed(requireHost(), fakeCli(["print-env", "GH_TOKEN"]));
      expect(result.outcome).toEqual({ kind: "exited", code: 0 });
      expect(result.stdout.toString("utf8")).toBe(`before ${REDACTED.toString("utf8")} after\n`);
      expect(result.stderr.toString("utf8")).toBe(`before ${REDACTED.toString("utf8")} after\n`);
    });
  });

  describe("filesystem", () => {
    it("I-34: the program can't overwrite its binary or anything heel mounts", async () => {
      const spec = fakeCli([
        "overwrite",
        requireHost().node,
        FAKE_CLI,
        "/usr/bin/env",
        "/heel/home/../relay.ts",
      ]);
      const seen = report(await runSandboxed(requireHost(), spec));
      expect(seen[requireHost().node]).toMatch(/^(EROFS|EACCES)$/);
      expect(seen[FAKE_CLI]).toMatch(/^(EROFS|EACCES)$/);
      expect(seen["/usr/bin/env"]).toMatch(/^(EROFS|EACCES)$/);
      expect(seen["/heel/home/../relay.ts"]).not.toBe("written");
      // The host copies are untouched.
      expect(readFileSync(FAKE_CLI, "utf8")).toContain("A stand-in CLI");
    });

    it("I-34: a binary inside the agent's work root is refused before anything runs", async () => {
      const { root, cwd } = workRoot();
      const planted = join(root, "gh");
      copyFileSync("/usr/bin/true", planted);
      await expect(
        startSandboxed(requireHost(), { binary: planted, args: [], workRoot: root, cwd }),
      ).rejects.toBeInstanceOf(SandboxSpecError);
    });

    it("mounts the work root read-write and nothing else of the host", async () => {
      const elsewhere = tempDir("heel-e2e-elsewhere-");
      writeFileSync(join(elsewhere, "secret.txt"), "not for the agent\n");
      const spec = fakeCli([]);
      writeFileSync(join(spec.workRoot, "visible.txt"), "checkout file\n");
      const repoPackage = fileURLToPath(new URL("../../package.json", import.meta.url));
      const probed = [
        join(spec.workRoot, "visible.txt"),
        join(elsewhere, "secret.txt"),
        repoPackage,
        "/etc/passwd",
        "/etc/shadow",
        "/root",
      ];
      const seen = report(
        await runSandboxed(requireHost(), {
          ...spec,
          args: [FAKE_CLI, "inspect", "GH_TOKEN", ...probed],
        }),
      );

      expect(seen["cwd"]).toBe(spec.cwd);
      expect(seen["stdin"]).toBe("/dev/null");
      expect(seen["paths"]).toEqual({
        [join(spec.workRoot, "visible.txt")]: true,
        [join(elsewhere, "secret.txt")]: false,
        [repoPackage]: false,
        "/etc/passwd": false,
        "/etc/shadow": false,
        "/root": false,
      });

      const write = report(
        await runSandboxed(requireHost(), {
          ...spec,
          args: [FAKE_CLI, "overwrite", join(spec.cwd, "out.txt")],
        }),
      );
      expect(write[join(spec.cwd, "out.txt")]).toBe("written");
      expect(existsSync(join(spec.cwd, "out.txt"))).toBe(true);
    });

    it("I-30: arguments reach the program verbatim, with no shell to interpret them", async () => {
      const args = ["a; touch /tmp/pwned", "$(id)", "`id`", "*", "x > y", "--flag=$HOME", ""];
      const seen = report(await runSandboxed(requireHost(), fakeCli(["args", ...args])));
      expect(seen["args"]).toEqual(args);
    });
  });

  describe("egress", () => {
    let allowed: { port: number; server: Server };
    let other: { port: number; server: Server };
    beforeAll(async () => {
      allowed = await echoServer();
      other = await echoServer();
    });
    afterAll(() => {
      allowed.server.close();
      other.server.close();
    });

    async function viaProxy(
      target: string,
      allow: readonly string[],
    ): Promise<{ seen: Record<string, unknown>; decisions: EgressDecision[] }> {
      const decisions: EgressDecision[] = [];
      const result = await runSandboxed(
        requireHost(),
        fakeCli(["via-proxy", target], { network: { kind: "egress", allow } }),
        { onEgress: (decision) => decisions.push(decision) },
      );
      return { seen: report(result), decisions };
    }

    it("reaches an allowlisted host through heel's proxy", async () => {
      const target = `127.0.0.1:${allowed.port}`;
      const { seen, decisions } = await viaProxy(target, [target]);
      expect(seen).toEqual({ status: "HTTP/1.1 200 Connection Established", echoed: "ping\n" });
      expect(decisions).toEqual([
        {
          allowed: true,
          target: { host: "127.0.0.1", port: allowed.port },
          address: "127.0.0.1",
        },
      ]);
    });

    it("refuses a host outside the allowlist", async () => {
      const { seen, decisions } = await viaProxy(`127.0.0.1:${other.port}`, [
        `127.0.0.1:${allowed.port}`,
      ]);
      expect(seen["status"]).toBe("HTTP/1.1 403 Forbidden");
      expect(decisions).toMatchObject([{ allowed: false, reason: "not_allowlisted" }]);
    });

    it("refuses an allowlisted name that resolves to a private address", async () => {
      const target = `localhost:${allowed.port}`;
      const { seen, decisions } = await viaProxy(target, [target]);
      expect(seen["status"]).toBe("HTTP/1.1 403 Forbidden");
      expect(decisions).toMatchObject([{ allowed: false, reason: "private_address" }]);
    });

    it("gives a program that ignores the proxy no route out", async () => {
      const network = { kind: "egress", allow: [`127.0.0.1:${allowed.port}`] } as const;
      // The echo server listens on the host's loopback; the sandbox has its own.
      const loopback = report(
        await runSandboxed(
          requireHost(),
          fakeCli(["direct", "127.0.0.1", String(allowed.port)], { network }),
        ),
      );
      expect(loopback).toEqual({ result: "ECONNREFUSED" });
      const internet = report(
        await runSandboxed(requireHost(), fakeCli(["direct", "1.1.1.1", "443"], { network })),
      );
      expect(internet).toEqual({ result: "ENETUNREACH" });
    });

    it("has no network at all when egress is off", async () => {
      const seen = report(await runSandboxed(requireHost(), fakeCli(["direct", "1.1.1.1", "443"])));
      expect(seen).toEqual({ result: "ENETUNREACH" });
      const env = report(await runSandboxed(requireHost(), fakeCli(["inspect", "GH_TOKEN"])))[
        "env"
      ] as Record<string, string>;
      expect(env["HTTPS_PROXY"]).toBeUndefined();
    });
  });

  describe("limits and teardown", () => {
    it("kills a program that passes its wall time", async () => {
      const started = Date.now();
      const result = await runSandboxed(
        requireHost(),
        fakeCli(["sleep", "30000"], { limits: { wallTimeMs: 1000 } }),
      );
      expect(result.outcome).toEqual({ kind: "limit", limit: "time" });
      expect(Date.now() - started).toBeLessThan(10_000);
    });

    it("stops a program that passes the output limit", async () => {
      const result = await runSandboxed(
        requireHost(),
        fakeCli(["spew", "200000"], { limits: { maxOutputBytes: 10_000 } }),
      );
      expect(result.outcome).toEqual({ kind: "limit", limit: "output" });
      expect(result.stdout.length).toBeLessThanOrEqual(10_000);
    });

    it("caps the memory a program can allocate at the spec's 1 GiB default", async () => {
      const small = report(await runSandboxed(requireHost(), fakeCli(["alloc", "64"])));
      expect(small).toEqual({ result: "allocated", bytes: 64 * 1024 * 1024 });
      const large = report(await runSandboxed(requireHost(), fakeCli(["alloc", "1536"])));
      expect(large).toEqual({ result: "RangeError" });

      // Control: the same allocation succeeds once the limit allows it, so the limit is the cause.
      const raised = report(
        await runSandboxed(
          requireHost(),
          fakeCli(["alloc", "1536"], { limits: { memoryBytes: 3 * 1024 * 1024 * 1024 } }),
        ),
      );
      expect(raised).toEqual({ result: "allocated", bytes: 1536 * 1024 * 1024 });
    });

    it("caps the processes a program can start", async () => {
      const seen = report(
        await runSandboxed(
          requireHost(),
          fakeCli(["spawn", "120"], { limits: { maxProcesses: 64 } }),
        ),
      );
      expect(seen["started"]).toBeLessThan(120);
      expect(seen["failures"]).toContain("EAGAIN");
    });

    it("kills the whole sandbox when the caller aborts", async () => {
      const { pid, kill } = await startSleeper();
      await kill();
      expect(existsSync(`/proc/${pid}`)).toBe(false);
    });
  });
});

describe("boot probe", () => {
  it.skipIf(host === undefined)("passes on a host that can run the sandbox", () => {
    expect(probe.ok).toBe(true);
  });

  it("reports a missing bubblewrap", async () => {
    const missing = await probeSandbox({ bwrap: "/nonexistent/bwrap" });
    expect(missing).toMatchObject({ ok: false, reason: "bwrap_missing" });
    expect(missing.ok ? "" : missing.detail).toMatch(/install the bubblewrap package/);
  });

  it.skipIf(host === undefined)(
    "reports missing user namespaces when the kernel refuses them",
    () => {
      // A user namespace may cap its own nesting at zero. Inside one, bwrap fails exactly as on a
      // host with user namespaces off, and the host's own setting is never touched.
      const restricted = spawnSync(
        "/usr/bin/unshare",
        [
          "--map-root-user",
          "/bin/sh",
          "-c",
          'echo 0 > /proc/sys/user/max_user_namespaces && exec "$0" "$1"',
          requireHost().node,
          PROBE_ONCE,
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      expect(restricted.status, restricted.stderr).toBe(0);
      const verdict: unknown = JSON.parse(restricted.stdout);
      expect(verdict).toMatchObject({ ok: false, reason: "userns_unavailable" });
      expect(verdict).toMatchObject({ detail: expect.stringMatching(/max_user_namespaces is 0/) });
    },
  );
});
