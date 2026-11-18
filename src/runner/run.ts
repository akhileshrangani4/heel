/**
 * Runs one program under bubblewrap (spec: CLI runner, "Sandbox"). This is
 * the effectful shell around `planSandbox`: it starts the egress proxy when
 * the spec asks for one, spawns bwrap without a shell, feeds it its options
 * over a pipe, scrubs credentials from the output, enforces the wall-time and
 * output limits, and tears everything down when the program ends.
 *
 * The caller (D8b's `heel run`, D6a's code-mode worker) decides whether the
 * program may run at all; this module only makes sure that, when it runs, it
 * runs contained.
 */
import { type ChildProcess, type StdioOptions, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { type EgressDecision, type EgressProxy, startEgressProxy } from "./egress.ts";
import {
  ARGS_FD,
  planSandbox,
  type SandboxHost,
  type SandboxPlan,
  type SandboxSpec,
} from "./plan.ts";
import { createScrubber, type Scrubber, scrubAll } from "./scrub.ts";
import { buildSeccompFilter } from "./seccomp.ts";

export interface SandboxRunOptions {
  /** Aborting kills the sandbox and everything in it. */
  readonly signal?: AbortSignal;
  /** Every egress decision, for audit. */
  readonly onEgress?: (decision: EgressDecision) => void;
  /** An egress connection failed for a reason other than its decision; it was closed. */
  readonly onEgressError?: (error: unknown) => void;
}

export type SandboxOutcome =
  /** The program ran and exited. A program killed by a signal shows as `128 + n`, as in a shell. */
  | { readonly kind: "exited"; readonly code: number }
  /** heel killed the program for passing a limit. */
  | { readonly kind: "limit"; readonly limit: "time" | "output" }
  /** The caller aborted the run. */
  | { readonly kind: "aborted" }
  /** The sandbox never started; the program didn't run. `detail` is bwrap's own error. */
  | { readonly kind: "sandbox_error"; readonly detail: string };

export interface SandboxProcess {
  /**
   * The program's stdin when the spec asked for `pipe`; otherwise it reads
   * `/dev/null`. The caller owns its `error` events: a write after the
   * program exits fails with EPIPE.
   */
  readonly stdin: Writable | null;
  /** Scrubbed output. Consume both, or the program blocks once a pipe fills. */
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Settles after the program has ended, the output has drained and the egress proxy is closed. */
  readonly done: Promise<SandboxOutcome>;
  /** Kills the sandbox; `done` settles as `aborted`. */
  kill(): void;
}

export interface SandboxResult {
  readonly outcome: SandboxOutcome;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

/**
 * Starts `spec` under bubblewrap. Throws `SandboxSpecError` for a spec that
 * would weaken the sandbox and `EgressConfigError` for a bad allowlist,
 * before anything runs; everything after that is reported through `done`.
 */
export async function startSandboxed(
  host: SandboxHost,
  spec: SandboxSpec,
  options: SandboxRunOptions = {},
): Promise<SandboxProcess> {
  const egress =
    spec.network?.kind === "egress" ? await openEgress(spec.network.allow, options) : undefined;
  let plan: SandboxPlan;
  try {
    plan = planSandbox(host, spec, buildSeccompFilter(host.arch), egress?.proxy.socketPath);
  } catch (error) {
    await egress?.close();
    throw error;
  }
  try {
    return launch(host, spec, plan, egress, options);
  } catch (error) {
    await egress?.close();
    throw error;
  }
}

/** `startSandboxed`, with the output collected in memory (bounded by the output limit). */
export async function runSandboxed(
  host: SandboxHost,
  spec: SandboxSpec,
  options: SandboxRunOptions = {},
): Promise<SandboxResult> {
  const sandboxed = await startSandboxed(host, spec, options);
  const [stdout, stderr, outcome] = await Promise.all([
    collect(sandboxed.stdout),
    collect(sandboxed.stderr),
    sandboxed.done,
  ]);
  return { outcome, stdout, stderr };
}

/** bwrap reports `{"child-pid": N}` on its status fd once the sandbox is set up and the program started. */
export function statusShowsStarted(status: string): boolean {
  return /"child-pid"\s*:\s*\d+/.test(status);
}

/** The first line of bwrap's own error output, for the operator. */
export function sandboxErrorDetail(stderr: string, code: number): string {
  const line = stderr
    .split("\n")
    .map((text) => text.trim())
    .find((text) => text !== "");
  return line ?? `bwrap exited with status ${code} before the program started`;
}

interface OpenEgress {
  readonly proxy: EgressProxy;
  close(): Promise<void>;
}

/** The proxy listens in a fresh 0700 directory, so only heel's own uid (and the sandbox it maps) can connect. */
async function openEgress(
  allow: readonly string[],
  options: SandboxRunOptions,
): Promise<OpenEgress> {
  const dir = await mkdtemp(join(tmpdir(), "heel-egress-"));
  try {
    const proxy = await startEgressProxy({
      socketPath: join(dir, "egress.sock"),
      allow,
      ...(options.onEgress === undefined ? {} : { onDecision: options.onEgress }),
      ...(options.onEgressError === undefined ? {} : { onError: options.onEgressError }),
    });
    return {
      proxy,
      async close() {
        await proxy.close();
        await rm(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

function launch(
  host: SandboxHost,
  spec: SandboxSpec,
  plan: SandboxPlan,
  egress: OpenEgress | undefined,
  options: SandboxRunOptions,
): SandboxProcess {
  const stdio: StdioOptions = [spec.stdin === "pipe" ? "pipe" : "ignore", "pipe", "pipe"];
  plan.fds.forEach((fd, index) => {
    if (fd.fd !== ARGS_FD + index) throw new Error(`sandbox plan fds out of order at ${fd.fd}`);
    stdio.push("pipe");
  });
  // bwrap gets an empty environment: --clearenv builds the program's, and heel's own must not leak.
  const child = spawn(host.bwrap, plan.argv, { stdio, env: {}, shell: false });
  try {
    return supervise(child, spec, plan, egress, options);
  } catch (error) {
    // bwrap is already running and would wait on its option pipe forever; it must not be left behind.
    child.kill("SIGKILL");
    throw error;
  }
}

function supervise(
  child: ChildProcess,
  spec: SandboxSpec,
  plan: SandboxPlan,
  egress: OpenEgress | undefined,
  options: SandboxRunOptions,
): SandboxProcess {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const run = new RunState(child, plan, stdout, stderr);
  connectPlanFds(child, plan, run);

  const timer = setTimeout(
    () => run.stop({ kind: "limit", limit: "time" }),
    plan.limits.wallTimeMs,
  );
  const onAbort = (): void => run.stop({ kind: "aborted" });
  if (options.signal?.aborted === true) onAbort();
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const done = run.finished.finally(async () => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    await egress?.close();
  });

  return {
    stdin: spec.stdin === "pipe" ? child.stdin : null,
    stdout,
    stderr,
    done,
    kill: () => run.stop({ kind: "aborted" }),
  };
}

/** Feeds bwrap its option, seccomp and file fds, and listens on its status fd. */
function connectPlanFds(child: ChildProcess, plan: SandboxPlan, run: RunState): void {
  for (const fd of plan.fds) {
    const stream = child.stdio[fd.fd];
    if (fd.kind === "write") {
      if (!(stream instanceof Writable)) throw new Error(`sandbox fd ${fd.fd} has no input pipe`);
      // bwrap exited before reading its input; reported through `done` if the program never started.
      stream.on("error", (error: Error) => run.inputError(fd.fd, error));
      stream.end(fd.data);
    } else {
      if (!(stream instanceof Readable)) throw new Error(`sandbox fd ${fd.fd} has no status pipe`);
      stream.setEncoding("utf8");
      stream.on("data", (text: string) => run.status(text));
    }
  }
}

/** Output, limits and the outcome of one bwrap process. */
class RunState {
  readonly finished: Promise<SandboxOutcome>;
  private statusText = "";
  private outputBytes = 0;
  private stopped: SandboxOutcome | undefined;
  private inputFailure: string | undefined;
  /** stderr held back until the status fd says the program started; before that it is bwrap's own. */
  private earlyStderr: Buffer[] = [];
  private readonly stdoutScrubber: Scrubber;
  private readonly stderrScrubber: Scrubber;
  private readonly child: ChildProcess;
  private readonly plan: SandboxPlan;
  private readonly stdout: PassThrough;
  private readonly stderr: PassThrough;

  constructor(child: ChildProcess, plan: SandboxPlan, stdout: PassThrough, stderr: PassThrough) {
    this.child = child;
    this.plan = plan;
    this.stdout = stdout;
    this.stderr = stderr;
    this.stdoutScrubber = createScrubber(plan.secrets);
    this.stderrScrubber = createScrubber(plan.secrets);
    child.stdout?.on("data", (chunk: Buffer) => this.output(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => this.output(chunk, "stderr"));
    this.finished = new Promise((resolve) => {
      let spawnError: Error | undefined;
      child.on("error", (error) => {
        spawnError = error;
      });
      // `close` fires once the process has exited and every pipe has drained.
      child.on("close", (code, signal) =>
        resolve(this.outcome(exitCode(code, signal), spawnError)),
      );
    });
  }

  status(text: string): void {
    this.statusText += text;
  }

  inputError(fd: number, error: Error): void {
    this.inputFailure ??= `bwrap stopped reading fd ${fd}: ${error.message}`;
  }

  stop(outcome: SandboxOutcome): void {
    if (this.stopped !== undefined) return;
    this.stopped = outcome;
    // Killing bwrap kills the sandbox: its init has --die-with-parent, and the pid namespace dies with init.
    this.child.kill("SIGKILL");
  }

  private get started(): boolean {
    return statusShowsStarted(this.statusText);
  }

  private output(chunk: Buffer, stream: "stdout" | "stderr"): void {
    this.outputBytes += chunk.length;
    if (this.outputBytes > this.plan.limits.maxOutputBytes) {
      this.stop({ kind: "limit", limit: "output" });
      return;
    }
    if (stream === "stdout") {
      this.forward(this.child.stdout, this.stdout, this.stdoutScrubber.push(chunk));
    } else if (this.started) {
      this.flushEarlyStderr();
      this.forward(this.child.stderr, this.stderr, this.stderrScrubber.push(chunk));
    } else {
      this.earlyStderr.push(chunk);
    }
  }

  /** Backpressure: a consumer that stops reading stalls the program rather than growing heel's memory. */
  private forward(source: Readable | null, sink: PassThrough, data: Buffer): void {
    if (sink.write(data) || source === null) return;
    source.pause();
    sink.once("drain", () => source.resume());
  }

  private flushEarlyStderr(): void {
    for (const held of this.earlyStderr) this.stderr.write(this.stderrScrubber.push(held));
    this.earlyStderr = [];
  }

  private outcome(code: number, spawnError: Error | undefined): SandboxOutcome {
    const started = this.started;
    if (started) this.flushEarlyStderr();
    this.stdout.end(this.stdoutScrubber.end());
    this.stderr.end(this.stderrScrubber.end());
    if (this.stopped !== undefined) return this.stopped;
    if (spawnError !== undefined)
      return { kind: "sandbox_error", detail: `can't start bwrap: ${spawnError.message}` };
    if (!started) {
      const early = Buffer.concat(this.earlyStderr).toString("utf8");
      const detail =
        early.trim() === "" && this.inputFailure !== undefined ? this.inputFailure : early;
      // bwrap's errors can quote its options, and the credential --setenv values are among them.
      const scrubbed = scrubAll(Buffer.from(detail, "utf8"), this.plan.secrets).toString("utf8");
      return { kind: "sandbox_error", detail: sandboxErrorDetail(scrubbed, code) };
    }
    return { kind: "exited", code };
  }
}

/** A process's status as a shell reports it: its exit code, or `128 + n` for signal `n`. */
export function exitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  const number = signal === null ? undefined : constants.signals[signal];
  return 128 + (number ?? 0);
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}
