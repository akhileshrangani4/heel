import { spawn as nodeSpawn } from "node:child_process";
import type { Logger } from "../log.ts";

/**
 * The Cloudflare tunnel heel runs alongside itself (roadmap 2.7): `cloudflared
 * tunnel --config <file> run`, restarted with a growing delay whenever it
 * stops, until heel stops. cloudflared's own output goes to heel's log.
 */

export interface TunnelProcess {
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
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
  now?: () => number;
}

export interface RunningTunnel {
  stop(): Promise<void>;
}

export function superviseTunnel(options: TunnelOptions): RunningTunnel {
  const spawn = options.spawn ?? spawnReal;
  const min = options.minDelayMs ?? 1_000;
  const max = options.maxDelayMs ?? 60_000;
  const now = options.now ?? Date.now;
  const log = options.log;
  let delay = min;
  let stopped = false;
  let child: TunnelProcess | null = null;
  let timer: NodeJS.Timeout | null = null;
  let exited: (() => void) | null = null;

  const start = () => {
    if (stopped) return;
    const startedAt = now();
    const proc = spawn("cloudflared", ["tunnel", "--config", options.config, "run"]);
    child = proc;
    const relay = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim() !== "") log.debug({ cloudflared: line.trim() }, "tunnel");
      }
    };
    proc.stdout?.on("data", relay);
    proc.stderr?.on("data", relay);
    proc.on("error", (error) => {
      if (error.code === "ENOENT") {
        // Nothing to restart: say so once, and keep heel running without the tunnel.
        stopped = true;
        log.error(
          { config: options.config },
          "cloudflared isn't installed, so the tunnel isn't running: the approval page is only on this machine",
        );
      } else {
        log.error({ err: error }, "the tunnel couldn't start");
      }
    });
    proc.on("exit", (code, signal) => {
      child = null;
      if (exited !== null) {
        exited();
        return;
      }
      if (stopped) return;
      if (now() - startedAt > 60_000) delay = min;
      log.warn({ code, signal, retryInMs: delay }, "the tunnel stopped; heel starts it again");
      timer = setTimeout(start, delay);
      timer.unref?.();
      delay = Math.min(delay * 2, max);
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
        exited = resolve;
        running.kill("SIGTERM");
        setTimeout(resolve, 5_000).unref?.();
      });
    },
  };
}
