import type { Monty } from "@pydantic/monty";
// The classes come from the WebAssembly entry, which never loads the native addon: the
// locked-down helper refuses native addons. Both entries share these classes.
import {
  ExternalModule,
  FunctionSnapshot,
  FutureSnapshot,
  MontyComplete,
  type MontySession,
  type Snapshot,
} from "@pydantic/monty/wasm";
import type { StubModule } from "./stubs.ts";
import { plainValue } from "./values.ts";
import { type CodeWorker, MAX_SNAPSHOT_BYTES, type ScriptLimits, type Step } from "./worker.ts";

/**
 * A `CodeWorker` on `@pydantic/monty` 1.6.0 (pinned; behavior confirmed in
 * the D6 spike):
 *
 * - Host calls arrive as `FunctionSnapshot`s named `module.fn`. Imports also
 *   suspend as OS calls and are answered from the stubs; every other OS call
 *   (environment, files, network) is refused.
 * - A denial is raised with the error's name as the Python type, so
 *   `PermissionError` is catchable as such.
 * - The type check runs before the script, against the stubs.
 * - Over the suspension budget, Monty raises an error the script can't catch.
 * - The clock is fixed at the script's start and `random` is seeded, so a
 *   script can't read the time or entropy.
 * - Every script gets a fresh Monty worker (a process for the native build, a
 *   thread for WebAssembly), retired after it, so a stopped (never-resumed)
 *   script never shares a worker with the next. Monty hands workers out from
 *   a pool, so here a pool is always one worker used once.
 *
 * heel's own process never loads Monty. This runs inside `heel
 * codemode-worker` under bubblewrap with the native build, or inside `heel
 * codemode-host` with the WebAssembly build; tests also run it in-process.
 */

/** Suspensions each imported module costs: its stubs and the import itself. */
const SUSPENSIONS_PER_IMPORT = 2;

/** Which Monty build runs the script: the native addon, or WebAssembly in a worker thread. */
export type MontyBackend = "native" | "wasm";

/** One Monty worker that runs one script. Closing it kills the worker, suspended script and all. */
export type MontyPool = Pick<Monty, "checkout"> & Partial<AsyncDisposable>;

/**
 * Makes a pool of one single-use worker. `warm` starts the worker now instead
 * of on checkout, for a pool made ahead of the script that will use it.
 */
export async function createPool(backend: MontyBackend, warm = false): Promise<MontyPool> {
  const options = { minProcesses: warm ? 1 : 0, maxProcesses: 1, maxCheckoutsPerWorker: 1 };
  if (backend === "native") return (await import("@pydantic/monty")).Monty.create(options);
  const wasm = await import("@pydantic/monty/wasm");
  return wasm.Monty.create(options);
}

export class MontyWorker implements CodeWorker {
  readonly #source: MontyBackend | MontyPool;
  /** The pool this worker made for itself, and so closes itself. */
  #ownPool: MontyPool | null = null;
  #session: MontySession | null = null;

  /**
   * `source` is the Monty build to make a worker from, or a pool the caller
   * made ahead of time. The caller keeps a pool it passes in: this worker
   * closes only its session on it, and the caller closes the pool.
   */
  constructor(source: MontyBackend | MontyPool = "native") {
    this.#source = source;
  }

  async start(
    code: string,
    modules: readonly StubModule[],
    limits: ScriptLimits,
    stdout: (text: string) => void,
    snapshot?: string,
  ): Promise<Step> {
    const source = this.#source;
    if (typeof source === "string") this.#ownPool = await createPool(source);
    const pool = this.#ownPool ?? (source as MontyPool);
    this.#session = await pool.checkout({
      typeCheck: true,
      limits: {
        maxSuspensions: limits.maxCalls + SUSPENSIONS_PER_IMPORT * modules.length + 1,
        maxMemory: limits.maxMemory,
        maxFeedDurationSecs: limits.maxSeconds,
      },
      externalModules: Object.fromEntries(
        modules.map((m) => [
          m.module,
          new ExternalModule(
            Object.fromEntries(
              [...m.functions.keys()].map((fn) => [
                fn,
                () => {
                  throw new Error("heel answers host calls itself");
                },
              ]),
            ),
            { stubs: m.stubs },
          ),
        ]),
      ),
      osPolicy: { datetime: new Date(), randomStart: { seed: 0 } },
    });
    const session = this.#session;
    if (snapshot !== undefined) {
      // A parked script: Monty restores it suspended at the call it was parked at. Its
      // budget starts again on load, so heel counts the script's calls itself (run.ts).
      return this.#step(() =>
        session.loadSnapshot(Buffer.from(snapshot, "base64"), {
          printCallback: (_stream, text) => stdout(text),
        }),
      );
    }
    return this.#step(() =>
      session.feedStart(code, { printCallback: (_stream, text) => stdout(text) }),
    );
  }

  async #step(next: () => Promise<Snapshot>): Promise<Step> {
    let snap: Snapshot;
    try {
      snap = await next();
      while (snap instanceof FunctionSnapshot && snap.isOsFunction) {
        const os = snap;
        snap = await (os.functionName.startsWith("import")
          ? os.resumeAuto()
          : os.resumeNotHandled());
      }
    } catch (error) {
      return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
    }
    let output: unknown;
    let kwargs: Record<string, unknown>;
    try {
      if (snap instanceof MontyComplete) output = plainValue(snap.output, "output");
      kwargs =
        snap instanceof FunctionSnapshot
          ? (plainValue(snap.kwargs, "argument") as Record<string, unknown>)
          : {};
    } catch (error) {
      return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
    }
    if (snap instanceof MontyComplete) return { kind: "done", output };
    if (snap instanceof FutureSnapshot) {
      const waiting = snap;
      return {
        kind: "await",
        pending: [...waiting.pendingCallIds],
        resolve: (results) =>
          this.#step(() =>
            waiting.resume(
              results.map((r) => {
                if ("value" in r) return { callId: r.callId, value: r.value };
                const error = new Error(r.message);
                error.name = r.errorType;
                return { callId: r.callId, error };
              }),
            ),
          ),
      };
    }
    if (!(snap instanceof FunctionSnapshot)) {
      return {
        kind: "failed",
        error: `the script stopped at an unsupported point (${snap.constructor.name})`,
      };
    }
    const call = snap;
    const dot = call.functionName.indexOf(".");
    return {
      kind: "call",
      module: dot < 0 ? "" : call.functionName.slice(0, dot),
      fn: dot < 0 ? call.functionName : call.functionName.slice(dot + 1),
      kwargs,
      positional: call.args.length,
      callId: call.callId,
      resume: (value) => this.#step(() => call.resume(value)),
      future: () => this.#step(() => call.resumeFuture()),
      raise: (type, message) => {
        const error = new Error(message);
        error.name = type;
        return this.#step(() => call.resumeError(error));
      },
      park: async (): Promise<Step> => {
        try {
          const bytes = await call.dump();
          if (bytes.length > MAX_SNAPSHOT_BYTES) {
            return { kind: "failed", error: "the script holds too much to be saved" };
          }
          return { kind: "parked", snapshot: Buffer.from(bytes).toString("base64") };
        } catch (error) {
          return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
        }
      },
    };
  }

  async stop(): Promise<void> {
    const ownPool = this.#ownPool;
    const session = this.#session;
    this.#ownPool = null;
    this.#session = null;
    if (typeof this.#source !== "string") {
      // The caller's pool retires this session's worker (one checkout per worker), suspended script and all.
      await session?.close();
      return;
    }
    // Closing the pool kills its one worker, suspended script and all.
    await ownPool?.[Symbol.asyncDispose]?.();
  }
}
