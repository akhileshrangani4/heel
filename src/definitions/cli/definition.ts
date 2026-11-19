import { realpath } from "node:fs/promises";
import { sep } from "node:path";
import { z } from "zod";
import type { Call, CliFields } from "../../core/call.ts";
import type { StateCheck } from "../../core/rules/compile.ts";
import type {
  Definition,
  HardDenyReason,
  NormalizeContext,
  Normalized,
  PauseTarget,
} from "../../gateway/pipeline/ports.ts";
import { type CredentialAuth, newPlaceholder } from "../../runner/intercept.ts";
import {
  type CredentialInjection,
  DEFAULT_LIMITS,
  type SandboxHost,
  type SandboxNetwork,
  type SandboxSpec,
} from "../../runner/plan.ts";
import type { SandboxProcess, SandboxRunOptions } from "../../runner/run.ts";
import type { AccountRecord } from "../../store/directory.ts";
import type { Vault } from "../../vault/vault.ts";
import { GitHubApi } from "../github/api.ts";
import { GitHubNotFoundError } from "../github/client.ts";
import { isMergeAction, isWorkflowPath } from "../github/definition.ts";
import type { FetchFn } from "../sign-in.ts";
import { GH_MERGE_BYPASS_FLAGS } from "./gh-actions.ts";
import { normalizeCliArgv } from "./index.ts";
import { type CliSettings, cliSettings, GH_EGRESS } from "./settings.ts";
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
 * - `gh` never holds its token: `GH_TOKEN` is an inert placeholder, and
 *   heel's egress proxy puts the real token in the `Authorization` header of
 *   requests to GitHub's own hosts (spec: CLI runner, "Credential delivery").
 * - Only the `/run` surface reaches it; an MCP call naming the account is
 *   refused.
 * - `gh pr merge` (D11) is pinned: heel reads the pull request's head
 *   commit and adds `--match-head-commit <sha>`, so GitHub refuses the merge
 *   if the head moves after the decision. `checks: passing` is read on that
 *   same commit, and fails when `--admin` or `--auto` would skip checks. A
 *   merge heel can't pin (no PR number or repo) is refused.
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
  /** Set when heel stopped the program (a limit, an abort) or never started it. */
  stopped?: "time" | "output" | "aborted" | "workdir_moved" | "sandbox_error";
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
  /** For the GitHub reads `gh pr merge` needs (D11). */
  fetch: FetchFn;
  /**
   * Whether a pause now covers this call's agent, owner, account or provider.
   * heel's egress proxy asks before every request it adds the credential to,
   * so a pause stops a command that is already running. Absent: never paused.
   */
  paused?: (target: PauseTarget) => boolean;
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

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

