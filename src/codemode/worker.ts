import type { StubModule } from "./stubs.ts";

/**
 * What code mode needs from the thing that runs Python (D6a). The run loop
 * (`run.ts`) depends only on this, so the same loop drives Monty in-process
 * for tests and, in D6b, the `heel codemode-worker` subprocess under
 * bubblewrap.
 *
 * A script runs until it calls a host function, finishes, or fails:
 * - `call`: the script is suspended at `module.fn(**kwargs)`. The runner
 *   resumes it with a value, raises an error at the call site, or never
 *   resumes it at all (an ask or a pause): then `stop()` ends it for good.
 * - `done`: the script ended; `output` is its last expression.
 * - `failed`: a type error found before running, an uncaught exception, or a
 *   limit hit. Nothing after it runs.
 */
export type Step =
  | {
      kind: "call";
      module: string;
      fn: string;
      kwargs: Record<string, unknown>;
      /** Positional arguments given; heel's stubs are keyword-only. */
      positional: number;
      resume(value: unknown): Promise<Step>;
      raise(type: "PermissionError" | "RuntimeError", message: string): Promise<Step>;
    }
  | { kind: "done"; output: unknown }
  | { kind: "failed"; error: string };

export interface ScriptLimits {
  /** Host calls one script may make (spec: 200). */
  maxCalls: number;
  /** Wall time for the whole script, excluding time spent in heel (spec: 30 s). */
  maxSeconds: number;
  /** Bytes of memory the script may use (spec: 256 MB). */
  maxMemory: number;
  /** Bytes of stdout kept (spec: 1 MB); the rest is dropped. */
  maxStdout: number;
}

export const DEFAULT_LIMITS: ScriptLimits = {
  maxCalls: 200,
  maxSeconds: 30,
  maxMemory: 256 * 1024 * 1024,
  maxStdout: 1024 * 1024,
};

export interface CodeWorker {
  start(
    code: string,
    modules: readonly StubModule[],
    limits: ScriptLimits,
    stdout: (text: string) => void,
  ): Promise<Step>;
  /** Ends the script for good; a suspended one never resumes. */
  stop(): Promise<void>;
}
