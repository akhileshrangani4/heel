/**
 * The boot probe (spec: Risks, "User namespaces are restricted on Ubuntu
 * 24.04 and later and under Docker seccomp"). `heel serve` calls it once; if
 * it fails, `/run` and code mode refuse every call and the reason is logged,
 * while MCP and HTTP keep working.
 *
 * It decides by running real sandboxes, with every option heel uses, rather
 * than by reading sysctls: a host can have the AppArmor restriction on and
 * still allow bwrap through a profile. The sysctls only explain a failure.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DetectHostOptions, detectSandboxHost, type HostUnavailableReason } from "./host.ts";
import type { SandboxHost, SandboxSpec } from "./plan.ts";
import { runSandboxed, type SandboxOutcome } from "./run.ts";

export type SandboxUnavailableReason =
  | HostUnavailableReason
  /** bwrap is there, but the kernel or a security policy won't let it create user namespaces. */
  | "userns_unavailable"
  /** The sandbox failed for another reason; `detail` says what bwrap or the relay reported. */
  | "sandbox_failed";

export type SandboxProbe =
  | { readonly ok: true; readonly host: SandboxHost }
  | { readonly ok: false; readonly reason: SandboxUnavailableReason; readonly detail: string };

export interface ProbeOptions extends DetectHostOptions {
  /** Where the trial's empty work root is created; defaults to the OS temp directory. */
  readonly scratchDir?: string;
  /** Per trial; a sandbox that takes longer to start than this is treated as broken. */
  readonly timeoutMs?: number;
}

/** Sysctls that explain why unprivileged user namespaces fail. Absent ones are `undefined`. */
export interface UsernsSysctls {
  readonly maxUserNamespaces?: number;
  /** Debian's switch. */
  readonly unprivilegedUsernsClone?: number;
  /** Ubuntu 23.10+. */
  readonly apparmorRestrict?: number;
}

/** A program every supported host has under `/usr`. */
const TRIAL_BINARY = "/usr/bin/true";
const DEFAULT_TIMEOUT_MS = 15_000;
/** bwrap's messages when it can't create or configure a user namespace. */
const USERNS_FAILURE =
  /user namespace|uid map|gid map|setgroups|new namespace|unshare|operation not permitted|permission denied/i;

/**
 * Two trials: a bare sandbox, then one with egress, which also proves Node
 * and the relay run inside it.
 */
export async function probeSandbox(options: ProbeOptions = {}): Promise<SandboxProbe> {
  const detection = detectSandboxHost(options);
  if (!detection.ok) return detection;
  const { host } = detection;
  const workRoot = await realpath(
    await mkdtemp(join(options.scratchDir ?? tmpdir(), "heel-probe-")),
  );
  try {
    const base: SandboxSpec = {
      binary: TRIAL_BINARY,
      args: [],
      workRoot,
      cwd: workRoot,
      limits: { wallTimeMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    };
    const bare = await runSandboxed(host, base);
    const bareFailure = classifyTrial(
      bare.outcome,
      bare.stderr.toString("utf8"),
      readUsernsSysctls(),
    );
    if (bareFailure !== undefined) return bareFailure;

    // The discard port on loopback: never dialled, since `true` makes no connection.
    const egress = await runSandboxed(host, {
      ...base,
      network: { kind: "egress", allow: ["127.0.0.1:9"] },
    });
    const egressFailure = classifyTrial(
      egress.outcome,
      egress.stderr.toString("utf8"),
      readUsernsSysctls(),
    );
    if (egressFailure !== undefined) {
      return { ...egressFailure, detail: `the egress relay failed: ${egressFailure.detail}` };
    }
    return { ok: true, host };
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

/** Pure: why a trial run failed, or `undefined` if it succeeded. */
export function classifyTrial(
  outcome: SandboxOutcome,
  stderr: string,
  sysctls: UsernsSysctls,
): Extract<SandboxProbe, { ok: false }> | undefined {
  switch (outcome.kind) {
    case "exited": {
      if (outcome.code === 0) return undefined;
      const said = stderr.trim().split("\n")[0] ?? "";
      return {
        ok: false,
        reason: "sandbox_failed",
        detail: `the trial program exited with status ${outcome.code}${said === "" ? "" : `: ${said}`}`,
      };
    }
    case "limit":
      return {
        ok: false,
        reason: "sandbox_failed",
        detail: `the trial passed the ${outcome.limit} limit`,
      };
    case "aborted":
      return { ok: false, reason: "sandbox_failed", detail: "the trial was aborted" };
    case "sandbox_error": {
      const hint = usernsHint(sysctls);
      if (hint !== undefined || USERNS_FAILURE.test(outcome.detail)) {
        return {
          ok: false,
          reason: "userns_unavailable",
          detail: `bubblewrap can't create a user namespace (${outcome.detail}). ${hint ?? CONTAINER_HINT}`,
        };
      }
      return { ok: false, reason: "sandbox_failed", detail: outcome.detail };
    }
  }
}

const CONTAINER_HINT =
  "If heel runs in a container, its seccomp profile must allow unshare and clone with CLONE_NEWUSER (for Docker, a custom --security-opt seccomp profile).";

/** Pure: the sysctl to change, when one explains the failure. */
export function usernsHint(sysctls: UsernsSysctls): string | undefined {
  if (sysctls.maxUserNamespaces === 0) {
    return "user.max_user_namespaces is 0; set it above 0 (for example sysctl -w user.max_user_namespaces=15000).";
  }
  if (sysctls.unprivilegedUsernsClone === 0) {
    return "kernel.unprivileged_userns_clone is 0; set it to 1.";
  }
  if (sysctls.apparmorRestrict === 1) {
    return "kernel.apparmor_restrict_unprivileged_userns is 1; give bwrap an AppArmor profile that allows userns, or set it to 0.";
  }
  return undefined;
}

export function readUsernsSysctls(): UsernsSysctls {
  return {
    ...sysctl("maxUserNamespaces", "/proc/sys/user/max_user_namespaces"),
    ...sysctl("unprivilegedUsernsClone", "/proc/sys/kernel/unprivileged_userns_clone"),
    ...sysctl("apparmorRestrict", "/proc/sys/kernel/apparmor_restrict_unprivileged_userns"),
  };
}

function sysctl(key: keyof UsernsSysctls, path: string): UsernsSysctls {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // The kernel doesn't have this switch, so it can't be the cause.
    return {};
  }
  const value = Number(text.trim());
  return Number.isInteger(value) ? { [key]: value } : {};
}
