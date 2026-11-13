/**
 * Gathers the host facts a sandbox plan depends on (`SandboxHost`): where
 * bubblewrap and prlimit live, which Node runs the egress relay, and how the
 * host lays out `/bin` and `/lib*`. Programs are found at fixed absolute
 * paths or the path an operator configures, never through `PATH`, so heel's
 * own environment can't redirect them.
 */
import { accessSync, constants, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SandboxHost, SystemDir } from "./plan.ts";
import { type SeccompArch, seccompArch } from "./seccomp.ts";

export const BWRAP_CANDIDATES: readonly string[] = ["/usr/bin/bwrap", "/usr/local/bin/bwrap"];
export const PRLIMIT_CANDIDATES: readonly string[] = ["/usr/bin/prlimit"];
/** Top-level directories a program may expect; merged-`/usr` hosts make them links into `/usr`. */
export const SYSTEM_DIR_PATHS: readonly string[] = [
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
];

export type HostUnavailableReason = "unsupported_platform" | "bwrap_missing" | "prlimit_missing";

export type HostDetection =
  | { readonly ok: true; readonly host: SandboxHost }
  | { readonly ok: false; readonly reason: HostUnavailableReason; readonly detail: string };

export interface DetectHostOptions {
  /** Absolute path to bwrap, instead of the standard locations. */
  readonly bwrap?: string;
  /** Absolute path to prlimit (util-linux), instead of the standard location. */
  readonly prlimit?: string;
}

/** The filesystem facts detection reads, injectable so the decision logic is testable. */
export interface HostFacts {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly isExecutable: (path: string) => boolean;
  readonly systemDir: (path: string) => SystemDir | undefined;
  readonly node: string;
  readonly relay: string;
}

export function detectSandboxHost(options: DetectHostOptions = {}): HostDetection {
  return decideSandboxHost(readHostFacts(), options);
}

/** Pure: the host, or the first reason it can't run a sandbox. */
export function decideSandboxHost(
  facts: HostFacts,
  options: DetectHostOptions = {},
): HostDetection {
  if (facts.platform !== "linux") {
    return unavailable(
      "unsupported_platform",
      `the sandbox needs Linux; this host is ${facts.platform}`,
    );
  }
  const arch: SeccompArch | undefined = seccompArch(facts.arch);
  if (arch === undefined) {
    return unavailable("unsupported_platform", `heel has no seccomp filter for ${facts.arch}`);
  }
  const bwrap = findExecutable(facts, options.bwrap, BWRAP_CANDIDATES);
  if (bwrap === undefined) {
    return unavailable(
      "bwrap_missing",
      `bubblewrap not found at ${(options.bwrap === undefined ? BWRAP_CANDIDATES : [options.bwrap]).join(" or ")}; install the bubblewrap package`,
    );
  }
  const prlimit = findExecutable(facts, options.prlimit, PRLIMIT_CANDIDATES);
  if (prlimit === undefined) {
    return unavailable(
      "prlimit_missing",
      `prlimit not found at ${(options.prlimit === undefined ? PRLIMIT_CANDIDATES : [options.prlimit]).join(" or ")}; install util-linux`,
    );
  }
  const systemDirs = SYSTEM_DIR_PATHS.flatMap((path) => facts.systemDir(path) ?? []);
  return {
    ok: true,
    host: { bwrap, prlimit, node: facts.node, relay: facts.relay, arch, systemDirs },
  };
}

function findExecutable(
  facts: HostFacts,
  configured: string | undefined,
  candidates: readonly string[],
): string | undefined {
  if (configured !== undefined) {
    return configured.startsWith("/") && facts.isExecutable(configured) ? configured : undefined;
  }
  return candidates.find((path) => facts.isExecutable(path));
}

function unavailable(reason: HostUnavailableReason, detail: string): HostDetection {
  return { ok: false, reason, detail };
}

function readHostFacts(): HostFacts {
  return {
    platform: process.platform,
    arch: process.arch,
    isExecutable,
    systemDir: readSystemDir,
    // Real paths, because bwrap binds a file at the path the plan names.
    node: realpathSync(process.execPath),
    relay: realpathSync(fileURLToPath(new URL("./relay.ts", import.meta.url))),
  };
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === false;
  } catch {
    // Not there, or not executable by heel: both mean heel can't use it.
    return false;
  }
}

function readSystemDir(path: string): SystemDir | undefined {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return undefined;
  if (stat.isSymbolicLink()) return { path, kind: "symlink", target: readlinkSync(path) };
  return stat.isDirectory() ? { path, kind: "dir" } : undefined;
}
