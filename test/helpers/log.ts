import { Writable } from "node:stream";
import type { LevelWithSilent } from "pino";
import { createLogger, type Logger } from "../../src/log.ts";

/** A logger whose JSON lines are kept in memory, so tests can assert on what was written. */
export function captureLogger(level: LevelWithSilent = "trace"): {
  logger: Logger;
  output: () => string;
} {
  let output = "";
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      output += chunk.toString("utf8");
      done();
    },
  });
  return { logger: createLogger(level, sink), output: () => output };
}
