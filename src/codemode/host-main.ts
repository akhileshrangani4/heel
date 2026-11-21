import type { Monty } from "@pydantic/monty";
import { MontyWorker } from "./monty.ts";
import { type FromHost, lineReader, type ToHost, toWire } from "./protocol.ts";
import type { StubModule } from "./stubs.ts";
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
  const end = async (id: string) => {
    const script = scripts.get(id);
    if (script === undefined) return;
    scripts.delete(id);
    await script.worker.stop().catch(() => {});
    await Promise.resolve(script.pool[Symbol.asyncDispose]?.()).catch(() => {});
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
    if (message.type === "stop") return end(id);
    if (message.type === "start") {
      if (scripts.has(id)) return;
      const pool = await (ready.shift() ??
        WasmMonty.create({ minProcesses: 1, maxProcesses: 1, maxCheckoutsPerWorker: 1 }));
      refill();
      const script: Script = { worker: new MontyWorker("wasm", pool), pool, current: null };
      scripts.set(id, script);
      const modules: StubModule[] = message.modules.map((m) => ({
        module: m.module,
        stubs: m.stubs,
        functions: new Map(m.functions),
        renamed: new Map(),
        skipped: [],
      }));
      let sent = 0;
      const max = message.limits.maxStdout;
      const step = await script.worker
        .start(message.code, modules, message.limits, (text) => {
          if (sent >= max || !scripts.has(id)) return;
          const part = text.slice(0, max - sent);
          sent += part.length;
          send({ id, type: "stdout", text: part });
        })
        .catch((error: unknown): Step => ({ kind: "failed", error: String(error) }));
      return report(id, step);
    }
    const step = scripts.get(id)?.current;
    if (step?.kind !== "call")
      return report(id, { kind: "failed", error: "heel answered a call that wasn't waiting" });
    report(
      id,
      message.type === "resume"
        ? await step.resume(message.value)
        : await step.raise(message.errorType, message.message),
    );
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