export function cliDefinition(account: AccountRecord, deps: CliDeps): Definition | null {
  const settings = cliSettings(account.settings);
  // Without the sandbox there's no definition, so every command is denied (spec: Fail-closed behavior).
  if (settings === null || deps.sandbox === null) return null;
  // kubectl reads its credential from a file the command can be pointed at (see `cliAccountSettings`).
  if (settings.command === "kubectl") return null;
  const sandbox = deps.sandbox;
  const credential = async () => (await deps.vault.accessToken(account.id)).reveal();

  /** `gh pr merge`, pinned to the pull request's current head (D11). */
  async function pinMerge(
    normalized: ReturnType<typeof normalizeCliArgv>,
    argv: readonly string[],
    signal: AbortSignal,
  ): Promise<
    | { ok: true; cli: CliFields; argv: string[]; targets: string[]; persistence: boolean }
    | { ok: false; reason: HardDenyReason }
  > {
    const { pull, repo } = normalized;
    if (pull === undefined || repo === undefined || normalized.dashDash === true) {
      return { ok: false, reason: "unsupported" };
    }
    let sha: string;
    let persistence: boolean;
    try {
      const api = new GitHubApi(credential, deps.fetch);
      const head = await api.pullHead(repo, pull.number, signal);
      if (head.state !== "open" || head.merged) return { ok: false, reason: "unsupported" };
      sha = head.sha;
      // Merging lands its files on the base branch: a workflow among them is persistence (I-70).
      persistence = (await api.pullFiles(repo, pull.number, signal)).some(isWorkflowPath);
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof GitHubNotFoundError ? "not_available" : "lookup_unavailable",
      };
    }
    const given = normalized.cli.flags["match-head-commit"];
    if (given !== undefined && given !== sha) return { ok: false, reason: "unsupported" };
    const pinned = given === undefined ? [...argv, "--match-head-commit", sha] : [...argv];
    return {
      ok: true,
      cli: {
        ...normalized.cli,
        flags: { ...normalized.cli.flags, "match-head-commit": sha },
        argv: pinned,
      },
      argv: pinned,
      targets: [`${repo}#${pull.number}`],
      persistence,
    };
  }

  /**
   * The agent's roots that are still what was configured. Roots are stored
   * resolved, so one whose path now resolves elsewhere (a parent renamed, a
   * symlink put in its place) is skipped: otherwise the agent could point
   * its writable root at heel's own state.
   */
  async function liveRoots(agentId: string): Promise<string[]> {
    const roots = deps.workRoots(agentId);
    const now = await Promise.all(roots.map((root) => resolved(root)));
    return roots.filter((root, i) => now[i] === root);
  }

  return {
    async normalize(base: Call, ctx: NormalizeContext): Promise<Normalized> {
      // Only `heel run` reaches a CLI account, so a rule keyed on `surface: cli` sees every command.
      if (base.surface !== "cli") return { ok: false, reason: "unsupported" };
      const parsed = CliArgsSchema.safeParse(base.args);
      if (!parsed.success) return { ok: false, reason: "unsupported" };
      const { argv, cwd } = parsed.data;
      if (argv[0] !== settings.command) return { ok: false, reason: "unsupported" };
      const dir = await resolved(cwd);
      if (dir === null || rootHolding(await liveRoots(base.agentId), dir) === null) {
        return { ok: false, reason: "workdir_not_allowed" };
      }
      // Paths into the sandbox's own files (credential files, the egress socket, /proc).
      if (argv.slice(1).some(namesSandboxInternals)) return { ok: false, reason: "unsupported" };
      const normalized = normalizeCliArgv(argv as [string, ...string[]]);
      const refused = refusalReason(normalized.refusals);
      if (refused !== null) return { ok: false, reason: refused };
      // Without -R, gh reads the repo from the checkout's git remotes, which rules can't see.
      if (normalized.takesRepo === true && normalized.repo === undefined) {
        return { ok: false, reason: "unsupported" };
      }
      let cli = normalized.cli;
      let runArgv = argv;
      let targets: string[] | undefined;
      let mergePersistence = false;
      if (settings.command === "gh" && normalized.action === "github.merge") {
        const pinned = await pinMerge(normalized, argv, ctx.signal);
        if (!pinned.ok) return pinned;
        ({ cli, argv: runArgv, targets } = pinned);
        if (pinned.persistence) mergePersistence = true;
      }
      const tool = [cli.command, cli.verb, cli.subcommand].filter((p) => p !== undefined).join(" ");
      return {
        ok: true,
        call: {
          ...base,
          tool,
          // What runs: the resolved directory, so a symlink swapped after the decision can't move it.
          args: { argv: runArgv, cwd: dir },
          cli,
          items: 1,
          ...(targets === undefined ? {} : { targets }),
          // A merge that lands automation is its own action, so a rule allowing ordinary merges doesn't reach it.
          ...(mergePersistence
            ? { action: "github.workflow.merge" }
            : normalized.action === undefined
              ? {}
              : { action: normalized.action }),
          ...(normalized.kind === undefined ? {} : { kind: normalized.kind }),
          ...(normalized.repo === undefined ? {} : { repo: normalized.repo }),
          ...(normalized.persistence === true || mergePersistence ? { persistence: true } : {}),
        },
      };
    },

    // The sandbox's own wall-time limit, not the pipeline's 60-second upstream deadline.
    executeTimeoutMs: DEFAULT_LIMITS.wallTimeMs + 30_000,

    async stateCheck(check: StateCheck, call: Call, signal: AbortSignal): Promise<"pass" | "fail"> {
      if (check !== "checks" || settings.command !== "gh" || !isMergeAction(call.action)) {
        return "fail";
      }
      const flags = call.cli?.flags ?? {};
      if (GH_MERGE_BYPASS_FLAGS.some((flag) => flags[flag] === true)) return "fail";
      const sha = flags["match-head-commit"];
      if (typeof sha !== "string" || call.repo === undefined) return "fail";
      const number = Number(call.targets?.[0]?.split("#")[1]);
      const api = new GitHubApi(credential, deps.fetch);
      // The base branch decides which checks are required; the head stays the one pinned.
      const { base } = await api.pullHead(call.repo, number, signal);
      return (await api.checksPass(call.repo, sha, base, signal)) ? "pass" : "fail";
    },

    async execute(call, signal): Promise<CliResult> {
      const { argv, cwd } = CliArgsSchema.parse(call.args);
      const dir = await resolved(cwd);
      const workRoot = dir === null ? null : rootHolding(await liveRoots(call.agentId), dir);
      if (dir === null || workRoot === null || dir !== cwd) {
        // Nothing ran; the result says so rather than leaving the outcome unknown.
        return notRun("workdir_moved", "the working directory moved after the decision");
      }
      const target: PauseTarget = {
        orgId: call.orgId,
        agentId: call.agentId,
        ownerId: call.ownerId,
        account: call.account,
        provider: call.provider,
      };
      // Read for each request the proxy injects into; a pause since the decision stops it.
      const current = async (): Promise<string> => {
        if (deps.paused?.(target) === true) throw new Error("paused");
        return credential();
      };
      const { inject, ...spec } = credentialSpec(settings, await credential(), current, call.repo);
      const process = await deps.start(
        sandbox,
        {
          binary: settings.bin,
          args: argv.slice(1),
          workRoot,
          cwd: dir,
          ...spec,
          // No /proc: a credential in the environment can't be read back as a file.
          proc: false,
          network: cliNetwork(settings.egress, inject),
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
          return notRun("sandbox_error", "the sandbox didn't start");
      }
    },
  };
}

