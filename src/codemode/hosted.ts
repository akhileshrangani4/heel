import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  fromWire,
  lineReader,
  parseFromHost,
  type ToHost,
  toWireModules,
  type WireStep,
} from "./protocol.ts";
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
  /** The script's own time limit: a stopped script's worker is gone by then. */
  limitMs: number;
  /** Set once heel stops the script; settles when the helper says its worker is gone. */
  stopping: Promise<void> | null;
  gone: (() => void) | null;
  /** The script ended on its own in the helper, which is already discarding its idle worker. */
  finished: boolean;
}

/** How long past a script's time limit heel waits for its worker to go before restarting the helper. */
const STOP_SLACK_MS = 10_000;

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
        if (message.type === "ended") script.gone?.();
        else if (message.type === "stdout") script.stdout(message.text);
        else {
          if (message.step.kind !== "call") script.finished = true;
          this.#deliver(message.id, message.step);
        }
      }),
    );
    const gone = () => {
      if (this.#child !== child) return;
      this.#child = null;
      // Every script it ran is over, and so are their workers.
      for (const [id, script] of [...this.#scripts]) {
        this.#end(id, { kind: "failed", error: "the code-mode helper stopped" });
        script.gone?.();
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

  open(stdout: (text: string) => void, limits: ScriptLimits): string {
    if (this.#closed) throw new Error("code mode is shut down");
    const id = randomUUID();
    this.#scripts.set(id, {
      stdout,
      waiting: null,
      ended: null,
      limitMs: limits.maxSeconds * 1000,
      stopping: null,
      gone: null,
      finished: false,
    });
    return id;
  }

  /**
   * Ends a script and settles once its worker is gone, so the caller holds the
   * script's slot until then. A script still computing can't be cut off
   * mid-turn; its worker goes at its time limit. If the helper hasn't let it go
   * soon after that, heel restarts the helper.
   */
  stop(id: string): Promise<void> {
    const script = this.#scripts.get(id);
    if (script === undefined) return Promise.resolve();
    if (script.stopping !== null) return script.stopping;
    if (script.finished) {
      this.#scripts.delete(id);
      return Promise.resolve();
    }
    this.#end(id, { kind: "failed", error: "the script was stopped" });
    const child = this.#child;
    script.stopping = new Promise<void>((settle) => {
      if (child === null) return settle();
      const backstop = setTimeout(() => {
        if (this.#child === child) child.kill("SIGKILL");
        settle();
      }, script.limitMs + STOP_SLACK_MS);
      script.gone = () => {
        clearTimeout(backstop);
        settle();
      };
      this.#send({ type: "stop", id });
    }).finally(() => this.#scripts.delete(id));
    return script.stopping;
  }

  /** Kills the helper (tests use this to check heel survives it). */
  kill(): void {
    this.#child?.kill("SIGKILL");
  }

  async close(): Promise<void> {
    this.#closed = true;
    // Closing ends the helper, and every worker with it: nothing to wait for per script.
    for (const [id, script] of [...this.#scripts]) {
      this.#end(id, { kind: "failed", error: "code mode is shut down" });
      script.gone?.();
      this.#scripts.delete(id);
    }
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
    const id = this.#host.open(stdout, limits);
    this.#id = id;
    return this.#step(
      await this.#host.next(id, {
        id,
        type: "start",
        code,
        modules: toWireModules(modules),
        limits,
      }),
    );
  }

  #step(step: WireStep): Step {
    const id = this.#id;
    if (step.kind !== "call") return step;
    if (id === null) return { kind: "failed", error: "the script was stopped" };
    return fromWire(step, async (answer) =>
      this.#step(await this.#host.next(id, { ...answer, id })),
    );
  }

  async stop(): Promise<void> {
    const id = this.#id;
    if (id !== null) await this.#host.stop(id);
  }
}
