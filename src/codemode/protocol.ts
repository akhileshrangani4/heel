import { StringDecoder } from "node:string_decoder";
import type { StubModule } from "./stubs.ts";
import type { ScriptLimits, Step } from "./worker.ts";

/**
 * The line protocols between heel and the process that runs Monty: one JSON
 * object per line, each way, over that process's stdin and stdout. There are
 * two, because there are two such processes:
 *
 * - `heel codemode-worker` (under bubblewrap) runs one script, so its
 *   messages are bare: `ToWorker` and `FromWorker`.
 * - `heel codemode-host` (the helper, where bubblewrap isn't available) runs
 *   many scripts at once, so the same messages carry the script's `id`, and
 *   two more exist to end one script without ending the process: `ToHost`
 *   and `FromHost`.
 *
 * heel → process: `start` once, then `resume` or `raise` after each `call`.
 * process → heel: `stdout` chunks as the script prints, and a `step` after
 * every turn. heel ends a worker's script by killing the worker, and a
 * helper's script with `stop`.
 *
 * Both sides of both protocols share the conversions below, so a module, a
 * step and the stdout limit mean the same thing on either path.
 */

/** A module as it crosses the boundary: functions as pairs, since a Map isn't JSON. */
export interface WireModule {
  module: string;
  stubs: string;
  functions: [string, string][];
}

export function toWireModules(modules: readonly StubModule[]): WireModule[] {
  return modules.map((m) => ({ module: m.module, stubs: m.stubs, functions: [...m.functions] }));
}

/** The renames stay behind on heel's side, where `run.ts` applies them. */
export function fromWireModules(modules: readonly WireModule[]): StubModule[] {
  return modules.map((m) => ({
    module: m.module,
    stubs: m.stubs,
    functions: new Map(m.functions),
    renamed: new Map(),
    skipped: [],
  }));
}

/** heel's answer to a `call`: the result, or an error raised at the call site. */
export type Answer =
  | { type: "resume"; value: unknown }
  | { type: "raise"; errorType: "PermissionError" | "RuntimeError"; message: string };

export type ToWorker =
  | { type: "start"; code: string; modules: WireModule[]; limits: ScriptLimits }
  | Answer;

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
 * heel's side: a step off the wire gets its continuations back, each one
 * sending heel's answer and waiting for the step after it.
 */
export function fromWire(step: WireStep, answer: (answer: Answer) => Promise<Step>): Step {
  if (step.kind !== "call") return step;
  return {
    ...step,
    resume: (value) => answer({ type: "resume", value }),
    raise: (errorType, message) => answer({ type: "raise", errorType, message }),
  };
}

/** The script's side: applies heel's answer to the call the script is waiting at. */
export function applyAnswer(waiting: Step | null, answer: Answer): Promise<Step> {
  if (waiting?.kind !== "call") {
    return Promise.resolve({ kind: "failed", error: "heel answered a call that wasn't waiting" });
  }
  return answer.type === "resume"
    ? waiting.resume(answer.value)
    : waiting.raise(answer.errorType, answer.message);
}

/**
 * The script's side: passes on what a script prints until `max` is reached
 * and drops the rest there, so a script can't flood the pipe to heel. heel
 * applies the same limit again to what it keeps (`run.ts`), since it doesn't
 * trust this side to.
 */
export function stdoutUpTo(max: number, send: (text: string) => void): (text: string) => void {
  let sent = 0;
  return (text) => {
    if (sent >= max) return;
    const part = text.slice(0, max - sent);
    sent += part.length;
    send(part);
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
 * The longest line either side of the helper protocol sends: a script's
 * arguments, a result or a step. A step past it fails its script instead of
 * being sent, so heel never buffers a line without end.
 */
export const MAX_LINE = 16 * 1024 * 1024;

/**
 * Splits a byte stream into JSON lines; a line that doesn't parse is `null`.
 * Bytes are decoded as a stream, so a character split across two chunks
 * stays whole. Only the new chunk is searched for a newline, so a long line
 * costs the same however it is split up.
 *
 * With `maxLine`, a line longer than that is dropped unread and `onOverflow`
 * is told; reading picks up again after its newline.
 */
export function lineReader(
  onMessage: (message: unknown) => void,
  limit?: { maxLine: number; onOverflow: () => void },
): (chunk: Buffer | string) => void {
  let parts: string[] = [];
  let length = 0;
  let overflowed = false;
  const decoder = new StringDecoder("utf8");
  const emit = (line: string) => {
    if (line.trim() === "") return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      message = null;
    }
    onMessage(message);
  };
  return (chunk) => {
    let text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    let newline = text.indexOf("\n");
    while (newline >= 0) {
      const tail = text.slice(0, newline);
      if (!overflowed) {
        if (limit !== undefined && length + tail.length > limit.maxLine) limit.onOverflow();
        else emit(parts.length === 0 ? tail : parts.join("") + tail);
      }
      parts = [];
      length = 0;
      overflowed = false;
      text = text.slice(newline + 1);
      newline = text.indexOf("\n");
    }
    if (text === "" || overflowed) return;
    if (limit !== undefined && length + text.length > limit.maxLine) {
      parts = [];
      length = 0;
      overflowed = true;
      limit.onOverflow();
      return;
    }
    parts.push(text);
    length += text.length;
  };
}

/**
 * The helper's protocol (`heel codemode-host`): the same messages, each
 * tagged with the script it belongs to, since one helper runs many scripts
 * at once. heel also sends `stop`, which ends a script and discards its
 * worker; the helper answers `ended` once the worker is gone.
 */
export type ToHost = (ToWorker & { id: string }) | { type: "stop"; id: string };
/** `ended` answers `stop` once the script's worker is gone, so heel frees its slot only then. */
export type FromHost = (FromWorker & { id: string }) | { type: "ended"; id: string };

/** A helper message: its script id plus a worker message, checked as `parseFromWorker` does. */
export function parseFromHost(raw: unknown): FromHost | null {
  if (typeof raw !== "object" || raw === null) return null;
  const id = (raw as Record<string, unknown>)["id"];
  if (typeof id !== "string") return null;
  if ((raw as Record<string, unknown>)["type"] === "ended") return { type: "ended", id };
  const message = parseFromWorker(raw);
  return message === null ? null : { ...message, id };
}