function notRun(stopped: "workdir_moved" | "sandbox_error", detail: string): CliResult {
  return { exitCode: 70, stdout: "", stderr: `heel: ${detail}\n`, stopped };
}

/**
 * A path into the sandbox's own files: `/proc`, `/dev/fd`, `/heel` (credential
 * files and the egress socket), however it is written (`--from-file=x=/heel/…`,
 * `@/proc/…`, `../../proc/…`).
 */
export function namesSandboxInternals(arg: string): boolean {
  return /(^|[=@:,]|\/)(\.\.\/)*\/?(proc|heel|dev\/fd|dev\/std(in|out|err))(\/|$)/.test(arg);
}

/** The base64 forms of a secret, so a command that encodes it is still scrubbed. */
function encodings(secret: string): string[] {
  const bytes = Buffer.from(secret, "utf8");
  return [bytes.toString("base64"), bytes.toString("base64url"), bytes.toString("hex")];
}

/** `gh` sends `Authorization: token <GH_TOKEN>`; GitHub also takes `bearer`. */
const GH_AUTH: CredentialAuth = { type: "authorization", schemes: ["token", "bearer"] };

function cliNetwork(
  egress: readonly string[],
  inject: CredentialInjection | undefined,
): SandboxNetwork {
  if (egress.length === 0) return { kind: "none" };
  return { kind: "egress", allow: egress, ...(inject === undefined ? {} : { inject }) };
}

/**
 * How the credential reaches each CLI. `credential` is its value now, for the
 * host-side output scrub; `current` reads it again for each request heel's
 * proxy injects it into.
 */
export function credentialSpec(
  settings: Pick<CliSettings, "command" | "credentialEnv" | "egress">,
  credential: string,
  current: () => Promise<string>,
  repo: string | undefined,
): Pick<SandboxSpec, "env" | "secretEnv" | "files" | "secrets"> & {
  inject?: CredentialInjection;
} {
  if (settings.command === "gh") {
    // Only GitHub's own hosts get the token; an extra --egress host gets the placeholder at most.
    const hosts = GH_EGRESS.filter((host) => settings.egress.includes(host));
    const placeholder = newPlaceholder();
    return {
      ...(hosts.length === 0
        ? {}
        : { inject: { hosts, auth: GH_AUTH, placeholder, credential: current } }),
      env: {
        // Inert: heel's proxy swaps it for the token, in the Authorization header only.
        GH_TOKEN: placeholder,
        // Never wait on a terminal, and no update check over the network.
        GH_PROMPT_DISABLED: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
        // git never reads the agent's checkout: its config and hooks could run code with GH_TOKEN set.
        GIT_DIR: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        // The repo rules saw, not one gh would read from git remotes.
        ...(repo === undefined ? {} : { GH_REPO: repo }),
      },
      // The sandbox never had it, but an upstream could still echo it back.
      secrets: [credential, ...encodings(credential)],
    };
  }
  const credentialEnv = settings.credentialEnv;
  if (credentialEnv === null) throw new Error("this CLI account has no credential variable");
  return { secretEnv: { [credentialEnv]: credential }, secrets: encodings(credential) };
}
