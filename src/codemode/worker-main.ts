import { type FromWorker, lineReader, type ToWorker, toWire } from "./protocol.ts";
import type { StubModule } from "./stubs.ts";
import type { Step } from "./worker.ts";

/**
 * `heel codemode-worker` (D6b): runs one script with Monty and speaks the
 * line protocol on stdin and stdout. heel starts it under bubblewrap with no
 * network, no credentials and a clean environment, so the only thing the
 * script can reach is heel, through the calls this relays. Monty is imported
 * here and nowhere in heel's own process.
 */
export async function codemodeWorkerMain(): Promise<void> {
  const { MontyWorker } = await import("./monty.ts");
  const worker = new MontyWorker();
  let current: Step | null = null;
  const send = (message: FromWorker) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const report = (step: Step) => {
    current = step;
    send({ type: "step", step: toWire(step) });
    if (step.kind !== "call") void worker.stop().then(() => process.exit(0));
  };
  const fail = (error: string) => report({ kind: "failed", error });

  const handle = async (message: ToWorker | null): Promise<void> => {
    if (message === null) return fail("heel sent a line that didn't parse");
    if (message.type === "start") {
      const modules: StubModule[] = message.modules.map((m) => ({
        module: m.module,
        stubs: m.stubs,
        functions: new Map(m.functions),
        skipped: [],
      }));
      // Output past the script's limit is dropped here, so the sandbox's own ceiling isn't reached.
      let sent = 0;
      const max = message.limits.maxStdout;
      report(
        await worker.start(message.code, modules, message.limits, (text) => {
          if (sent >= max) return;
          const part = text.slice(0, max - sent);
          sent += part.length;
          send({ type: "stdout", text: part });
        }),
      );
      return;
    }
    const step = current;
    if (step?.kind !== "call") return fail("heel answered a call that wasn't waiting");
    report(
      message.type === "resume"
        ? await step.resume(message.value)
        : await step.raise(message.errorType, message.message),
    );
  };
  // One message at a time, in order: an answer must wait for the step it answers.
  let queue: Promise<void> = Promise.resolve();
  process.stdin.on(
    "data",
    lineReader((raw) => {
      queue = queue.then(() => handle(raw as ToWorker | null));
    }),
  );
  // heel closing stdin ends the script once every answer already sent is handled.
  process.stdin.on("end", () => {
    void queue.then(() => worker.stop()).then(() => process.exit(0));
  });
}
