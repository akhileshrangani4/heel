import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { hoistedDependencies } from "./install.ts";
import {
  fromWire,
  lineReader,
  MAX_LINE,
  parseFromHost,
  type ToHost,
  toWireModules,
  type WireStep,
} from "./protocol.ts";
import type { StubModule } from "./stubs.ts";
import type { CodeWorker, ScriptLimits, Step } from "./worker.ts";

/**
 * Code mode where bubblewrap isn't available (macOS, Windows, a container
 * without the extra flags, a VPS without user namespaces): one long-lived
 * `heel codemode-host` per heel, running every script with Monty compiled to
 * WebAssembly. This file is heel's side of it; `host-main.ts` is the helper.
 *
 * The helper runs under Node's permission model with an empty environment:
 * it may read heel's install (to load its code and Monty's WebAssembly) and
 * start worker threads, and nothing else. It holds no credentials; every
 * host call a script makes comes back here and goes through the pipeline.
 *
 * Two classes with two lifetimes:
 *
 * - `CodemodeHost` is heel's handle on the helper process. `serve.ts` makes
 *   one and closes it with heel. It starts the helper when the first script
 *   needs it, and again after a crash.
 * - `HostedCodeWorker` is one script on that helper, made for one `run_code`
 *   and stopped by whoever made it.
 *
 * A script is running, then over, then forgotten:
 *
 * - It is over once it has a final step: its own `done` or `failed`, or one
 *   heel gives it because it was stopped, the helper died, or heel is
 *   closing. From then on every answer heel tries to send gets that step
 *   back and nothing reaches the helper.
 * - It is forgotten (dropped from the table) once its worker thread is known
 *   to be gone, and only then does `stop` settle, because the caller holds
 *   the script's slot until it does.
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
  /** Told when the helper exits, with the end of what it wrote to stderr; heel logs it. */
  onExit?: (exit: HelperExit) => void;
}

export interface HelperExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The last few KB of the helper's stderr, or a spawn error. */
  detail: string;
}

/** What heel keeps about one script while the helper runs it. */
interface HostedScript {
  stdout: (text: string) => void;
  /** Settles the step heel is waiting for, if it is waiting for one. */
  awaitingStep: ((step: WireStep) => void) | null;
  /** Set once the script is over; every later step asked of it is this one. */
  finalStep: WireStep | null;
  /**
   * The final step came from the helper, so the helper is already discarding
   * the script's idle worker and `stop` has nothing to ask it or wait for.
   */
  endedInHelper: boolean;
  /** The script's own time limit: a stopped script's worker is gone by then. */
  timeLimitMs: number;
  /** Set once heel stops the script; settles when its worker is gone. */
  stopping: Promise<void> | null;
  /** Settles `stopping`: the helper said `ended`, the helper died, or heel is closing. */
  workerGone: (() => void) | null;
}

/** How long past a script's time limit heel waits for its worker to go before restarting the helper. */
const STOP_SLACK_MS = 10_000;
/** How long past a script's time limit heel waits for any one step before giving up on the script. */
const STEP_SLACK_MS = 10_000;
/** The longest delay a Node timer takes; past it, setTimeout fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** How much of the helper's stderr heel keeps for the log. */
const STDERR_TAIL = 4096;
/** What the helper may read of heel's install: the parts it runs, as the bubblewrap worker mounts. */
const INSTALL_PARTS = ["bin", "src", "dist", "node_modules", "package.json"] as const;

const timerMs = (ms: number) => Math.min(Math.max(0, ms), MAX_TIMER_MS);
/** How long a closing heel waits for the helper to exit before killing it. */
const CLOSE_GRACE_MS = 2000;

const failed = (error: string): WireStep => ({ kind: "failed", error });

export class CodemodeHost {
  readonly #installDir: string;
  readonly #node: string;
  readonly #onExit: ((exit: HelperExit) => void) | undefined;
  #child: ChildProcess | null = null;
  readonly #scripts = new Map<string, HostedScript>();
  #closed = false;

  constructor(options: CodemodeHostOptions) {
    // The real path: Node checks reads against where a file really is, not the link to it.
    const install = resolve(options.installDir);
    this.#installDir = existsSync(install) ? realpathSync(install) : install;
    this.#node = options.node ?? process.execPath;
    this.#onExit = options.onExit;
  }

