import { describe, expect, it } from "vitest";
import { decideSandboxHost, type HostFacts } from "../../src/runner/host.ts";
import { classifyTrial, usernsHint } from "../../src/runner/probe.ts";

const FACTS: HostFacts = {
  platform: "linux",
  arch: "x64",
  isExecutable: (path) => ["/usr/bin/bwrap", "/usr/bin/prlimit", "/opt/bwrap"].includes(path),
  systemDir: (path) =>
    path === "/bin"
      ? { path, kind: "symlink", target: "usr/bin" }
      : path === "/lib64"
        ? { path, kind: "dir" }
        : undefined,
  node: "/usr/bin/node",
  relay: "/opt/heel/src/runner/relay.ts",
};

describe("decideSandboxHost", () => {
  it("finds bwrap and prlimit in their standard places and mirrors the system dirs that exist", () => {
    expect(decideSandboxHost(FACTS)).toEqual({
      ok: true,
      host: {
        bwrap: "/usr/bin/bwrap",
        prlimit: "/usr/bin/prlimit",
        node: FACTS.node,
        relay: FACTS.relay,
        arch: "x64",
        systemDirs: [
          { path: "/bin", kind: "symlink", target: "usr/bin" },
          { path: "/lib64", kind: "dir" },
        ],
      },
    });
  });

  it("uses a configured bwrap path", () => {
    const detection = decideSandboxHost(FACTS, { bwrap: "/opt/bwrap" });
    expect(detection.ok && detection.host.bwrap).toBe("/opt/bwrap");
  });

  it("reports a missing bubblewrap, with how to install it", () => {
    const detection = decideSandboxHost({
      ...FACTS,
      isExecutable: (path) => path === "/usr/bin/prlimit",
    });
    expect(detection).toMatchObject({ ok: false, reason: "bwrap_missing" });
    expect(detection.ok ? "" : detection.detail).toMatch(/install the bubblewrap package/);
  });

  it("reports a configured bwrap that is relative or not there", () => {
    expect(decideSandboxHost(FACTS, { bwrap: "bwrap" })).toMatchObject({ reason: "bwrap_missing" });
    expect(decideSandboxHost(FACTS, { bwrap: "/nowhere/bwrap" })).toMatchObject({
      reason: "bwrap_missing",
    });
  });

  it("reports a missing prlimit", () => {
    const detection = decideSandboxHost({
      ...FACTS,
      isExecutable: (path) => path === "/usr/bin/bwrap",
    });
    expect(detection).toMatchObject({ ok: false, reason: "prlimit_missing" });
  });

  it("refuses hosts it has no sandbox for", () => {
    expect(decideSandboxHost({ ...FACTS, platform: "darwin" })).toMatchObject({
      reason: "unsupported_platform",
    });
    expect(decideSandboxHost({ ...FACTS, arch: "ia32" })).toMatchObject({
      reason: "unsupported_platform",
    });
  });
});

describe("classifyTrial", () => {
  const noSysctls = {};

  it("passes a trial program that exited 0", () => {
    expect(classifyTrial({ kind: "exited", code: 0 }, "", noSysctls)).toBeUndefined();
  });

  it("reports missing user namespaces from bwrap's own error", () => {
    const failure = classifyTrial(
      {
        kind: "sandbox_error",
        detail:
          "bwrap: Creating new namespace failed: nesting depth or /proc/sys/user/max_*_namespaces exceeded (ENOSPC)",
      },
      "",
      noSysctls,
    );
    expect(failure).toMatchObject({ ok: false, reason: "userns_unavailable" });
    expect(failure?.detail).toMatch(/seccomp profile must allow unshare/);
  });

  it("names the sysctl that turned user namespaces off", () => {
    const failure = classifyTrial(
      { kind: "sandbox_error", detail: "bwrap: setting up uid map: Permission denied" },
      "",
      { maxUserNamespaces: 0 },
    );
    expect(failure).toMatchObject({ reason: "userns_unavailable" });
    expect(failure?.detail).toMatch(/user\.max_user_namespaces is 0/);
  });

  it("reports any other sandbox error as is", () => {
    expect(
      classifyTrial(
        { kind: "sandbox_error", detail: "bwrap: Can't mount proc on /newroot/proc" },
        "",
        noSysctls,
      ),
    ).toEqual({
      ok: false,
      reason: "sandbox_failed",
      detail: "bwrap: Can't mount proc on /newroot/proc",
    });
  });

  it("reports a trial that ran but failed, with its first stderr line", () => {
    expect(
      classifyTrial({ kind: "exited", code: 127 }, "prlimit: failed\nmore\n", noSysctls),
    ).toEqual({
      ok: false,
      reason: "sandbox_failed",
      detail: "the trial program exited with status 127: prlimit: failed",
    });
  });

  it("reports a trial that hit a limit or was aborted", () => {
    expect(classifyTrial({ kind: "limit", limit: "time" }, "", noSysctls)).toMatchObject({
      reason: "sandbox_failed",
      detail: "the trial passed the time limit",
    });
    expect(classifyTrial({ kind: "aborted" }, "", noSysctls)).toMatchObject({
      reason: "sandbox_failed",
    });
  });
});

describe("usernsHint", () => {
  it("names the first switch that explains the failure", () => {
    expect(usernsHint({ maxUserNamespaces: 0, apparmorRestrict: 1 })).toMatch(
      /max_user_namespaces/,
    );
    expect(usernsHint({ unprivilegedUsernsClone: 0 })).toMatch(/unprivileged_userns_clone/);
    expect(usernsHint({ maxUserNamespaces: 1000, apparmorRestrict: 1 })).toMatch(/apparmor/);
  });

  it("has nothing to say when every switch allows user namespaces", () => {
    expect(
      usernsHint({ maxUserNamespaces: 1000, unprivilegedUsernsClone: 1, apparmorRestrict: 0 }),
    ).toBeUndefined();
    expect(usernsHint({})).toBeUndefined();
  });
});
