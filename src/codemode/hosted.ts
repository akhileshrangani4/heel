import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { lineReader, parseFromHost, type ToHost, type WireStep } from "./protocol.ts";
import { hoistedDependencies } from "./sandboxed.ts";
import type { StubModule } from "./stubs.ts";
import type { CodeWorker, ScriptLimits, Step } from "./worker.ts";

/**
 * Code mode where bubblewrap isn't available (macOS, Windows, a container
 * without the extra flags, a VPS without user namespaces): one long-lived
 * `heel codemode-host` per heel, running every script with Monty compiled to
 * WebAssembly.
 *
 * The helper runs under Node's permission model with an empty environment:
 * it may read heel's install (to load its code and Monty's WebAssembly) and
 * start worker threads, and nothing else. It holds no credentials; every
 * host call a script makes comes back here and goes through the pipeline.
 *
 * If the helper dies, every script it was running fails (never retried,
 * since a write may have happened), heel keeps running, and the next script
 * starts a new helper.
 */

export interface CodemodeHostOptions {
  /** heel's install directory (where `bin/heel.js` lives). */
  installDir: string;
  /** Node to run the helper with; heel's own by default. */
  node?: string;
}

interface Running {
  stdout: (text: string) => void;
  waiting: ((step: WireStep) => void) | null;
  ended: WireStep | null;
}

export class CodemodeHost {
  readonly #installDir: string;
  readonly #node: string;
  #child: ChildProcess | null = null;
  readonly #scripts = new Map<string, Running>();
  #closed = false;

  constructor(options: CodemodeHostOptions) {
    this.#installDir = resolve(options.installDir);
    this.#node = options.node ?? process.execPath;
  }

  /** The flags that lock the helper down: read heel's install, start worker threads, nothing else. */
  args(): string[] {
    const install = this.#installDir;
    const reads = [install, hoistedDependencies(install)].filter((p) => p !== null);
    return [
      "--permission",
      ...reads.map((p) => `--allow-fs-read=${p}`),
      "--allow-worker",
      "--disable-warning=SecurityWarning",
      join(install, "bin", "heel.js"),
      "codemode-host",
    ];
  }

  #ensure(): ChildProcess {
    if (this.#child !== null) return this.#child;
    const child = spawn(this.#node, this.args(), {
      cwd: this.#installDir,
      env: {},
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.#child = child;
    child.stdin?.on("error", () => {});
    child.stdout?.on(
      "data",
      lineReader((raw) => {
        const message = parseFromHost(raw);
        if (message === null) return;
        const script = this.#scripts.get(message.id);
        if (script === undefined) return;
        if (message.type === "stdout") script.stdout(message.text);
        else this.#deliver(message.id, message.step);
      }),
    );
    const gone = () => {
      if (this.#child !== child) return;
      this.#child = null;
      for (const id of [...this.#scripts.keys()]) {
        this.#end(id, { kind: "failed", error: "the code-mode helper stopped" });
      }
    };
    child.on("exit", gone);
    child.on("error", gone);
    return child;
  }

  #send(message: ToHost): void {
    this.#ensure().stdin?.write(`${JSON.stringify(message)}\n`);
  }

  #deliver(id: string, step: WireStep): void {
    const script = this.#scripts.get(id);
    if (script === undefined) return;
    if (step.kind !== "call") script.ended = step;
    const waiting = script.waiting;
    script.waiting = null;
    waiting?.(step);
  }

  #end(id: string, step: WireStep): void {
    const script = this.#scripts.get(id);
    if (script === undefined) return;
    script.ended ??= step;
    this.#deliver(id, script.ended);
  }

  /** Sends one message for a script and waits for the step that answers it. */
  next(id: string, message: ToHost): Promise<WireStep> {
    const script = this.#scripts.get(id);
    if (script === undefined)
      return Promise.resolve({ kind: "failed", error: "the script was stopped" });
    return new Promise<WireStep>((resolve) => {
      if (script.ended !== null) return resolve(script.ended);
      script.waiting = resolve;
      this.#send(message);
    });
  }

  open(stdout: (text: string) => void): string {
    if (this.#closed) throw new Error("code mode is shut down");
    const id = randomUUID();
    this.#scripts.set(id, { stdout, waiting: null, ended: null });
    return id;
  }

  stop(id: string): void {
    if (!this.#scripts.has(id)) return;
    this.#end(id, { kind: "failed", error: "the script was stopped" });
    this.#scripts.delete(id);
    if (this.#child !== null) this.#send({ type: "stop", id });
  }

  /** Kills the helper (tests use this to check heel survives it). */
  kill(): void {
    this.#child?.kill("SIGKILL");
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const id of [...this.#scripts.keys()]) this.stop(id);
    const child = this.#child;
    this.#child = null;
    if (child === null) return;
    child.stdin?.end();
    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        done();
      }, 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        done();
      });
    });
  }
}

/** One script on the shared helper. */
export class HostedCodeWorker implements CodeWorker {
  readonly #host: CodemodeHost;
  #id: string | null = null;

  constructor(host: CodemodeHost) {
    this.#host = host;
  }

  async start(
    code: string,
    modules: readonly StubModule[],
    limits: ScriptLimits,
    stdout: (text: string) => void,
  ): Promise<Step> {
    const id = this.#host.open(stdout);
    this.#id = id;
    return this.#step(
      await this.#host.next(id, {
        id,
        type: "start",
        code,
        modules: modules.map((m) => ({
          module: m.module,
          stubs: m.stubs,
          functions: [...m.functions],
        })),
        limits,
      }),
    );
  }

  #step(step: WireStep): Step {
    const id = this.#id;
    if (step.kind !== "call") return step;
    if (id === null) return { kind: "failed", error: "the script was stopped" };
    return {
      ...step,
      resume: async (value) => this.#step(await this.#host.next(id, { id, type: "resume", value })),
      raise: async (errorType, message) =>
        this.#step(await this.#host.next(id, { id, type: "raise", errorType, message })),
    };
  }

  async stop(): Promise<void> {
    if (this.#id !== null) this.#host.stop(this.#id);
    this.#id = null;
  }
}
