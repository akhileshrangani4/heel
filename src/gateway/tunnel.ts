import { spawn as nodeSpawn } from "node:child_process";
import type { Logger } from "../log.ts";

/**
 * The Cloudflare tunnel heel runs alongside itself: `cloudflared
 * tunnel --config <file> run`, restarted with a growing delay whenever it
 * stops or fails to start, until heel stops. cloudflared's errors and warnings
 * go to heel's log as warnings, the rest at debug.
 */

export interface TunnelProcess {
  on(event: "close", listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: "error", listener: (error: Error & { code?: string }) => void): unknown;
  stdout?: { on(event: "data", listener: (chunk: Buffer) => void): unknown } | null;
  stderr?: { on(event: "data", listener: (chunk: Buffer) => void): unknown } | null;
  kill(signal?: NodeJS.Signals): unknown;
}

export type SpawnTunnel = (command: string, args: readonly string[]) => TunnelProcess;

const spawnReal: SpawnTunnel = (command, args) =>
  nodeSpawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });

export interface TunnelOptions {
  config: string;
  log: Logger;
  spawn?: SpawnTunnel;
  /** First restart delay; it doubles up to `maxDelayMs`, and resets after a minute up. */
  minDelayMs?: number;
  maxDelayMs?: number;
  /** How long `stop()` waits after SIGTERM before SIGKILL. */
  killAfterMs?: number;
  now?: () => number;
}

export interface RunningTunnel {
  stop(): Promise<void>;
}

/** cloudflared's own level marks: `ERR` and `WRN` lines are worth seeing at heel's default level. */
const NOTEWORTHY = /\b(ERR|WRN)\b/;

export function superviseTunnel(options: TunnelOptions): RunningTunnel {
  const spawn = options.spawn ?? spawnReal;
  const min = options.minDelayMs ?? 1_000;
  const max = options.maxDelayMs ?? 60_000;
  const killAfter = options.killAfterMs ?? 5_000;
  const now = options.now ?? Date.now;
  const log = options.log;
  let delay = min;
  let stopped = false;
  let child: TunnelProcess | null = null;
  let timer: NodeJS.Timeout | null = null;
  let closed: (() => void) | null = null;

  const start = () => {
    if (stopped) return;
    const startedAt = now();
    const proc = spawn("cloudflared", ["tunnel", "--config", options.config, "run"]);
    child = proc;
    let gone = false;
    const relay = (chunk: Buffer) => {
      for (const raw of chunk.toString("utf8").split("\n")) {
        const line = raw.trim();
        if (line === "") continue;
        if (NOTEWORTHY.test(line)) log.warn({ cloudflared: line }, "tunnel");
        else log.debug({ cloudflared: line }, "tunnel");
      }
    };
    proc.stdout?.on("data", relay);
    proc.stderr?.on("data", relay);
    // A failed start emits `error` and `close`, never `exit`; a run that ends emits `close`.
    const ended = (installed: boolean) => {
      if (gone) return;
      gone = true;
      child = null;
      if (closed !== null) {
        closed();
        return;
      }
      if (stopped) return;
      if (!installed) {
        // Nothing to restart: say so once, and keep heel running without the tunnel.
        stopped = true;
        log.error(
          { config: options.config },
          "cloudflared isn't installed, so the tunnel isn't running: the approval page is only on this machine",
        );
        return;
      }
      if (now() - startedAt > 60_000) delay = min;
      log.warn({ retryInMs: delay }, "the tunnel stopped; heel starts it again");
      timer = setTimeout(start, delay);
      timer.unref?.();
      delay = Math.min(delay * 2, max);
    };
    proc.on("error", (error) => {
      if (error.code !== "ENOENT") log.error({ err: error }, "the tunnel couldn't start");
      ended(error.code !== "ENOENT");
    });
    proc.on("close", (code, signal) => {
      if (!gone) log.debug({ code, signal }, "tunnel process ended");
      ended(true);
    });
    log.info({ config: options.config }, "tunnel started");
  };

  start();
  return {
    stop: () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      const running = child;
      if (running === null) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const kill = setTimeout(() => running.kill("SIGKILL"), killAfter);
        kill.unref?.();
        closed = () => {
          clearTimeout(kill);
          resolve();
        };
        running.kill("SIGTERM");
      });
    },
  };
}
