import type { Monty } from "@pydantic/monty";
import { MontyWorker } from "./monty.ts";
import {
  applyAnswer,
  type FromHost,
  fromWireModules,
  lineReader,
  stdoutUpTo,
  type ToHost,
  toWire,
} from "./protocol.ts";
import type { Step } from "./worker.ts";

/**
 * `heel codemode-host`: runs code-mode scripts with Monty compiled to
 * WebAssembly, many at once, and speaks the tagged line protocol on stdin
 * and stdout. heel starts one at boot where bubblewrap isn't available,
 * under Node's permission model: it may read heel's install and start
 * worker threads, and nothing else (no other files, no network, no child
 * processes), with an empty environment. Monty's own sandbox is the first
 * wall, WebAssembly the second, this process the third.
 *
 * Every script gets a fresh worker thread, made ahead of time so the script
 * doesn't wait for it, and discarded when the script ends: a stopped script
 * never shares a worker with the next one.
 */

/** Fresh single-worker pools kept ready. */
const READY = 2;

type Pool = Pick<Monty, "checkout"> & Partial<AsyncDisposable>;

interface Script {
  worker: MontyWorker;
  pool: Pool;
  current: Step | null;
}

export async function codemodeHostMain(): Promise<void> {
  const { Monty: WasmMonty } = await import("@pydantic/monty/wasm");
  const ready: Promise<Pool>[] = [];
  const refill = () => {
    while (ready.length < READY) {
      const pool = WasmMonty.create({ minProcesses: 1, maxProcesses: 1, maxCheckoutsPerWorker: 1 });
      pool.catch(() => {});
      ready.push(pool);
    }
  };
  refill();

  const scripts = new Map<string, Script>();
  const send = (message: FromHost) => process.stdout.write(`${JSON.stringify(message)}\n`);
  // One ending per script, shared: a script that finished on its own may still be
  // discarding its worker when heel's `stop` arrives, and `ended` must wait for that.
  const ending = new Map<string, Promise<void>>();
  const end = (id: string): Promise<void> => {
    const already = ending.get(id);
    if (already !== undefined) return already;
    const script = scripts.get(id);
    if (script === undefined) return Promise.resolve();
    scripts.delete(id);
    const done = (async () => {
      await script.worker.stop().catch(() => {});
      await Promise.resolve(script.pool[Symbol.asyncDispose]?.()).catch(() => {});
    })().finally(() => ending.delete(id));
    ending.set(id, done);
    return done;
  };
  const report = (id: string, step: Step) => {
    const script = scripts.get(id);
    if (script === undefined) return;
    script.current = step;
    send({ id, type: "step", step: toWire(step) });
    if (step.kind !== "call") void end(id);
  };

  const handle = async (message: ToHost): Promise<void> => {
    const { id } = message;
    if (message.type === "stop") {
      // Queued behind the script's other messages, so a script still computing ends at its
      // time limit at the latest; `ended` goes back only once its worker is gone.
      await end(id);
      send({ id, type: "ended" });
      return;
    }
    if (message.type === "start") {
      if (scripts.has(id)) return;
      const pool = await (ready.shift() ??
        WasmMonty.create({ minProcesses: 1, maxProcesses: 1, maxCheckoutsPerWorker: 1 }));
      refill();
      const script: Script = { worker: new MontyWorker("wasm", pool), pool, current: null };
      scripts.set(id, script);
      const stdout = stdoutUpTo(message.limits.maxStdout, (text) => {
        if (scripts.has(id)) send({ id, type: "stdout", text });
      });
      const step = await script.worker
        .start(message.code, fromWireModules(message.modules), message.limits, stdout)
        .catch((error: unknown): Step => ({ kind: "failed", error: String(error) }));
      return report(id, step);
    }
    report(id, await applyAnswer(scripts.get(id)?.current ?? null, message));
  };

  // Messages for one script are handled in order; different scripts run side by side.
  const chains = new Map<string, Promise<void>>();
  process.stdin.on(
    "data",
    lineReader((raw) => {
      const message = raw as ToHost | null;
      if (message === null || typeof message.id !== "string") return;
      const id = message.id;
      const next = (chains.get(id) ?? Promise.resolve())
        .then(() => handle(message))
        .catch(() => {});
      chains.set(id, next);
      void next.then(() => {
        if (chains.get(id) === next && !scripts.has(id)) chains.delete(id);
      });
    }),
  );
  // heel going away ends every script.
  process.stdin.on("end", () => process.exit(0));
}