  /**
   * The flags that lock the helper down: read the parts of heel's install it
   * runs, start worker threads, nothing else. Node reads `*` in a path as a
   * wildcard, so an install path holding one is refused rather than widened.
   */
  args(): string[] {
    const install = this.#installDir;
    const reads = [
      ...INSTALL_PARTS.map((part) => join(install, part)).filter((p) => existsSync(p)),
      hoistedDependencies(install),
    ].filter((p) => p !== null);
    if ([install, ...reads].some((p) => p.includes("*"))) {
      throw new Error(`code mode can't run from a path with "*" in it: ${install}`);
    }
    return [
      "--permission",
      ...reads.map((p) => `--allow-fs-read=${p}`),
      "--allow-worker",
      "--disable-warning=SecurityWarning",
      join(install, "bin", "heel.js"),
      "codemode-host",
    ];
  }

  /** The running helper, started now if there isn't one. */
  #helper(): ChildProcess {
    if (this.#child !== null) return this.#child;
    const child = spawn(this.#node, this.args(), {
      cwd: this.#installDir,
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (text: string) => {
      stderr = (stderr + text).slice(-STDERR_TAIL);
    });
    child.stdin?.on("error", () => {});
    // A line heel can't read, or one past the protocol's longest, means the helper is broken
    // (or broken into): it goes, and every script on it fails.
    const broken = () => this.#kill(child);
    child.stdout?.on(
      "data",
      lineReader((raw) => this.#receive(raw, broken), {
        maxLine: MAX_LINE + 1024,
        onOverflow: broken,
      }),
    );
    const onExit = (code: number | null, signal: NodeJS.Signals | null, error?: Error) => {
      if (this.#child !== child) return;
      this.#child = null;
      this.#onExit?.({ code, signal, detail: error?.message ?? stderr.trim() });
      // Every script it ran is over, and so are their workers.
      for (const [id, script] of [...this.#scripts]) {
        this.#endWith(id, "the code-mode helper stopped");
        script.workerGone?.();
      }
    };
    child.on("exit", (code, signal) => onExit(code, signal));
    child.on("error", (error) => onExit(null, null, error));
    return child;
  }

  /** One line from the helper. One that doesn't parse breaks the helper; one for a script heel forgot is dropped. */
  #receive(raw: unknown, broken: () => void): void {
    const message = parseFromHost(raw);
    if (message === null) return broken();
    const script = this.#scripts.get(message.id);
    if (script === undefined) return;
    if (message.type === "ended") script.workerGone?.();
    else if (message.type === "stdout") script.stdout(message.text);
    else {
      if (message.step.kind !== "call") script.endedInHelper = true;
      this.#deliver(message.id, message.step);
    }
  }

