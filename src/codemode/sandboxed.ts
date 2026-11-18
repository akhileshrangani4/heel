import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SandboxHost, SandboxProcess } from "../runner/index.ts";
import { startSandboxed } from "../runner/index.ts";
import { type FromWorker, lineReader, type ToWorker, type WireStep } from "./protocol.ts";
import type { StubModule } from "./stubs.ts";
import type { CodeWorker, ScriptLimits, Step } from "./worker.ts";

/**
 * A `CodeWorker` that runs each script in its own `heel codemode-worker`
 * under bubblewrap (D6b; spec: Code mode, "the worker boundary"):
 *
 * - no network namespace and no credentials: the runner gives it a clean
 *   environment with its own HOME and TMPDIR inside the sandbox;
 * - heel's install is mounted read-only so the worker can load its code and
 *   Monty; nothing else of the host is visible beyond the runner's base;
 * - a wall-time and memory ceiling above Monty's own limits, so a script
 *   that escapes Monty's accounting still dies;
 * - stopping kills the whole sandbox, suspended script and all.
 */

export interface SandboxedWorkerOptions {
  host: SandboxHost;
  /** heel's install directory (where `bin/heel.js` lives), mounted read-only. */
  installDir: string;
}

/** Slack above Monty's own feed limit before the sandbox itself kills the worker. */
const WALL_SLACK_MS = 10_000;
/** The sandbox's memory ceiling: Node and Monty's worker on top of the script's budget. */
const MEMORY_CEILING = 1024 * 1024 * 1024;

export class SandboxedCodeWorker implements CodeWorker {
  readonly #options: SandboxedWorkerOptions;
  #process: SandboxProcess | null = null;
  #workRoot: string | null = null;
  #waiting: ((step: WireStep) => void) | null = null;

  constructor(options: SandboxedWorkerOptions) {
    // The runner takes only absolute, normalized paths: no trailing slash.
    this.#options = { ...options, installDir: resolve(options.installDir) };
  }

  async start(
    code: string,
    modules: readonly StubModule[],
    limits: ScriptLimits,
    stdout: (text: string) => void,
  ): Promise<Step> {
    const workRoot = mkdtempSync(join(tmpdir(), "heel-codemode-"));
    this.#workRoot = workRoot;
    const process = await startSandboxed(this.#options.host, {
      binary: this.#options.host.node,
      args: [join(this.#options.installDir, "bin", "heel.js"), "codemode-worker"],
      workRoot,
      cwd: workRoot,
      readOnlyPaths: [this.#options.installDir],
      network: { kind: "none" },
      stdin: "pipe",
      limits: {
        wallTimeMs: limits.maxSeconds * 1000 + WALL_SLACK_MS,
        memoryBytes: MEMORY_CEILING,
        maxOutputBytes: limits.maxStdout * 4 + 1024 * 1024,
      },
    });
    this.#process = process;
    process.stderr.resume();
    process.stdin?.on("error", () => {});
    process.stdout.on(
      "data",
      lineReader((raw) => {
        const message = raw as FromWorker | null;
        if (message?.type === "stdout") stdout(message.text);
        else if (message?.type === "step") this.#deliver(message.step);
        else this.#deliver({ kind: "failed", error: "the worker sent a line that didn't parse" });
      }),
    );
    void process.done.then((outcome) =>
      this.#deliver({
        kind: "failed",
        error:
          outcome.kind === "limit"
            ? `the script passed its ${outcome.limit} limit`
            : outcome.kind === "sandbox_error"
              ? `the sandbox didn't start: ${outcome.detail}`
              : "the worker ended",
      }),
    );
    return this.#next({
      type: "start",
      code,
      modules: modules.map((m) => ({
        module: m.module,
        stubs: m.stubs,
        functions: [...m.functions],
      })),
      limits,
    });
  }

  #deliver(step: WireStep): void {
    const waiting = this.#waiting;
    this.#waiting = null;
    waiting?.(step);
  }

  #next(message: ToWorker): Promise<Step> {
    return new Promise<WireStep>((resolve) => {
      this.#waiting = resolve;
      this.#process?.stdin?.write(`${JSON.stringify(message)}\n`);
    }).then((step) => this.#step(step));
  }

  #step(step: WireStep): Step {
    if (step.kind !== "call") return step;
    return {
      ...step,
      resume: (value) => this.#next({ type: "resume", value }),
      raise: (errorType, message) => this.#next({ type: "raise", errorType, message }),
    };
  }

  async stop(): Promise<void> {
    this.#waiting = null;
    this.#process?.kill();
    await this.#process?.done.catch(() => {});
    this.#process = null;
    if (this.#workRoot !== null) rmSync(this.#workRoot, { recursive: true, force: true });
    this.#workRoot = null;
  }
}
