import type { AuthenticatedAgent } from "../gateway/agent-tokens.ts";
import type { Pipeline } from "../gateway/pipeline/pipeline.ts";
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
 * - pending (an ask) or paused: the script is stopped for good and never
 *   resumed, so no later statement runs, whatever `try/except` surrounds the
 *   call (I-59, I-62). The result carries the approval id and what already
 *   ran; the agent sends the rest as a new script;
 * - an upstream error: a `RuntimeError` at the call;
 * - an unknown outcome: the script is stopped, so it can't catch the error
 *   and retry a write that may have happened.
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
  /** The modules the script may import, by Python name, with the account each one is. */
  modules: readonly (StubModule & { account: string })[];
  pipeline: Pipeline;
  worker: CodeWorker;
  limits?: Partial<ScriptLimits>;
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

  let step: Step = await input.worker.start(input.code, input.modules, limits, capture);
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
    if (calls.length >= limits.maxCalls) {
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
      args: step.kwargs,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
    });
    const record = (decision: CallRecord["decision"]) =>
      calls.push({ account: module.account, tool, decision });
    switch (result.status) {
      case "allowed":
        record("allow");
        step = await step.resume(result.result);
        break;
      case "denied":
        record("deny");
        step = await step.raise(
          "PermissionError",
          `heel denied ${tool} on ${module.account} (${result.reason.replaceAll("_", " ")})`,
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
          `${module.account} answered ${tool} with an error (${result.upstreamStatus})`,
        );
        break;
      case "pending":
        record("ask");
        return finish({ status: "pending", approvalId: result.approvalId, error: null });
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
  return finish({ status: "completed", output: step.output, error: null });
}
