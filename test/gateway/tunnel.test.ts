import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { superviseTunnel, type TunnelProcess } from "../../src/gateway/tunnel.ts";
import { captureLogger } from "../helpers/log.ts";

/** Roadmap 2.7: heel runs the Cloudflare tunnel alongside itself and restarts it. */

class FakeProcess extends EventEmitter implements TunnelProcess {
  killed: string | null = null;
  stderr = new EventEmitter();
  kill(signal?: string) {
    this.killed = signal ?? "SIGTERM";
    setImmediate(() => this.emit("close", null, this.killed));
  }
}

describe("the tunnel heel runs", () => {
  it("runs cloudflared with the config, restarts it with a growing delay, and stops it with heel", async () => {
    const spawned: { args: readonly string[]; proc: FakeProcess }[] = [];
    const { logger } = captureLogger();
    const tunnel = superviseTunnel({
      config: "/heel/cloudflared.yml",
      log: logger,
      minDelayMs: 5,
      maxDelayMs: 20,
      spawn: (command, args) => {
        expect(command).toBe("cloudflared");
        const proc = new FakeProcess();
        spawned.push({ args, proc });
        return proc;
      },
    });
    expect(spawned[0]?.args).toEqual(["tunnel", "--config", "/heel/cloudflared.yml", "run"]);
    spawned[0]?.proc.emit("close", 1, null);
    await new Promise((r) => setTimeout(r, 15));
    expect(spawned).toHaveLength(2);
    const last = spawned[1]?.proc;
    await tunnel.stop();
    expect(last?.killed).toBe("SIGTERM");
    await new Promise((r) => setTimeout(r, 30));
    expect(spawned).toHaveLength(2);
  });

  it("gives up, once, when cloudflared isn't installed", async () => {
    const spawned: FakeProcess[] = [];
    const { logger, output } = captureLogger();
    const tunnel = superviseTunnel({
      config: "/heel/cloudflared.yml",
      log: logger,
      minDelayMs: 1,
      spawn: () => {
        const proc = new FakeProcess();
        spawned.push(proc);
        return proc;
      },
    });
    spawned[0]?.emit(
      "error",
      Object.assign(new Error("spawn cloudflared ENOENT"), { code: "ENOENT" }),
    );
    spawned[0]?.emit("close", null, null);
    await new Promise((r) => setTimeout(r, 10));
    expect(spawned).toHaveLength(1);
    expect(output()).toContain("cloudflared isn't installed");
    await tunnel.stop();
  });

  it("tries again after a start that fails another way, and doesn't wait on a process that's gone", async () => {
    const spawned: FakeProcess[] = [];
    const { logger, output } = captureLogger("info");
    const tunnel = superviseTunnel({
      config: "/heel/cloudflared.yml",
      log: logger,
      minDelayMs: 2,
      spawn: () => {
        const proc = new FakeProcess();
        spawned.push(proc);
        return proc;
      },
    });
    spawned[0]?.emit("error", Object.assign(new Error("spawn EACCES"), { code: "EACCES" }));
    spawned[0]?.emit("close", -13, null);
    await new Promise((r) => setTimeout(r, 15));
    expect(spawned.length).toBeGreaterThanOrEqual(2);
    spawned
      .at(-1)
      ?.stderr?.emit(
        "data",
        Buffer.from("2026-11-22T06:00:00Z ERR Couldn't connect to the edge\n"),
      );
    expect(output()).toContain("Couldn't connect to the edge");
    // The running one ends on its own: stop() returns at once.
    spawned.at(-1)?.emit("close", 0, null);
    const started = Date.now();
    await tunnel.stop();
    expect(Date.now() - started).toBeLessThan(100);
  });

  it("kills cloudflared if it doesn't stop in time", async () => {
    const proc = new (class extends FakeProcess {
      override kill(signal?: string) {
        this.killed = signal ?? "SIGTERM";
        if (signal === "SIGKILL") setImmediate(() => this.emit("close", null, "SIGKILL"));
      }
    })();
    const { logger } = captureLogger();
    const tunnel = superviseTunnel({
      config: "/c.yml",
      log: logger,
      killAfterMs: 5,
      spawn: () => proc,
    });
    await tunnel.stop();
    expect(proc.killed).toBe("SIGKILL");
  });
});
