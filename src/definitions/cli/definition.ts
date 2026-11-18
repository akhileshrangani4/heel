import { realpath } from "node:fs/promises";
import { sep } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { Call } from "../../core/call.ts";
import type { Definition, HardDenyReason, Normalized } from "../../gateway/pipeline/ports.ts";
import { SANDBOX_RUN, type SandboxHost, type SandboxSpec } from "../../runner/plan.ts";
import type { SandboxProcess, SandboxRunOptions } from "../../runner/run.ts";
import type { AccountRecord } from "../../store/directory.ts";
import type { Vault } from "../../vault/vault.ts";
import { normalizeCliArgv } from "./index.ts";
import { cliSettings } from "./settings.ts";
import type { CliRefusal } from "./types.ts";

/**
 * The definition for a CLI account (D8b; spec: CLI runner): `heel run`
 * sends a command line and the directory it runs in; heel normalizes it,
 * the rules decide, and an allowed command runs under bubblewrap with the
 * account's credential, which the agent never sees.
 *
 * - The command must be the account's own (`argv[0]` is its command name),
 *   and heel runs the binary the operator configured, never one from PATH.
 * - The directory must sit inside one of the agent's work roots, after
 *   symlinks are resolved; only that root is writable in the sandbox.
 * - Refusals from normalization are hard denies, checked before any rule
 *   (I-31): printing a credential is `credential_exposure`; an unparseable
 *   command, an endpoint redirect, or running repo code is `unsupported`.
 * - Network goes only through heel's egress proxy, to the account's hosts.
 * - Only the `/run` surface reaches it; an MCP call naming the account is
 *   refused.
 */

export const CliArgsSchema = z.strictObject({
  argv: z.array(z.string().max(65_536)).min(1).max(4_096),
  /** Absolute; the route resolves it before the pipeline sees it. */
  cwd: z.string().startsWith("/"),
});
export type CliArgs = z.output<typeof CliArgsSchema>;

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Set when heel stopped the program: a limit, or an abort. */
  stopped?: "time" | "output" | "aborted";
}

export type StartSandboxed = (
  host: SandboxHost,
  spec: SandboxSpec,
  options?: SandboxRunOptions,
) => Promise<SandboxProcess>;

export interface CliDeps {
  vault: Vault;
  /** The host's sandbox facts; null where bubblewrap isn't usable, so every command is refused. */
  sandbox: SandboxHost | null;
  start: StartSandboxed;
  /** The agent's work roots, as stored. */
  workRoots(agentId: string): readonly string[];
}

function refusalReason(refusals: readonly CliRefusal[]): HardDenyReason | null {
  if (refusals.length === 0) return null;
  return refusals.some((r) => r.kind === "prints_credentials")
    ? "credential_exposure"
    : "unsupported";
}

/** The work root holding `dir`, both already resolved; null when none does. */
export function rootHolding(roots: readonly string[], dir: string): string | null {
  for (const root of roots) {
    if (dir === root || dir.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) return root;
  }
  return null;
}

