/**
 * The sandbox runner: runs one program under bubblewrap with one credential
 * set, a confined filesystem, limits and an egress allowlist (spec: CLI
 * runner). `heel run` (D8b) and the code-mode worker (D6a) both use it.
 *
 * At boot:
 *
 *   const probe = await probeSandbox();
 *   if (!probe.ok) log.warn({ reason: probe.reason }, probe.detail); // refuse /run and code mode
 *
 * Per call, once the pipeline has allowed it:
 *
 *   const result = await runSandboxed(probe.host, {
 *     binary: "/usr/bin/gh",
 *     args: ["pr", "view", "12"],
 *     workRoot: "/srv/agents/ci-bot",
 *     cwd: "/srv/agents/ci-bot/web",
 *     secretEnv: { GH_TOKEN: token },
 *     network: { kind: "egress", allow: ["api.github.com", "github.com"] },
 *   });
 *
 * The program never goes through a shell, sees `/dev/null` on stdin, can't
 * reach heel's state or the agent's other files, and reaches the network only
 * through the egress proxy. Credentials travel to bwrap over a pipe, never on
 * a command line, and every credential value is scrubbed from the output.
 */
export type { EgressDecision, EgressTarget } from "./egress.ts";
export { EgressConfigError } from "./egress.ts";
export type { DetectHostOptions, HostUnavailableReason } from "./host.ts";
export { detectSandboxHost } from "./host.ts";
export type {
  SandboxFile,
  SandboxHost,
  SandboxLimits,
  SandboxNetwork,
  SandboxSpec,
} from "./plan.ts";
export { DEFAULT_LIMITS, SandboxSpecError } from "./plan.ts";
export type { ProbeOptions, SandboxProbe, SandboxUnavailableReason } from "./probe.ts";
export { probeSandbox } from "./probe.ts";
export type { SandboxOutcome, SandboxProcess, SandboxResult, SandboxRunOptions } from "./run.ts";
export { runSandboxed, startSandboxed } from "./run.ts";
export { REDACTED } from "./scrub.ts";
