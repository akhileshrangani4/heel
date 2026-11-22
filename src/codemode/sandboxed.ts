import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SandboxHost, SandboxProcess } from "../runner/index.ts";
import { startSandboxed } from "../runner/index.ts";
import { hoistedDependencies } from "./install.ts";
import {
  fromWire,
  lineReader,
  parseFromWorker,
  type ToWorker,
  toWireModules,
  type WireStep,
} from "./protocol.ts";
import type { StubModule } from "./stubs.ts";
import type { CodeWorker, ScriptLimits, Step } from "./worker.ts";

/**
 * A `CodeWorker` that runs each script in its own `heel codemode-worker`
 * under bubblewrap (D6b; spec: Code mode, "the worker boundary"):
 *
 * - no network namespace and no credentials: the runner gives it a clean
 *   environment with its own HOME and TMPDIR inside the sandbox;
 * - only the parts of heel's install the worker needs (`bin`, `src`,
 *   `node_modules`, `package.json`) are mounted, read-only; nothing else of
 *   the host is visible beyond the runner's base;
 * - a memory ceiling above Monty's own, and a wall-time backstop. Monty
 *   limits the script's own time; the backstop also covers time spent in
 *   heel's pipeline, so it's generous;
 * - when the worker ends, a step heel is waiting on, or asks for later,
 *   fails at once instead of waiting forever;
 * - stopping kills the whole sandbox, suspended script and all.
 */

export interface SandboxedWorkerOptions {
  host: SandboxHost;
  /** heel's install directory (where `bin/heel.js` lives), mounted read-only. */
  installDir: string;
  /** The runner; tests pass a stand-in. */
  start?: typeof startSandboxed;
}

/** The sandbox's wall-time backstop: the runner's default, or the script's limit plus slack if longer. */
const WALL_BACKSTOP_MS = 10 * 60 * 1000;
const WALL_SLACK_MS = 10_000;
/** Everything the worker writes: protocol lines and output. heel caps stdout itself. */
const OUTPUT_CEILING = 64 * 1024 * 1024;
/** What the worker needs of heel's install: `src` from source, `dist` in the npm package. */
const INSTALL_PARTS = ["bin", "src", "dist", "node_modules", "package.json"] as const;

/** The sandbox's memory ceiling: Node and Monty's worker on top of the script's budget. */
const MEMORY_CEILING = 1024 * 1024 * 1024;

export class SandboxedCodeWorker implements CodeWorker {
  readonly #options: SandboxedWorkerOptions;
  #process: SandboxProcess | null = null;
  #workRoot: string | null = null;
  #waiting: ((step: WireStep) => void) | null = null;
  /** Set once the worker has ended; every later step fails with it. */
  #ended: WireStep | null = null;

  constructor(options: SandboxedWorkerOptions) {
    // The runner takes only absolute, normalized paths: no trailing slash.
    this.#options = { ...options, installDir: resolve(options.installDir) };
  }

  async start(
    code: string,
    modules: readonly StubModule[],
    limits: ScriptLimits,
    stdout: (text: string) => void,
    snapshot?: string,
  ): Promise<Step> {
    const workRoot = mkdtempSync(join(tmpdir(), "heel-codemode-"));
    this.#workRoot = workRoot;
    const install = this.#options.installDir;
    let process: SandboxProcess;
    try {
      process = await (this.#options.start ?? startSandboxed)(this.#options.host, {
        binary: this.#options.host.node,
        args: [join(install, "bin", "heel.js"), "codemode-worker"],
        workRoot,
        cwd: workRoot,
        readOnlyPaths: [
          ...INSTALL_PARTS.map((part) => join(install, part)),
          ...[hoistedDependencies(install)].filter((p) => p !== null),
        ].filter((p) => existsSync(p)),
        network: { kind: "none" },
        stdin: "pipe",
        limits: {
          wallTimeMs: Math.max(WALL_BACKSTOP_MS, limits.maxSeconds * 1000 + WALL_SLACK_MS),
          memoryBytes: MEMORY_CEILING,
          maxOutputBytes: OUTPUT_CEILING,
        },
      });
    } catch (error) {
      rmSync(workRoot, { recursive: true, force: true });
      this.#workRoot = null;
      throw error;
    }
    this.#process = process;
    process.stderr.resume();
    process.stdin?.on("error", () => {});
    process.stdout.on(
      "data",
      lineReader((raw) => {
        const message = parseFromWorker(raw);
        if (message?.type === "stdout") stdout(message.text);
        else if (message?.type === "step") this.#deliver(message.step);
        else this.#deliver({ kind: "failed", error: "the worker sent a line that didn't parse" });
      }),
    );
    void process.done.then((outcome) => {
      this.#ended = {
        kind: "failed",
        error:
          outcome.kind === "limit"
            ? `the script passed its ${outcome.limit} limit`
            : outcome.kind === "sandbox_error"
              ? `the sandbox didn't start: ${outcome.detail}`
              : "the worker ended",
      };
      this.#deliver(this.#ended);
    });
    return this.#next({
      type: "start",
      code,
      modules: toWireModules(modules),
      limits,
      ...(snapshot === undefined ? {} : { snapshot }),
    });
  }

  #deliver(step: WireStep): void {
    const waiting = this.#waiting;
    this.#waiting = null;
    waiting?.(step);
  }

  #next(message: ToWorker): Promise<Step> {
    return new Promise<WireStep>((resolve) => {
      if (this.#ended !== null) return resolve(this.#ended);
      this.#waiting = resolve;
      this.#process?.stdin?.write(`${JSON.stringify(message)}\n`);
    }).then((step) => fromWire(step, (answer) => this.#next(answer)));
  }

  async stop(): Promise<void> {
    // A step still waiting (stopped from outside, as when the client hangs up) fails now, so its
    // run ends and gives up its slot instead of waiting forever.
    this.#ended = { kind: "failed", error: "the script was stopped" };
    this.#deliver(this.#ended);
    this.#process?.kill();
    await this.#process?.done.catch(() => {});
    this.#process = null;
    if (this.#workRoot !== null) rmSync(this.#workRoot, { recursive: true, force: true });
    this.#workRoot = null;
  }
}