async function resolved(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/** Values inside a kubeconfig's users that must never reach the agent's output. */
export function kubeconfigSecrets(kubeconfig: string): string[] {
  let doc: unknown;
  try {
    doc = parse(kubeconfig);
  } catch {
    return [];
  }
  const users = (doc as { users?: unknown } | null)?.users;
  if (!Array.isArray(users)) return [];
  const out: string[] = [];
  for (const entry of users) {
    const user = (entry as { user?: Record<string, unknown> })?.user;
    if (user === undefined || user === null) continue;
    for (const key of ["token", "password", "client-key-data", "client-certificate-data"]) {
      const value = user[key];
      if (typeof value === "string" && value.length >= 8) out.push(value);
    }
  }
  return out;
}

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

export function cliDefinition(account: AccountRecord, deps: CliDeps): Definition | null {
  const settings = cliSettings(account.settings);
  // Without the sandbox there's no definition, so every command is denied (spec: Fail-closed behavior).
  if (settings === null || deps.sandbox === null) return null;
  const sandbox = deps.sandbox;

  return {
    async normalize(base: Call): Promise<Normalized> {
      // Only `heel run` reaches a CLI account, so a rule keyed on `surface: cli` sees every command.
      if (base.surface !== "cli") return { ok: false, reason: "unsupported" };
      const parsed = CliArgsSchema.safeParse(base.args);
      if (!parsed.success) return { ok: false, reason: "unsupported" };
      const { argv, cwd } = parsed.data;
      if (argv[0] !== settings.command) return { ok: false, reason: "unsupported" };
      const dir = await resolved(cwd);
      const roots = (
        await Promise.all(deps.workRoots(base.agentId).map((root) => resolved(root)))
      ).filter((root): root is string => root !== null);
      if (dir === null || rootHolding(roots, dir) === null) {
        return { ok: false, reason: "workdir_not_allowed" };
      }
      const normalized = normalizeCliArgv(argv as [string, ...string[]]);
      const refused = refusalReason(normalized.refusals);
      if (refused !== null) return { ok: false, reason: refused };
      const cli = normalized.cli;
      const tool = [cli.command, cli.verb, cli.subcommand].filter((p) => p !== undefined).join(" ");
      return {
        ok: true,
        call: {
          ...base,
          tool,
          // What runs: the resolved directory, so a symlink swapped after the decision can't move it.
          args: { argv, cwd: dir },
          cli,
          items: 1,
          ...(normalized.action === undefined ? {} : { action: normalized.action }),
          ...(normalized.kind === undefined ? {} : { kind: normalized.kind }),
          ...(normalized.repo === undefined ? {} : { repo: normalized.repo }),
          ...(normalized.persistence === true ? { persistence: true } : {}),
        },
      };
    },

    async execute(call, signal): Promise<CliResult> {
      const { argv, cwd } = CliArgsSchema.parse(call.args);
      const roots = (
        await Promise.all(deps.workRoots(call.agentId).map((root) => resolved(root)))
      ).filter((root): root is string => root !== null);
      const dir = await resolved(cwd);
      const workRoot = dir === null ? null : rootHolding(roots, dir);
      if (dir === null || workRoot === null || dir !== cwd) {
        throw new Error("the working directory moved after the decision");
      }
      const credential = (await deps.vault.accessToken(account.id)).reveal();
      const spec = credentialSpec(settings.command, settings.credentialEnv, credential);
      const process = await deps.start(
        sandbox,
        {
          binary: settings.bin,
          args: argv.slice(1),
          workRoot,
          cwd: dir,
          ...spec,
          network:
            settings.egress.length === 0
              ? { kind: "none" }
              : { kind: "egress", allow: settings.egress },
        },
        { signal },
      );
      const [stdout, stderr, outcome] = await Promise.all([
        collect(process.stdout),
        collect(process.stderr),
        process.done,
      ]);
      switch (outcome.kind) {
        case "exited":
          return { exitCode: outcome.code, stdout, stderr };
        case "limit":
          return { exitCode: 137, stdout, stderr, stopped: outcome.limit };
        case "aborted":
          return { exitCode: 130, stdout, stderr, stopped: "aborted" };
        case "sandbox_error":
          throw new Error(`the sandbox didn't start: ${outcome.detail}`);
      }
    },
  };
}

/** How the credential reaches each CLI. */
function credentialSpec(
  command: string,
  credentialEnv: string | null,
  credential: string,
): Pick<SandboxSpec, "env" | "secretEnv" | "files" | "secrets"> {
  if (command === "gh") {
    // GH_PROMPT_DISABLED: never wait on a terminal; GH_NO_UPDATE_NOTIFIER: no extra network.
    return {
      secretEnv: { GH_TOKEN: credential },
      env: { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
    };
  }
  if (command === "kubectl") {
    return {
      files: [{ name: "kubeconfig", content: credential }],
      env: { KUBECONFIG: `${SANDBOX_RUN}/kubeconfig`, KUBECTL_KUBERC: "false" },
      secrets: kubeconfigSecrets(credential),
    };
  }
  if (credentialEnv === null) throw new Error("this CLI account has no credential variable");
  return { secretEnv: { [credentialEnv]: credential } };
}
