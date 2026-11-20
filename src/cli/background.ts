import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { adminCall } from "../admin/client.ts";
import type { HeelConfig } from "../config/schema.ts";

/**
 * heel in one terminal: `heel start` runs `heel serve` in the background,
 * `heel stop` ends it, and `heel logs` reads (or follows) what it writes.
 * A background heel writes its log to `$HEEL_HOME/logs/heel.log`.
 *
 * Formatting log lines is pure (`formatLogLine`) so tests can check it; the
 * rest is the I/O around a child process and a file.
 */

/** Rotated past this size when heel starts, keeping one older file. */
const MAX_LOG_BYTES = 10 * 1024 * 1024;

export function logFileOf(config: Pick<HeelConfig, "home">): string {
  return join(config.home, "logs", "heel.log");
}

/** What a running heel answers to `ping`. */
export interface Ping {
  version?: string;
  vault?: string;
  pid?: number;
  background?: boolean;
}

/** The running heel's `ping`, or null when none answers on the admin socket. */
export async function pingHeel(config: Pick<HeelConfig, "adminSocketPath">): Promise<Ping | null> {
  try {
    const response = await adminCall(config.adminSocketPath, { method: "ping" }, 2_000);
    return response.ok ? (response.result as Ping) : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type StartOutcome =
  | { kind: "started"; pid: number; ping: Ping }
  | { kind: "already"; ping: Ping }
  /** The child exited, or never answered; the log says why. */
  | { kind: "failed"; reason: string };

/**
 * Starts `heel serve` detached from this terminal, its output appended to
 * the log, and waits until it answers on the admin socket. `serveArgs` are
 * passed through (`--watch`, `--config`). The child gets HEEL_HOME set to
 * this config's home, so it opens the same heel this command looked at.
 */
export async function startInBackground(
  config: HeelConfig,
  env: Readonly<Record<string, string | undefined>>,
  serveArgs: readonly string[],
): Promise<StartOutcome> {
  const running = await pingHeel(config);
  if (running !== null) return { kind: "already", ping: running };

  const file = logFileOf(config);
  mkdirSync(join(config.home, "logs"), { recursive: true, mode: 0o700 });
  try {
    if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.1`);
  } catch {
    // No log yet.
  }
  const out = openSync(file, "a", 0o600);
  const entry = process.argv[1];
  if (entry === undefined) return { kind: "failed", reason: "can't tell where heel is installed" };
  const child = spawn(process.execPath, [...process.execArgv, entry, "serve", ...serveArgs], {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...env, HEEL_HOME: config.home, HEEL_BACKGROUND: "1" },
  });
  closeSync(out);
  let exited: number | null = null;
  child.on("exit", (code) => {
    exited = code ?? 1;
  });
  child.unref();

  for (let waited = 0; waited < 20_000; waited += 250) {
    await sleep(250);
    if (exited !== null) return { kind: "failed", reason: `heel exited (${exited})` };
    const ping = await pingHeel(config);
    if (ping !== null) return { kind: "started", pid: child.pid ?? ping.pid ?? 0, ping };
  }
  return { kind: "failed", reason: "heel didn't answer within 20 s" };
}

export type StopOutcome =
  | { kind: "stopped"; pid: number }
  | { kind: "not_running" }
  | { kind: "failed"; reason: string };

/**
 * Stops the heel that answers on the admin socket, background or not: it
 * asks heel for its own pid, so there's no pid file to go stale. SIGTERM
 * lets heel close its listeners and database first.
 */
export async function stopHeel(config: Pick<HeelConfig, "adminSocketPath">): Promise<StopOutcome> {
  const ping = await pingHeel(config);
  if (ping === null) return { kind: "not_running" };
  const pid = ping.pid;
  if (pid === undefined) {
    return {
      kind: "failed",
      reason: "this heel is too old to say its process id; stop it where it runs (Ctrl-C)",
    };
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
  for (let waited = 0; waited < 15_000; waited += 250) {
    await sleep(250);
    if ((await pingHeel(config)) === null) return { kind: "stopped", pid };
  }
  return { kind: "failed", reason: `heel (pid ${pid}) is still running after 15 s` };
}

const LEVELS: Record<number, string> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

/** `2026-11-19 18:37:36` in this computer's time zone. */
function localTime(at: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`;
}

/**
 * Pure: one log line for a person. heel logs JSON (one object a line); this
 * shows the time, level and message, then any other fields as key=value.
 * A line that isn't JSON (heel's banner) comes back as it is.
 */
export function formatLogLine(line: string): string {
  let entry: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return line;
    entry = parsed as Record<string, unknown>;
  } catch {
    return line;
  }
  const { level, time, msg, service: _service, pid: _pid, hostname: _host, ...rest } = entry;
  const at = typeof time === "number" ? localTime(new Date(time)) : "";
  const name = typeof level === "number" ? (LEVELS[level] ?? String(level)) : String(level ?? "");
  const extra = Object.entries(rest)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" ");
  return [at, name.toUpperCase().padEnd(5), typeof msg === "string" ? msg : "", extra]
    .filter((part) => part !== "")
    .join("  ");
}

/** The last `count` lines of a file, read from its end. */
export function lastLines(file: string, count: number): string[] {
  if (count <= 0 || !existsSync(file)) return [];
  const size = statSync(file).size;
  const want = Math.min(size, Math.max(64 * 1024, count * 1024));
  const buffer = Buffer.alloc(want);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buffer, 0, want, size - want);
  } finally {
    closeSync(fd);
  }
  const lines = buffer
    .toString("utf8")
    .split("\n")
    .filter((l) => l !== "");
  // The first line may be cut off when the read started mid-file.
  if (want < size) lines.shift();
  return lines.slice(-count);
}

/**
 * Prints new lines as heel writes them, until the process is stopped. It
 * starts over at the top when the file shrinks (heel rotated it).
 */
export async function followFile(file: string, from: number, write: (line: string) => void) {
  let offset = from;
  let partial = "";
  for (;;) {
    await sleep(500);
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      continue;
    }
    if (size < offset) offset = 0;
    if (size === offset) continue;
    const buffer = Buffer.alloc(size - offset);
    const fd = openSync(file, "r");
    try {
      readSync(fd, buffer, 0, buffer.length, offset);
    } finally {
      closeSync(fd);
    }
    offset = size;
    const lines = (partial + buffer.toString("utf8")).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) if (line !== "") write(line);
  }
}
