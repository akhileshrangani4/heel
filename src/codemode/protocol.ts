import type { ScriptLimits, Step } from "./worker.ts";

/**
 * The line protocol between heel and `heel codemode-worker` (D6b): one JSON
 * object per line, each way, over the worker's stdin and stdout.
 *
 * heel → worker: `start` once, then `resume` or `raise` after each `call`.
 * worker → heel: `stdout` chunks as the script prints, and a `step` after
 * every turn. heel ends a script by killing the worker; there is no message
 * for it.
 */

/** A module as it crosses the boundary: functions as pairs, since a Map isn't JSON. */
export interface WireModule {
  module: string;
  stubs: string;
  functions: [string, string][];
}

export type ToWorker =
  | { type: "start"; code: string; modules: WireModule[]; limits: ScriptLimits }
  | { type: "resume"; value: unknown }
  | { type: "raise"; errorType: "PermissionError" | "RuntimeError"; message: string };

/** A step without its continuations, which stay on the worker's side. */
export type WireStep =
  | {
      kind: "call";
      module: string;
      fn: string;
      kwargs: Record<string, unknown>;
      positional: number;
    }
  | { kind: "done"; output: unknown }
  | { kind: "failed"; error: string };

export type FromWorker = { type: "stdout"; text: string } | { type: "step"; step: WireStep };

export function toWire(step: Step): WireStep {
  if (step.kind !== "call") return step;
  return {
    kind: "call",
    module: step.module,
    fn: step.fn,
    kwargs: step.kwargs,
    positional: step.positional,
  };
}

/** Splits a byte stream into JSON lines; a line that doesn't parse is `null`. */
export function lineReader(
  onMessage: (message: unknown) => void,
): (chunk: Buffer | string) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim() !== "") {
        try {
          onMessage(JSON.parse(line));
        } catch {
          onMessage(null);
        }
      }
      newline = buffer.indexOf("\n");
    }
  };
}
