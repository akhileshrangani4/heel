import {
  ExternalModule,
  FunctionSnapshot,
  Monty,
  MontyComplete,
  type MontySession,
  type Snapshot,
} from "@pydantic/monty";
import type { StubModule } from "./stubs.ts";
import { plainValue } from "./values.ts";
import type { CodeWorker, ScriptLimits, Step } from "./worker.ts";

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
 * - Every script gets a fresh worker process, retired after it, so a stopped
 *   (never-resumed) script never shares a worker with the next.
 *
 * In D6b this runs inside `heel codemode-worker` under bubblewrap; heel's own
 * process never loads Monty's native addon.
 */

/** Suspensions each imported module costs: its stubs and the import itself. */
const SUSPENSIONS_PER_IMPORT = 2;

export class MontyWorker implements CodeWorker {
  #pool: Monty | null = null;
  #session: MontySession | null = null;

  async start(
    code: string,
    modules: readonly StubModule[],
    limits: ScriptLimits,
    stdout: (text: string) => void,
  ): Promise<Step> {
    this.#pool = await Monty.create({ minProcesses: 0, maxProcesses: 1, maxCheckoutsPerWorker: 1 });
    this.#session = await this.#pool.checkout({
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
      resume: (value) => this.#step(() => call.resume(value)),
      raise: (type, message) => {
        const error = new Error(message);
        error.name = type;
        return this.#step(() => call.resumeError(error));
      },
    };
  }

  async stop(): Promise<void> {
    const pool = this.#pool;
    this.#pool = null;
    this.#session = null;
    // Closing the pool kills its one worker, suspended script and all.
    await pool?.[Symbol.asyncDispose]?.();
  }
}
