import { StringDecoder } from "node:string_decoder";
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

/**
 * What heel accepts from the worker, checked field by field: a compromised
 * worker could send anything, and what the pipeline checks must be exactly
 * what runs. Null for anything else.
 */
export function parseFromWorker(raw: unknown): FromWorker | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (m["type"] === "stdout") {
    return typeof m["text"] === "string" ? { type: "stdout", text: m["text"] } : null;
  }
  if (m["type"] !== "step") return null;
  const step = m["step"] as Record<string, unknown> | null;
  if (typeof step !== "object" || step === null) return null;
  switch (step["kind"]) {
    case "done":
      return { type: "step", step: { kind: "done", output: step["output"] } };
    case "failed":
      return typeof step["error"] === "string"
        ? { type: "step", step: { kind: "failed", error: step["error"] } }
        : null;
    case "call": {
      const { module, fn, kwargs, positional } = step;
      if (typeof module !== "string" || typeof fn !== "string") return null;
      if (!Number.isSafeInteger(positional) || (positional as number) < 0) return null;
      if (typeof kwargs !== "object" || kwargs === null || Array.isArray(kwargs)) return null;
      if (Object.getPrototypeOf(kwargs) !== Object.prototype) return null;
      if (Object.hasOwn(kwargs, "__proto__")) return null;
      return {
        type: "step",
        step: {
          kind: "call",
          module,
          fn,
          kwargs: kwargs as Record<string, unknown>,
          positional: positional as number,
        },
      };
    }
    default:
      return null;
  }
}

/**
 * Splits a byte stream into JSON lines; a line that doesn't parse is `null`.
 * Bytes are decoded as a stream, so a character split across two chunks
 * stays whole.
 */
export function lineReader(
  onMessage: (message: unknown) => void,
): (chunk: Buffer | string) => void {
  let buffer = "";
  const decoder = new StringDecoder("utf8");
  return (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
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
