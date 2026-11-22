import {
  applyAnswer,
  type FromWorker,
  fromWireModules,
  isFinal,
  lineReader,
  stdoutUpTo,
  type ToWorker,
  toWire,
} from "./protocol.ts";
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
    if (isFinal(step)) void worker.stop().then(() => process.exit(0));
  };
  const fail = (error: string) => report({ kind: "failed", error });

  const handle = async (message: ToWorker | null): Promise<void> => {
    if (message === null) return fail("heel sent a line that didn't parse");
    if (message.type === "start") {
      // Output past the script's limit is dropped here, so the sandbox's own ceiling isn't reached.
      const stdout = stdoutUpTo(message.limits.maxStdout, (text) => send({ type: "stdout", text }));
      report(
        await worker.start(
          message.code,
          fromWireModules(message.modules),
          message.limits,
          stdout,
          message.snapshot,
        ),
      );
      return;
    }
    report(await applyAnswer(current, message));
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