  /**
   * Sends the helper one message. A result too big for the protocol goes as
   * an error at the call instead, so the script can carry on without it.
   */
  #send(message: ToHost): void {
    let line = JSON.stringify(message);
    if (line.length > MAX_LINE && message.type === "resume") {
      line = JSON.stringify({
        id: message.id,
        type: "raise",
        errorType: "RuntimeError",
        message: "the result is too large for code mode",
      } satisfies ToHost);
    }
    this.#helper().stdin?.write(`${line}\n`);
  }

  #kill(child: ChildProcess): void {
    child.kill("SIGKILL");
  }

  /** Hands a step to whoever is waiting for it; a step that isn't a call is the script's last. */
  #deliver(id: string, step: WireStep): void {
    const script = this.#scripts.get(id);
    if (script === undefined) return;
    if (step.kind !== "call") script.finalStep = step;
    const settle = script.awaitingStep;
    script.awaitingStep = null;
    settle?.(step);
  }

  /** Ends a script from heel's side. One that already ended keeps the step it ended with. */
  #endWith(id: string, error: string): void {
    const script = this.#scripts.get(id);
    if (script === undefined) return;
    script.finalStep ??= failed(error);
    this.#deliver(id, script.finalStep);
  }

  /** Registers a script and gives it the id its messages carry. Nothing is sent yet. */
  open(stdout: (text: string) => void, limits: ScriptLimits): string {
    if (this.#closed) throw new Error("code mode is shut down");
    const id = randomUUID();
    this.#scripts.set(id, {
      stdout,
      awaitingStep: null,
      finalStep: null,
      endedInHelper: false,
      timeLimitMs: limits.maxSeconds * 1000,
      stopping: null,
      workerGone: null,
    });
    return id;
  }

  /**
   * Sends one message for a script and waits for the step that answers it.
   * A step that doesn't come within the script's time limit (plus slack) ends
   * the script: whoever made it then stops it, which frees its worker.
   */
  next(id: string, message: ToHost): Promise<WireStep> {
    const script = this.#scripts.get(id);
    if (script === undefined) return Promise.resolve(failed("the script was stopped"));
    return new Promise<WireStep>((resolve) => {
      if (script.finalStep !== null) return resolve(script.finalStep);
      const deadline = setTimeout(
        () => this.#endWith(id, "the script didn't answer in time"),
        timerMs(script.timeLimitMs + STEP_SLACK_MS),
      );
      script.awaitingStep = (step) => {
        clearTimeout(deadline);
        resolve(step);
      };
      try {
        this.#send(message);
      } catch (error) {
        this.#endWith(
          id,
          `code mode couldn't start: ${error instanceof Error ? error.message : error}`,
        );
      }
    });
  }

  /**
   * Ends a script and settles once its worker is gone, so the caller holds the
   * script's slot until then. Safe to call again: every call gets the same wait.
   */
  stop(id: string): Promise<void> {
    const script = this.#scripts.get(id);
    if (script === undefined) return Promise.resolve();
    if (script.stopping !== null) return script.stopping;
    if (script.endedInHelper) {
      this.#scripts.delete(id);
      return Promise.resolve();
    }
    this.#endWith(id, "the script was stopped");
    script.stopping = this.#untilWorkerGone(id, script).finally(() => this.#scripts.delete(id));
    return script.stopping;
  }

  /**
   * Tells the helper to end a script and waits for it to say the worker is
   * gone. A script still computing can't be cut off mid-turn; its worker goes
   * at its time limit. If the helper hasn't let it go soon after that, heel
   * kills the helper, which ends every other script on it too; the next
   * script starts a new one.
   */
  #untilWorkerGone(id: string, script: HostedScript): Promise<void> {
    const child = this.#child;
    // No helper, so no worker: it died, or the script never reached it.
    if (child === null) return Promise.resolve();
    return new Promise<void>((settle) => {
      const backstop = setTimeout(
        () => {
          if (this.#child === child) child.kill("SIGKILL");
          settle();
        },
        timerMs(script.timeLimitMs + STOP_SLACK_MS),
      );
      script.workerGone = () => {
        clearTimeout(backstop);
        settle();
      };
      this.#send({ type: "stop", id });
    });
  }

  /** Kills the helper (tests use this to check heel survives it). */
  kill(): void {
    if (this.#child !== null) this.#kill(this.#child);
  }

  /** Ends every script and the helper, for good: no script starts after this. */
  async close(): Promise<void> {
    this.#closed = true;
    // Closing ends the helper, and every worker with it: nothing to wait for per script.
    for (const [id, script] of [...this.#scripts]) {
      this.#endWith(id, "code mode is shut down");
      script.workerGone?.();
      this.#scripts.delete(id);
    }
    const child = this.#child;
    this.#child = null;
    if (child === null) return;
    // The helper exits when its stdin ends.
    child.stdin?.end();
    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        done();
      }, CLOSE_GRACE_MS);
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
  #stopped = false;

  constructor(host: CodemodeHost) {
    this.#host = host;
  }

  async start(
    code: string,
    modules: readonly StubModule[],
    limits: ScriptLimits,
    stdout: (text: string) => void,
  ): Promise<Step> {
    // Stopped before it started (the client hung up first): the script never reaches the helper.
    if (this.#stopped) return { kind: "failed", error: "the script was stopped" };
    const id = this.#host.open(stdout, limits);
    this.#id = id;
    const start: ToHost = { id, type: "start", code, modules: toWireModules(modules), limits };
    return this.#step(id, await this.#host.next(id, start));
  }

  #step(id: string, step: WireStep): Step {
    return fromWire(step, async (answer) =>
      this.#step(id, await this.#host.next(id, { ...answer, id })),
    );
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    const id = this.#id;
    if (id !== null) await this.#host.stop(id);
  }
}
