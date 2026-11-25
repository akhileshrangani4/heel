import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

/**
 * macOS's own sandbox (Seatbelt) around the code-mode helper. Node's
 * permission model only holds against the Python a script can write: code
 * that escaped Monty and WebAssembly into JavaScript could start a worker
 * thread with none of its limits (`--allow-worker`). Seatbelt is enforced by
 * the kernel for the whole process, threads included, so that worker gets
 * nothing more either: no reads outside what's listed here, no writes, no
 * network and no other programs.
 *
 * Checked by hand against the red team's escape probe: a worker started
 * with `execArgv: []` read `/etc/passwd` and `~/.ssh`, wrote to `/tmp` and
 * ran `/usr/bin/id` without this, and was refused all four with it.
 */

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Whether this host can wrap the helper in Seatbelt. */
export function seatbeltAvailable(): boolean {
  return process.platform === "darwin" && existsSync(SANDBOX_EXEC);
}

/** A path as Seatbelt compares it: real, and quoted for its profile language. */
function quoted(path: string): string {
  return JSON.stringify(existsSync(path) ? realpathSync(path) : path);
}

/**
 * Where a Node build keeps the libraries it loads: its own prefix, and
 * Homebrew's, since a Homebrew Node links ICU and OpenSSL from there. Only
 * read, and only shared libraries and the like live there.
 */
function nodeLibraries(node: string): string[] {
  const prefix = dirname(dirname(realpathSync(node)));
  return [
    prefix,
    "/opt/homebrew/opt",
    "/opt/homebrew/Cellar",
    "/opt/homebrew/lib",
    "/usr/local/opt",
    "/usr/local/Cellar",
    "/usr/local/lib",
  ].filter((p) => existsSync(p));
}

/** What an OpenSSL library says its config directory is, as `openssl version -d` prints it. */
const OPENSSLDIR = Buffer.from('OPENSSLDIR: "');
/** Longer than any real path: a "directory" past it is not one. */
const MAX_DIR = 1024;

/**
 * Pure: the config directory an OpenSSL library was built with. OpenSSL
 * keeps it as the text `OPENSSLDIR: "<dir>"`, which it returns for
 * `OpenSSL_version(OPENSSL_DIR)`; null when the library has none.
 */
export function opensslDir(library: Uint8Array): string | null {
  const bytes = Buffer.from(library.buffer, library.byteOffset, library.byteLength);
  const at = bytes.indexOf(OPENSSLDIR);
  if (at < 0) return null;
  const start = at + OPENSSLDIR.length;
  const end = bytes.indexOf('"', start);
  if (end < 0 || end - start > MAX_DIR) return null;
  const dir = bytes.subarray(start, end).toString("utf8");
  return isAbsolute(dir) ? dir : null;
}

/** The config file of the OpenSSL this process loaded, found once. */
let loadedConfig: string | null | undefined;

/**
 * The OpenSSL config this process's Node reads as it starts: `openssl.cnf`
 * in the config directory of the libcrypto it loaded. Node stops at startup
 * if it may not read it, and a Homebrew Node keeps it outside the rest of
 * the profile (`/opt/homebrew/etc/openssl@4`). macOS's own libcrypto, which
 * Node never uses, is skipped: it lives in the system's shared cache, not
 * on disk. Null when Node has OpenSSL built in (Node's own builds look under
 * `/System/Library/OpenSSL`, which the profile already allows).
 */
function ownOpensslConfig(): string | null {
  // Only the report's list of loaded libraries is read; the rest is dropped here.
  const report = process.report?.getReport() as { sharedObjects?: unknown } | undefined;
  const loaded = Array.isArray(report?.sharedObjects) ? report.sharedObjects : [];
  for (const library of loaded) {
    if (typeof library !== "string" || !/^libcrypto[.-]/.test(basename(library))) continue;
    if (library.startsWith("/usr/lib/") || library.startsWith("/System/")) continue;
    try {
      const dir = opensslDir(readFileSync(library));
      if (dir !== null) return join(dir, "openssl.cnf");
    } catch {
      // A library heel can't read: the helper finds out, and the startup check says so.
    }
  }
  return null;
}

/**
 * The OpenSSL config file `node` reads at startup, when that's the Node
 * heel runs on: the libraries this process loaded say which OpenSSL that
 * is. Null for another Node, whose libraries heel hasn't seen.
 */
export function opensslConfig(node: string): string | null {
  const real = (path: string) => (existsSync(path) ? realpathSync(path) : path);
  if (real(node) !== real(process.execPath)) return null;
  if (loadedConfig === undefined) loadedConfig = ownOpensslConfig();
  return loadedConfig;
}

export interface SeatbeltInput {
  /** The Node binary the helper runs on. */
  node: string;
  /** heel's install directory: its listing is read when a worker starts. */
  install: string;
  /** What the helper may read of heel: the same paths as its `--allow-fs-read` flags. */
  reads: readonly string[];
  /** The OpenSSL config file Node reads at startup; `opensslConfig(node)` when left out. */
  opensslConfig?: string | null;
}

/**
 * The profile: deny everything, then allow running Node itself, reading
 * what Node, the system and heel's install need, and file metadata (stat,
 * which names exist but not what's in them). Of OpenSSL's config directory
 * only its config file is readable, not the keys or certificates beside it.
 * Nothing is writable and nothing reaches the network.
 */
export function seatbeltProfile(input: SeatbeltInput): string {
  const { node, install, reads } = input;
  const read = (paths: readonly string[], kind: "subpath" | "literal") =>
    paths.map((p) => `(${kind} ${quoted(p)})`).join(" ");
  const openssl = input.opensslConfig === undefined ? opensslConfig(node) : input.opensslConfig;
  return [
    "(version 1)",
    "(deny default)",
    `(allow process-exec (literal ${quoted(node)}))`,
    "(allow sysctl-read)",
    "(allow file-read-metadata)",
    `(allow file-read* (literal "/") (literal ${quoted(node)}) (subpath "/usr") (subpath "/System") (subpath "/dev"))`,
    `(allow file-read* ${read(nodeLibraries(node), "subpath")})`,
    ...(openssl === null ? [] : [`(allow file-read* ${read([openssl], "literal")})`]),
    `(allow file-read* (literal ${quoted(install)}) ${read(reads, "subpath")})`,
  ].join("\n");
}
