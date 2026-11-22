import type { AuthenticatedAgent } from "../gateway/agent-tokens.ts";
import type { Pipeline } from "../gateway/pipeline/pipeline.ts";
import type { HeelDb } from "../store/db.ts";
import { type ClaimedScript, parkScript, type Sealer } from "./parking.ts";
import type { StubModule } from "./stubs.ts";
import { type CodeWorker, DEFAULT_LIMITS, type ScriptLimits, type Step } from "./worker.ts";

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

  // A resumed script's earlier calls count toward its limit; the parked one runs again here.
  const before = input.resume === undefined ? 0 : Math.max(0, input.resume.calls.length - 1);
  /** Saves the script suspended at an asking call: `{ resume }`, or `{ notParked }` saying why not. */
  const park = async (
    at: Extract<Step, { kind: "call" }>,
    approvalId: string,
  ): Promise<{ resume: string } | { notParked: string } | Record<string, never>> => {
    const parking = input.parking;
    if (parking === undefined) return {};
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
        calls: [...(input.resume?.calls.slice(0, -1) ?? []), ...calls],
        modules: input.modules,
        snapshot: saved.snapshot,
      },
      parking.now(),
    );
    return row === null
      ? { notParked: "this agent already has the most parked scripts heel keeps" }
      : { resume: row.id };
  };

  let step: Step = await input.worker.start(
    input.code,
    input.modules,
    limits,
    capture,
    input.resume?.snapshot,
  );
  while (step.kind === "call") {
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
    if (before + calls.length >= limits.maxCalls) {
      return finish({
        status: "error",
        error: `the script made more than ${limits.maxCalls} calls`,
      });
    }
    const result = await input.pipeline.run({
      agent: input.agent,
      surface: "code",
      account: module.account,
      tool,
      args,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
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
        const parked = await park(step, result.approvalId);
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
