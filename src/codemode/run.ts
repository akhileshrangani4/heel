import type { AuthenticatedAgent } from "../gateway/agent-tokens.ts";
import type { Pipeline } from "../gateway/pipeline/pipeline.ts";
import { approvalScript } from "../gateway/pipeline/ports.ts";
import type { HeelDb } from "../store/db.ts";
import { newId } from "../store/ids.ts";
import { type ClaimedScript, parkScript, type Sealer } from "./parking.ts";
import type { StubModule } from "./stubs.ts";
import {
  type CodeWorker,
  DEFAULT_LIMITS,
  type FutureResult,
  type ScriptLimits,
  type Step,
} from "./worker.ts";

/** How many of a script's parallel calls heel runs at once (C4). */
export const MAX_PARALLEL = 8;
/**
 * The most of one parallel result, and of one batch, heel hands back, as
 * JSON: a batch goes to the worker as one line (MAX_LINE). Past either, the
 * result is a RuntimeError at its `await` instead.
 */
export const MAX_FUTURE_RESULT_CHARS = 4 * 1024 * 1024;
export const MAX_FUTURE_BATCH_CHARS = 12 * 1024 * 1024;

/**
 * Runs one code-mode script (D6a; spec: Code mode). Each host call in the
 * script goes through the full decision pipeline as its own call, with
 * `surface: "code"`, so a loop of 500 single deletes meets the same counts
 * and limits as one 500-item batch (I-27). How the script goes on depends on
 * the decision:
 *
 * - allowed: the script resumes with the result, after hiding, so a hidden
 *   item never enters the sandbox (I-45);
 * - denied: the script resumes with a `PermissionError` at the call, which
 *   it may catch;
 * - pending (an ask): the script stops at the call, whatever `try/except`
 *   surrounds it, and nothing after it runs until the approval is decided
 *   (I-59). With `parking`, the suspended script is saved and the result
 *   carries a `resume` id: `run_code({ resume })` restores it at that call,
 *   which then runs through the pipeline again, so the approval decides it.
 *   Without parking, or when it can't be saved, the script ends there and
 *   the agent sends the rest as a new script (code mode round 2, C2);
 * - paused: the script is stopped for good and never resumed (I-62);
 * - an upstream error: a `RuntimeError` at the call;
 * - an unknown outcome, or a call that ran but whose result heel withheld:
 *   the script is stopped, so it can't catch the error and retry a write
 *   that happened or may have.
 */

export interface CallRecord {
  account: string;
  tool: string;
  decision: "allow" | "deny" | "ask" | "paused" | "error" | "unknown";
  items?: number;
}

export type ScriptStatus = "completed" | "pending" | "paused" | "error";

export interface ScriptResult {
  status: ScriptStatus;
  approvalId?: string;
  /** A parked script's id, for `run_code({ resume })` once the approval is decided. */
  resume?: string;
  /** Why an asking script couldn't be parked, so the agent knows to resend the rest. */
  notParked?: string;
  stdout: string;
  output?: unknown;
  calls: CallRecord[];
  /** A denial's message, a limit, the type checker's output, or an uncaught exception. */
  error: string | null;
}

export interface RunScriptInput {
  code: string;
  agent: AuthenticatedAgent;
  runId?: string | undefined;
  /** The agent's `heel_reason` for the script, shown on any approval a call in it asks for. */
  reason?: string | undefined;
  /** The modules the script may import, by Python name, with the account each one is. */
  modules: readonly (StubModule & { account: string })[];
  pipeline: Pipeline;
  worker: CodeWorker;
  limits?: Partial<ScriptLimits>;
  /** Where an asking script is saved; without it, an ask ends the script as before. */
  parking?: { db: HeelDb; sealer: Sealer; now: () => Date };
  /** A parked script to resume instead of running `code`. */
  resume?: ClaimedScript;
  /**
   * Called once a resumed script is back at its parked call, to take its row
   * so it resumes once; false (another resume took it) stops it there.
   */
  onRestored?: () => boolean;
}

