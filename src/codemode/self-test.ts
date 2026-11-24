import type { Logger } from "../log.ts";
import { type CodeWorker, DEFAULT_LIMITS } from "./worker.ts";

/**
 * Whether code mode can run on this machine, checked once as heel starts: a
 * one-line script on a worker of its own. A helper that can't start (a
 * sandbox that blocks a file Node needs, say) then shows in heel's log and
 * in `heel status` straight away, instead of only as the error an agent's
 * `run_code` gets. The check decides nothing: run_code works or fails the
 * same either way.
 */

export type CodeModeHealth =
  | { state: "checking" }
  | { state: "ready" }
  | { state: "broken"; reason: string };

/** The script: Monty answers 2, with no call and no output. */
const SCRIPT = "1 + 1";
/** Far more than the script needs, even on a slow machine starting Node. */
const LIMITS = { ...DEFAULT_LIMITS, maxSeconds: 20 };

/** Runs the script on `worker`, stops it, and says what that showed. */
export async function probeCodeMode(worker: CodeWorker): Promise<CodeModeHealth> {
  try {
    const step = await worker.start(SCRIPT, [], LIMITS, () => {});
    if (step.kind === "done" && step.output === 2) return { state: "ready" };
    const reason =
      step.kind === "failed" ? step.error : `the test script ended with "${step.kind}", not 2`;
    return { state: "broken", reason };
  } catch (error) {
    return { state: "broken", reason: error instanceof Error ? error.message : String(error) };
  } finally {
    await worker.stop().catch(() => {});
  }
}

export interface CodeModeCheck {
  /** What the check has found so far. */
  health(): CodeModeHealth;
  /** Settles once the check is over. */
  readonly done: Promise<CodeModeHealth>;
  /** Ends a check still running, for heel closing; what it finds then isn't logged. */
  close(): Promise<void>;
}

export interface CodeModeCheckOptions {
  /** A worker made for the check alone, so no agent's lane or slot is used. */
  worker: CodeWorker;
  log: Logger;
  /** Frees what the worker ran on (its own helper), once the check is over. */
  release?: () => Promise<void>;
}

/** Starts the check in the background and logs what it finds. */
export function checkCodeMode({ worker, log, release }: CodeModeCheckOptions): CodeModeCheck {
  let health: CodeModeHealth = { state: "checking" };
  let closing = false;
  const free = () => release?.().catch(() => {});
  const done = probeCodeMode(worker)
    .then((found) => {
      if (closing) return found;
      health = found;
      if (found.state === "broken") {
        log.error(
          { code: "codemode_broken", reason: found.reason },
          `code mode can't run, so every run_code call fails: ${found.reason}`,
        );
      } else {
        log.info("code mode checked: a test script ran");
      }
      return found;
    })
    .finally(free);
  return {
    health: () => health,
    done,
    close: async () => {
      closing = true;
      await worker.stop().catch(() => {});
      await free();
      await done;
    },
  };
}
