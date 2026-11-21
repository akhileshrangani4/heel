import { createPool, type MontyPool, MontyWorker } from "./monty.ts";
import {
  applyAnswer,
  type FromHost,
  fromWireModules,
  lineReader,
  MAX_LINE,
  stdoutUpTo,
  type ToHost,
  toWire,
} from "./protocol.ts";
import type { Step } from "./worker.ts";

/**
 * `heel codemode-host`, the helper: runs code-mode scripts with Monty
 * compiled to WebAssembly, many at once, and speaks the tagged line protocol
 * on stdin and stdout. Where bubblewrap isn't available, heel starts one
 * when the first script needs it (`hosted.ts`), under Node's permission
 * model: it may read heel's install and start worker threads, and nothing
 * else (no other files, no network, no child processes), with an empty
 * environment. Monty's own sandbox is the first wall and WebAssembly the
 * second. This process keeps a crash away from heel and the environment
 * empty; its permission flags hold against Python, but not against code
 * that already escaped into JavaScript, which `--allow-worker` would let
 * start an unrestricted worker (see docs/design/code-mode-architecture.md).
 *
 * Every script gets a fresh worker thread, made ahead of time so the script
 * doesn't wait for it, and discarded when the script ends: a stopped script
 * never shares a worker with the next one.
 */

/** Fresh workers kept ready, each in its own single-use pool. */
const SPARE_WORKERS = 2;
/** Everything one script may send heel, as the bubblewrap worker's output ceiling. */
const SCRIPT_OUTPUT_CEILING = 64 * 1024 * 1024;

interface Script {
  worker: MontyWorker;
  /** The worker's pool, which this process made and so closes. */
  pool: MontyPool;
  /** The script's latest step; heel's next answer applies to it when it's a call. */
  latest: Step | null;
  /** What the script has sent heel so far, in characters. */
  sent: number;
}

export async function codemodeHostMain(): Promise<void> {
  const newPool = () => createPool("wasm", true);
  const spares: Promise<MontyPool>[] = [];
  const refill = () => {
    while (spares.length < SPARE_WORKERS) {
      const pool = newPool();
      // A spare that failed to start is found when a script takes it.
      pool.catch(() => {});
      spares.push(pool);
    }
  };
  refill();

  const scripts = new Map<string, Script>();
  // heel reading too slowly, or going away, ends the helper rather than leaving it half-written.
  process.stdout.on("error", () => process.exit(1));
  const write = (message: FromHost) => process.stdout.write(`${JSON.stringify(message)}\n`);
  /**
   * Sends heel one message for a script. One too big to send, or past the
   * script's output ceiling, fails the script instead: heel reads every line
   * whole, and one script mustn't fill heel's memory or stall the others.
   */
  const send = (message: FromHost) => {
    let line: string | null;
    try {
      line = JSON.stringify(message);
    } catch {
      line = null;
    }
    const script = scripts.get(message.id);
    if (script !== undefined && line !== null) script.sent += line.length;
    const tooBig =
      line === null ||
      line.length > MAX_LINE ||
      (script !== undefined && script.sent > SCRIPT_OUTPUT_CEILING);
    if (!tooBig) {
      process.stdout.write(`${line}\n`);
      return;
    }
    if (script === undefined) return;
    write({
      id: message.id,
      type: "step",
      step: { kind: "failed", error: "the script sent more than code mode allows" },
    });
    void discard(message.id);
  };

  // One discard per script, shared: a script that finished on its own may still be
  // discarding its worker when heel's `stop` arrives, and `ended` must wait for that.
  const discarding = new Map<string, Promise<void>>();
  /** Forgets a script and closes its worker; settles once the worker is gone. */
  const discard = (id: string): Promise<void> => {
    const already = discarding.get(id);
    if (already !== undefined) return already;
    const script = scripts.get(id);
    if (script === undefined) return Promise.resolve();
    scripts.delete(id);
    const gone = (async () => {
      await script.worker.stop().catch(() => {});
      await Promise.resolve(script.pool[Symbol.asyncDispose]?.()).catch(() => {});
    })().finally(() => discarding.delete(id));
    discarding.set(id, gone);
    return gone;
  };

  /** Sends heel a script's step. A step that isn't a call is its last, so its worker goes. */
  const report = (id: string, step: Step) => {
    const script = scripts.get(id);
    if (script === undefined) return;
    script.latest = step;
    send({ id, type: "step", step: toWire(step) });
    if (step.kind !== "call") void discard(id);
  };

  const start = async (message: Extract<ToHost, { type: "start" }>): Promise<void> => {
    const { id } = message;
    if (scripts.has(id)) return;
    const pool = await (spares.shift() ?? newPool());
    refill();
    const script: Script = { worker: new MontyWorker(pool), pool, latest: null, sent: 0 };
    scripts.set(id, script);
    const stdout = stdoutUpTo(message.limits.maxStdout, (text) => {
      if (scripts.has(id)) send({ id, type: "stdout", text });
    });
    const step = await script.worker
      .start(message.code, fromWireModules(message.modules), message.limits, stdout)
      .catch((error: unknown): Step => ({ kind: "failed", error: String(error) }));
    report(id, step);
  };

  const handle = async (message: ToHost): Promise<void> => {
    const { id } = message;
    switch (message.type) {
      case "start":
        return start(message);
      case "stop":
        // Queued behind the script's other messages, so a script still computing ends at its
        // time limit at the latest; `ended` goes back only once its worker is gone.
        await discard(id);
        write({ id, type: "ended" });
        return;
      default:
        report(id, await applyAnswer(scripts.get(id)?.latest ?? null, message));
    }
  };

  // Messages for one script are handled in order; different scripts run side by side.
  const queues = new Map<string, Promise<void>>();
  process.stdin.on(
    "data",
    lineReader((raw) => {
      const message = raw as ToHost | null;
      if (message === null || typeof message.id !== "string") return;
      const id = message.id;
      const next = (queues.get(id) ?? Promise.resolve())
        .then(() => handle(message))
        // heel is waiting for a step, and would wait for good without one: a script whose
        // worker couldn't start, say, fails here instead.
        .catch((error: unknown) => {
          const step = { kind: "failed", error: `the code-mode helper failed: ${error}` } as const;
          write({ id, type: "step", step });
          return discard(id);
        });
      queues.set(id, next);
      void next.then(() => {
        if (queues.get(id) === next && !scripts.has(id)) queues.delete(id);
      });
    }),
  );
  // heel going away ends every script.
  process.stdin.on("end", () => process.exit(0));
}