export async function runScript(input: RunScriptInput): Promise<ScriptResult> {
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  let stdout = "";
  let truncated = false;
  const capture = (text: string) => {
    if (stdout.length + text.length <= limits.maxStdout) {
      stdout += text;
    } else if (!truncated) {
      stdout += text.slice(0, Math.max(0, limits.maxStdout - stdout.length));
      truncated = true;
    }
  };
  const calls: CallRecord[] = [];
  const byModule = new Map(input.modules.map((m) => [m.module, m]));
  const finish = async (result: Omit<ScriptResult, "stdout" | "calls">): Promise<ScriptResult> => {
    await input.worker.stop();
    return { ...result, stdout, calls };
  };

  // heel's id for the script, kept across a park, so Activity can group its calls.
  const scriptId = input.resume?.scriptId ?? newId("script");
  // A resumed script runs no new code: its code is the one it parked with.
  const code = input.resume?.code ?? input.code;
  // A resumed script's earlier calls count toward its limit; the parked one runs again here.
  const before = input.resume === undefined ? 0 : Math.max(0, input.resume.calls.length - 1);
  /** Saves the script suspended at an asking call: `{ resume }`, or `{ notParked }` saying why not. */
  const park = async (
    at: Extract<Step, { kind: "call" }>,
    approvalId: string,
  ): Promise<{ resume: string } | { notParked: string } | Record<string, never>> => {
    const parking = input.parking;
    if (parking === undefined) return {};
    // Whatever goes wrong here, the agent still gets its pending answer and approval id.
    try {
      return await saveParked(parking, at, approvalId);
    } catch (error) {
      return {
        notParked: `the script couldn't be saved: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
  const saveParked = async (
    parking: NonNullable<RunScriptInput["parking"]>,
    at: Extract<Step, { kind: "call" }>,
    approvalId: string,
  ): Promise<{ resume: string } | { notParked: string }> => {
    const saved = await at.park();
    if (saved.kind !== "parked") {
      return { notParked: saved.kind === "failed" ? saved.error : "the script couldn't be saved" };
    }
    const row = parkScript(
      parking.db,
      parking.sealer,
      {
        orgId: input.agent.orgId,
        agentId: input.agent.agentId,
        approvalId,
        runId: input.runId,
        reason: input.reason,
        scriptId,
        code,
        calls: [...(input.resume?.calls.slice(0, -1) ?? []), ...calls],
        modules: input.modules,
        snapshot: saved.snapshot,
      },
      parking.now(),
    );
    if (row.ok) return { resume: row.id };
    return {
      notParked:
        row.reason === "limit"
          ? "this agent already has the most scripts heel keeps waiting on approvals"
          : "the approval was gone before the script could be saved",
    };
  };

  /**
   * Runs the script's pending futures through the pipeline, a few at a time,
   * as calls that can't open a request (`noAsk`). Every one settles and is
   * recorded before the script goes on or stops: one that's paused, ran with
   * its result withheld, or whose outcome is unknown stops the script, as the
   * same call made the plain way would.
   */
  const settleFutures = async (
    pending: readonly number[],
  ): Promise<{ results: FutureResult[]; stop: Omit<ScriptResult, "stdout" | "calls"> | null }> => {
    const unknown = pending.filter((id) => !futures.has(id));
    if (unknown.length > 0) {
      return {
        results: [],
        stop: { status: "error", error: "the script waited on a call heel didn't start" },
      };
    }
    const results: FutureResult[] = [];
    let stop: Omit<ScriptResult, "stdout" | "calls"> | null = null;
    const queue = [...pending];
    const one = async (callId: number): Promise<void> => {
      const call = futures.get(callId);
      if (call === undefined) return;
      futures.delete(callId);
      const result = await input.pipeline.run({
        agent: input.agent,
        surface: "code",
        account: call.account,
        tool: call.tool,
        args: call.args,
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        scriptId,
        noAsk: true,
      });
      const record = (decision: CallRecord["decision"]) =>
        calls.push({ account: call.account, tool: call.tool, decision });
      const plain = call.fn.replace(/_async$/, "");
      switch (result.status) {
        case "allowed":
          record("allow");
          // JSON drops `undefined`; null reaches the script as None either way.
          results.push({ callId, value: result.result ?? null });
          return;
        case "denied":
          record("deny");
          if (result.executed === true) {
            stop ??= {
              status: "error",
              error: `${call.tool} on ${call.account} ran, but heel withheld its result; the script was stopped`,
            };
            return;
          }
          results.push({
            callId,
            errorType: "PermissionError",
            message:
              result.reason === "approval_needed"
                ? `${call.tool} on ${call.account} needs approval, which a parallel call can't wait for; call ${plain}() to ask`
                : `heel denied ${call.tool} on ${call.account} (${result.reason.replaceAll("_", " ")})` +
                  (result.detail === undefined ? "" : `: ${result.detail}`),
          });
          return;
        case "expired":
        case "pending":
          record("deny");
          results.push({
            callId,
            errorType: "PermissionError",
            message: `${call.tool} on ${call.account} needs approval; call ${plain}() to ask`,
          });
          return;
        case "upstream_error":
          record("error");
          results.push({
            callId,
            errorType: "RuntimeError",
            message:
              result.message ??
              `${call.account} answered ${call.tool} with an error (${result.upstreamStatus})`,
          });
          return;
        case "paused":
          record("paused");
          stop ??= { status: "paused", error: null };
          return;
        case "upstream_outcome_unknown":
          record("unknown");
          stop ??= {
            status: "error",
            error: `heel doesn't know whether ${call.tool} on ${call.account} took effect; the script was stopped`,
          };
          return;
      }
    };
    // Once one call stops the script, no queued call starts; those already running settle.
    const lane = async (): Promise<void> => {
      for (let id = queue.shift(); id !== undefined && stop === null; id = queue.shift()) {
        await one(id);
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, queue.length) }, lane));
    // In the script's own order, so which results a cap cuts doesn't depend on network timing.
    const order = new Map(pending.map((id, i) => [id, i]));
    results.sort((a, b) => (order.get(a.callId) ?? 0) - (order.get(b.callId) ?? 0));
    return { results: capped(results), stop };
  };

  /** Results too large to hand back become errors at their `await`; so do those past the batch cap. */
  const capped = (results: FutureResult[]): FutureResult[] => {
    let total = 0;
    return results.map((r) => {
      const size = JSON.stringify(r).length;
      if (size <= MAX_FUTURE_RESULT_CHARS && total + size <= MAX_FUTURE_BATCH_CHARS) {
        total += size;
        return r;
      }
      return {
        callId: r.callId,
        errorType: "RuntimeError",
        message: "the result is too large for code mode",
      };
    });
  };

  let step: Step = await input.worker.start(
    input.code,
    input.modules,
    limits,
    capture,
    input.resume?.snapshot,
  );
  if (input.resume !== undefined) {
    // A restored script is back at its parked call. Anything else means it didn't restore
    // (a worker that ignored the snapshot would run no code and "finish"): say so, and keep it.
    if (step.kind !== "call") {
      return finish({
        status: "error",
        error: `the parked script didn't restore${step.kind === "failed" ? `: ${step.error}` : ""}`,
      });
    }
    if (input.onRestored?.() === false) {
      return finish({ status: "error", error: "this parked script was already resumed" });
    }
  }
  // Calls made as futures (`_async` twins, C4), by Monty's call id. They run when the script
  // next waits: Monty then lists every unresolved one, awaited or not, as a JavaScript promise
  // starts when it's made. One made just before the script ends, with no wait after, never runs.
  const futures = new Map<
    number,
    { account: string; tool: string; fn: string; args: Record<string, unknown> }
  >();
  while (step.kind === "call" || step.kind === "await") {
    if (step.kind === "await") {
      const settled = await settleFutures(step.pending);
      if (settled.stop !== null) return finish(settled.stop);
      step = await step.resolve(settled.results);
      continue;
    }
    const module = byModule.get(step.module);
    const tool = module?.functions.get(step.fn);
    if (module === undefined || tool === undefined) {
      step = await step.raise("RuntimeError", `heel has no ${step.module}.${step.fn}`);
      continue;
    }
    if (step.positional > 0) {
      step = await step.raise(
        "RuntimeError",
        `${step.module}.${step.fn} takes keyword arguments only`,
      );
      continue;
    }
    // `from_` in Python is the tool's `from`. Passing both is ambiguous.
    const renamed = module.renamed.get(step.fn);
    // Null prototype: a key like `__proto__` stays a key, never the prototype.
    const named: Record<string, unknown> = Object.create(null);
    let clash: string | null = null;
    for (const [key, value] of Object.entries(step.kwargs)) {
      const name = renamed?.get(key) ?? key;
      if (Object.hasOwn(named, name)) clash = name;
      named[name] = value;
    }
    const args = { ...named };
    if (clash !== null) {
      step = await step.raise(
        "RuntimeError",
        `${step.module}.${step.fn} got ${clash} twice (as ${clash} and ${clash}_)`,
      );
      continue;
    }
    if (before + calls.length + futures.size >= limits.maxCalls) {
      return finish({
        status: "error",
        error: `the script made more than ${limits.maxCalls} calls`,
      });
    }
    if (module.asyncFunctions?.has(step.fn) === true) {
      futures.set(step.callId, { account: module.account, tool, fn: step.fn, args });
      step = await step.future();
      continue;
    }
    const result = await input.pipeline.run({
      agent: input.agent,
      surface: "code",
      account: module.account,
      tool,
      args,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      scriptId,
      // The approver sees the script and what it already called (C3).
      script: approvalScript(code, [...(input.resume?.calls.slice(0, -1) ?? []), ...calls]),
    });
    const record = (decision: CallRecord["decision"]) =>
      calls.push({ account: module.account, tool, decision });
    switch (result.status) {
      case "allowed":
        record("allow");
        step = await step.resume(result.result);
        break;
      case "denied":
        if (result.executed === true) {
          // The call ran; a catchable error would let the script retry a write that happened.
          record("deny");
          return finish({
            status: "error",
            error: `${tool} on ${module.account} ran, but heel withheld its result; the script was stopped`,
          });
        }
        record("deny");
        step = await step.raise(
          "PermissionError",
          `heel denied ${tool} on ${module.account} (${result.reason.replaceAll("_", " ")})` +
            (result.detail === undefined ? "" : `: ${result.detail}`),
        );
        break;
      case "expired":
        record("deny");
        step = await step.raise(
          "PermissionError",
          `the approval for ${tool} on ${module.account} expired`,
        );
        break;
      case "upstream_error":
        record("error");
        step = await step.raise(
          "RuntimeError",
          result.message ??
            `${module.account} answered ${tool} with an error (${result.upstreamStatus})`,
        );
        break;
      case "pending": {
        record("ask");
        // A script with parallel calls still waiting isn't saved: their calls live only here.
        const parked =
          futures.size > 0
            ? { notParked: "the script had parallel calls waiting, so it couldn't be saved" }
            : await park(step, result.approvalId);
        return finish({ status: "pending", approvalId: result.approvalId, error: null, ...parked });
      }
      case "paused":
        record("paused");
        return finish({ status: "paused", error: null });
      case "upstream_outcome_unknown":
        record("unknown");
        return finish({
          status: "error",
          error: `heel doesn't know whether ${tool} on ${module.account} took effect; the script was stopped`,
        });
    }
  }
  if (step.kind === "failed") return finish({ status: "error", error: step.error });
  if (step.kind === "parked") return finish({ status: "error", error: "the script parked itself" });
  return finish({ status: "completed", output: step.output, error: null });
}
