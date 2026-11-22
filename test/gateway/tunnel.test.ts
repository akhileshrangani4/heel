import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { superviseTunnel, type TunnelProcess } from "../../src/gateway/tunnel.ts";
import { captureLogger } from "../helpers/log.ts";

/** Roadmap 2.7: heel runs the Cloudflare tunnel alongside itself and restarts it. */

class FakeProcess extends EventEmitter implements TunnelProcess {
  killed: string | null = null;
  kill(signal?: string) {
    this.killed = signal ?? "SIGTERM";
    setImmediate(() => this.emit("exit", null, this.killed));
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
    spawned[0]?.proc.emit("exit", 1, null);
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
    spawned[0]?.emit("exit", null, null);
    await new Promise((r) => setTimeout(r, 10));
    expect(spawned).toHaveLength(1);
    expect(output()).toContain("cloudflared isn't installed");
    await tunnel.stop();
  });
});
