import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CodemodeHost, HostedCodeWorker } from "../../src/codemode/hosted.ts";
import { checkCodeMode, probeCodeMode } from "../../src/codemode/self-test.ts";
import type { CodeWorker, Step } from "../../src/codemode/worker.ts";
import { captureLogger } from "../helpers/log.ts";

/**
 * The check heel makes as it starts: one tiny script, so code mode that
 * can't run is in the log and `heel status` before an agent finds out.
 */

const INSTALL_DIR = fileURLToPath(new URL("../..", import.meta.url));

/** A worker that answers with `step` (or waits for `stop`), and counts its stops. */
function stub(step: Step | Error | "hang"): CodeWorker & { stops: number } {
  let release: ((step: Step) => void) | null = null;
  return {
    stops: 0,
    async start() {
      if (step instanceof Error) throw step;
      if (step === "hang") return new Promise<Step>((resolve) => (release = resolve));
      return step;
    },
    async stop() {
      this.stops += 1;
      release?.({ kind: "failed", error: "the script was stopped" });
    },
  };
}

/** A helper that dies at startup the way Node does when Seatbelt hides its OpenSSL config. */
class DeadHelper extends CodemodeHost {
  override command(): { file: string; args: string[] } {
    const stderr = "node: OpenSSL configuration error:\ncalling fopen(/x/openssl.cnf, rb)\n";
    return {
      file: process.execPath,
      args: ["-e", `process.stderr.write(${JSON.stringify(stderr)}, () => process.exit(1))`],
    };
  }
}

describe("the code-mode startup check", () => {
  it("is ready when the script answers 2, and stops its worker", async () => {
    const worker = stub({ kind: "done", output: 2 });
    expect(await probeCodeMode(worker)).toEqual({ state: "ready" });
    expect(worker.stops).toBe(1);
  });

  it("is broken with the script's error, any other answer, or a worker that throws", async () => {
    const failing = stub({ kind: "failed", error: "the sandbox didn't start: no bwrap" });
    expect(await probeCodeMode(failing)).toEqual({
      state: "broken",
      reason: "the sandbox didn't start: no bwrap",
    });
    expect(failing.stops).toBe(1);
    expect(await probeCodeMode(stub({ kind: "done", output: 3 }))).toEqual({
      state: "broken",
      reason: 'the test script ended with "done", not 2',
    });
    expect(await probeCodeMode(stub(new Error("spawn EACCES")))).toEqual({
      state: "broken",
      reason: "spawn EACCES",
    });
  });

  it("logs why code mode can't run, at error, and says so to heel status", async () => {
    const { logger, output } = captureLogger();
    const check = checkCodeMode({
      worker: stub({ kind: "failed", error: "the code-mode helper couldn't start: boom" }),
      log: logger,
    });
    expect(check.health()).toEqual({ state: "checking" });
    await check.done;
    expect(check.health()).toEqual({
      state: "broken",
      reason: "the code-mode helper couldn't start: boom",
    });
    const line = JSON.parse(output().trim().split("\n").at(-1) ?? "{}");
    expect(line).toMatchObject({
      level: 50,
      code: "codemode_broken",
      reason: "the code-mode helper couldn't start: boom",
      msg: "code mode can't run, so every run_code call fails: the code-mode helper couldn't start: boom",
    });
  });

  it("logs a working code mode at info, and frees what it ran on", async () => {
    const { logger, output } = captureLogger();
    let released = 0;
    const check = checkCodeMode({
      worker: stub({ kind: "done", output: 2 }),
      log: logger,
      release: async () => {
        released += 1;
      },
    });
    await check.done;
    expect(check.health()).toEqual({ state: "ready" });
    expect(output()).toContain("code mode checked: a test script ran");
    expect(released).toBe(1);
  });

  it("drops what it finds once heel is closing, without logging an error", async () => {
    const { logger, output } = captureLogger();
    const worker = stub("hang");
    const check = checkCodeMode({ worker, log: logger });
    await check.close();
    expect(worker.stops).toBeGreaterThan(0);
    expect(check.health()).toEqual({ state: "checking" });
    expect(output()).toBe("");
  });

  it("runs on the real helper", async () => {
    const helper = new CodemodeHost({ installDir: INSTALL_DIR });
    const { logger } = captureLogger();
    const check = checkCodeMode({
      worker: new HostedCodeWorker(helper),
      log: logger,
      release: () => helper.close(),
    });
    expect(await check.done).toEqual({ state: "ready" });
    expect(helper.pid).toBeNull();
  }, 30_000);

  it("finds a helper that can't start, with Node's own reason", async () => {
    const helper = new DeadHelper({ installDir: INSTALL_DIR, seatbelt: false });
    const { logger } = captureLogger();
    const check = checkCodeMode({
      worker: new HostedCodeWorker(helper),
      log: logger,
      release: () => helper.close(),
    });
    expect(await check.done).toEqual({
      state: "broken",
      reason:
        "the code-mode helper couldn't start: node: OpenSSL configuration error: " +
        "calling fopen(/x/openssl.cnf, rb) (more in heel's log: heel logs)",
    });
  }, 30_000);
});
