import { existsSync, realpathSync } from "node:fs";
import { dirname } from "node:path";

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

export interface SeatbeltInput {
  /** The Node binary the helper runs on. */
  node: string;
  /** heel's install directory: its listing is read when a worker starts. */
  install: string;
  /** What the helper may read of heel: the same paths as its `--allow-fs-read` flags. */
  reads: readonly string[];
}

/**
 * The profile: deny everything, then allow running Node itself, reading
 * what Node, the system and heel's install need, and file metadata (stat,
 * which names exist but not what's in them). Nothing is writable and
 * nothing reaches the network.
 */
export function seatbeltProfile({ node, install, reads }: SeatbeltInput): string {
  const read = (paths: readonly string[], kind: "subpath" | "literal") =>
    paths.map((p) => `(${kind} ${quoted(p)})`).join(" ");
  return [
    "(version 1)",
    "(deny default)",
    `(allow process-exec (literal ${quoted(node)}))`,
    "(allow sysctl-read)",
    "(allow file-read-metadata)",
    `(allow file-read* (literal "/") (literal ${quoted(node)}) (subpath "/usr") (subpath "/System") (subpath "/dev"))`,
    `(allow file-read* ${read(nodeLibraries(node), "subpath")})`,
    `(allow file-read* (literal ${quoted(install)}) ${read(reads, "subpath")})`,
  ].join("\n");
}
