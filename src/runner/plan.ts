/**
 * The bubblewrap command line for one sandboxed process (spec: CLI runner,
 * "Sandbox"), built by a pure function so every mount, namespace and
 * environment variable is table-testable without bwrap.
 *
 * Inside the sandbox the program sees:
 * - `/usr` (and the host's `/bin`, `/lib*` links into it), the CA bundle,
 *   and any extra read-only paths the caller names, all read-only;
 * - its binary, read-only at the same absolute path;
 * - the work root, read-write at the same path, starting in `cwd`;
 * - a private `/proc`, a minimal `/dev`, and tmpfs `HOME` (`/heel/home`) and `/tmp`;
 * - credential files, read-only under `/heel/run`;
 * - nothing else from the host: no other home directories, no `/etc/passwd`,
 *   no heel state, and no network unless egress is on.
 */
import { posix } from "node:path";
import type { SeccompArch } from "./seccomp.ts";

/** Defaults from the spec's CLI runner limits. */
export const DEFAULT_LIMITS: SandboxLimits = {
  wallTimeMs: 10 * 60 * 1000,
  memoryBytes: 1024 * 1024 * 1024,
  maxProcesses: 256,
  maxOutputBytes: 16 * 1024 * 1024,
};

/** The longest delay a Node timer supports (2^31 - 1 ms, about 24.8 days). */
export const MAX_WALL_TIME_MS = 2_147_483_647;

export interface SandboxLimits {
  /** Killed after this long (spec: 10 minutes). */
  readonly wallTimeMs: number;
  /** RLIMIT_DATA: heap and anonymous mappings (spec: 1 GB). */
  readonly memoryBytes: number;
  /** RLIMIT_NPROC inside the sandbox's user namespace (spec: 256 pids). */
  readonly maxProcesses: number;
  /** Killed once stdout or stderr passes this many bytes. */
  readonly maxOutputBytes: number;
}

/** A file heel writes into the sandbox, read-only at `/heel/run/<name>`. */
export interface SandboxFile {
  readonly name: string;
  readonly content: string | Uint8Array;
}

export type SandboxNetwork =
  /** No network namespace route out; loopback only. */
  | { readonly kind: "none" }
  /** Only through heel's egress proxy, to the listed `host[:port]` entries (port 443 by default). */
  | { readonly kind: "egress"; readonly allow: readonly string[] };

/** What a caller asks for. Paths are absolute and already resolved (no symlinks). */
export interface SandboxSpec {
  /** Absolute path of the program; never looked up on PATH, never run through a shell. */
  readonly binary: string;
  readonly args: readonly string[];
  /** The agent's work root, mounted read-write at the same path. */
  readonly workRoot: string;
  /** Where the program starts; must sit inside `workRoot`. */
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Credential variables. Each value is also scrubbed from the output. */
  readonly secretEnv?: Readonly<Record<string, string>>;
  readonly files?: readonly SandboxFile[];
  /** More values to scrub from the output, e.g. the token inside a generated kubeconfig. */
  readonly secrets?: readonly string[];
  /** Extra host paths to expose read-only at the same path (e.g. a runtime outside `/usr`). */
  readonly readOnlyPaths?: readonly string[];
  readonly network?: SandboxNetwork;
  readonly limits?: Partial<SandboxLimits>;
  /** `null` (the default) gives the program `/dev/null`; `pipe` hands the caller its stdin. */
  readonly stdin?: "null" | "pipe";
}

/** A top-level host directory the sandbox mirrors: a symlink into `/usr`, or a real directory. */
export type SystemDir =
  | { readonly path: string; readonly kind: "symlink"; readonly target: string }
  | { readonly path: string; readonly kind: "dir" };

/** Facts about the host the plan depends on, gathered once by `detectSandboxHost`. */
export interface SandboxHost {
  readonly bwrap: string;
  readonly prlimit: string;
  /** The Node binary that runs the egress relay inside the sandbox. */
  readonly node: string;
  /** The relay script (`relay.ts`). */
  readonly relay: string;
  readonly arch: SeccompArch;
  readonly systemDirs: readonly SystemDir[];
}

/** Where things live inside the sandbox. */
export const SANDBOX_HOME = "/heel/home";
export const SANDBOX_RUN = "/heel/run";
export const SANDBOX_TMP = "/tmp";
export const SANDBOX_RELAY = "/heel/relay.ts";
export const SANDBOX_EGRESS_SOCKET = `${SANDBOX_RUN}/egress.sock`;
/** The relay's loopback port inside the sandbox's own network namespace. */
export const RELAY_PORT = 3128;
const SANDBOX_PATH_ENV = "/usr/local/bin:/usr/bin:/bin";

/** Paths the sandbox builds itself; nothing from the host may be mounted at, above or below them. */
const SANDBOX_ROOTS = ["/heel", "/proc", "/dev", "/sys"];
/**
 * The host's system view, mounted read-only (or as links into `/usr`). The
 * work root can't sit in it, and an extra read-only path inside `/usr` is
 * already visible.
 */
const SYSTEM_ROOTS = ["/usr", "/etc", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"];
/**
 * The sandbox's `/tmp` is its own tmpfs. A host path below `/tmp` can be
 * mounted on top of it, but mounting `/tmp` itself (or `/`) would expose the
 * host's shared temporary files.
 */
const SANDBOX_TMPFS = "/tmp";

/** Variables the runner sets itself. */
const RESERVED_ENV = new Set([
  "HOME",
  "TMPDIR",
  "PATH",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
]);
/** Prefixes that make the dynamic loader or a runtime load code the caller didn't name. */
const RESERVED_ENV_PREFIXES = ["LD_", "NODE_", "BASH_FUNC_"];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class SandboxSpecError extends Error {
  override readonly name = "SandboxSpecError";
}

/** One fd the child inherits: data heel writes into it, or a status pipe heel reads. */
export type PlanFd =
  | { readonly fd: number; readonly kind: "write"; readonly data: Uint8Array }
  | { readonly fd: number; readonly kind: "status" };

type PlanFdRequest =
  | { readonly kind: "write"; readonly data: Uint8Array }
  | { readonly kind: "status" };

export interface SandboxPlan {
  /**
   * bwrap's real argv: `--args 3 -- <command…>`. Every option, including the
   * credential `--setenv`s, travels over fd 3 instead, because any local user
   * can read a process's `/proc/<pid>/cmdline` but only its owner can read
   * `environ`. The command itself is the agent's own argv and isn't secret.
   */
  readonly argv: readonly string[];
  /** The options sent over fd 3, for inspection and tests. */
  readonly options: readonly string[];
  /** Extra fds from 3 upward, in order. */
  readonly fds: readonly PlanFd[];
  /** The fd bwrap reports `child-pid` on once the sandbox is set up. */
  readonly statusFd: number;
  readonly limits: SandboxLimits;
  /** Values scrubbed from stdout and stderr. */
  readonly secrets: readonly string[];
}

/** The fd carrying bwrap's options; always the first extra fd. */
export const ARGS_FD = 3;

/**
 * The bwrap invocation for `spec`. `egressSocket` is the host path of the
 * egress proxy's socket, required exactly when the spec asks for egress.
 * Throws `SandboxSpecError` for anything that would weaken the sandbox.
 */
export function planSandbox(
  host: SandboxHost,
  spec: SandboxSpec,
  seccomp: Uint8Array,
  egressSocket?: string,
): SandboxPlan {
  validateSpec(spec);
  const limits = { ...DEFAULT_LIMITS, ...spec.limits };
  validateLimits(limits);
  const egress = spec.network?.kind === "egress";
  if (egress !== (egressSocket !== undefined)) {
    throw new SandboxSpecError("an egress socket is needed exactly when the network is egress");
  }
  if (egressSocket !== undefined) requirePath("egress socket", egressSocket);
  // These run with the credentials in their environment, so the agent mustn't be able to swap them (I-34).
  for (const path of [host.prlimit, ...(egress ? [host.node, host.relay] : [])]) {
    if (overlaps(path, spec.workRoot)) {
      throw new SandboxSpecError(`${path} is inside the writable work root`);
    }
  }

  // fd 3 (the options) is filled in last, once every other fd number is known.
  const fds: PlanFd[] = [];
  const allocate = (request: PlanFdRequest): number => {
    const number = ARGS_FD + 1 + fds.length;
    fds.push({ ...request, fd: number });
    return number;
  };
  const statusFd = allocate({ kind: "status" });
  const seccompFd = allocate({ kind: "write", data: seccomp });

  const options = [
    ...NAMESPACE_OPTIONS,
    "--json-status-fd",
    String(statusFd),
    "--seccomp",
    String(seccompFd),
    ...systemMounts(host),
    ...programMounts(host, spec, egressSocket),
  ];
  for (const file of spec.files ?? []) {
    const fd = allocate({ kind: "write", data: toBytes(file.content) });
    options.push("--ro-bind-data", String(fd), `${SANDBOX_RUN}/${file.name}`);
  }
  options.push("--bind", spec.workRoot, spec.workRoot, "--remount-ro", "/", "--chdir", spec.cwd);
  for (const [name, value] of Object.entries(sandboxEnv(spec, egress))) {
    options.push("--setenv", name, value);
  }

  const optionBytes = Buffer.from(options.map((option) => `${option}\0`).join(""), "utf8");
  return {
    argv: ["--args", String(ARGS_FD), "--", ...sandboxCommand(host, spec, limits, egress)],
    options,
    fds: [{ fd: ARGS_FD, kind: "write", data: optionBytes }, ...fds],
    statusFd,
    limits,
    secrets: secretsOf(spec),
  };
}

const NAMESPACE_OPTIONS = [
  "--unshare-user",
  "--unshare-pid",
  "--unshare-ipc",
  "--unshare-uts",
  "--unshare-net",
  "--unshare-cgroup-try",
  "--disable-userns",
  "--die-with-parent",
  "--new-session",
  "--clearenv",
  "--hostname",
  "heel-sandbox",
];

/** The read-only system view plus the sandbox's own `/proc`, `/dev` and tmpfs directories. */
function systemMounts(host: SandboxHost): string[] {
  const options = ["--ro-bind", "/usr", "/usr"];
  for (const dir of host.systemDirs) {
    if (dir.kind === "symlink") options.push("--symlink", dir.target, dir.path);
    else options.push("--ro-bind", dir.path, dir.path);
  }
  for (const certs of ["/etc/ssl", "/etc/ca-certificates", "/etc/pki"]) {
    options.push("--ro-bind-try", certs, certs);
  }
  options.push(
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    SANDBOX_TMP,
    "--dir",
    "/heel",
    "--tmpfs",
    SANDBOX_HOME,
    "--dir",
    SANDBOX_RUN,
  );
  return options;
}

/** The binary, extra read-only paths and, with egress, the relay and the proxy socket. */
function programMounts(
  host: SandboxHost,
  spec: SandboxSpec,
  egressSocket: string | undefined,
): string[] {
  const readOnly = new Set<string>(spec.readOnlyPaths ?? []);
  readOnly.add(spec.binary);
  readOnly.add(host.prlimit);
  if (egressSocket !== undefined) readOnly.add(host.node);
  const options: string[] = [];
  for (const path of readOnly) {
    // `/usr` is already mounted, and bwrap can't create a mount point inside a read-only mount.
    if (!isUnder(path, "/usr")) options.push("--ro-bind", path, path);
  }
  if (egressSocket !== undefined) {
    options.push(
      "--ro-bind",
      host.relay,
      SANDBOX_RELAY,
      "--bind",
      egressSocket,
      SANDBOX_EGRESS_SOCKET,
    );
  }
  return options;
}

/** The program's whole environment; nothing is inherited from heel. */
export function sandboxEnv(spec: SandboxSpec, egress: boolean): Record<string, string> {
  const env: Record<string, string> = {
    ...spec.env,
    ...spec.secretEnv,
    HOME: SANDBOX_HOME,
    TMPDIR: SANDBOX_TMP,
    PATH: SANDBOX_PATH_ENV,
  };
  if (egress) {
    const proxy = `http://127.0.0.1:${RELAY_PORT}`;
    Object.assign(env, {
      HTTPS_PROXY: proxy,
      HTTP_PROXY: proxy,
      https_proxy: proxy,
      http_proxy: proxy,
    });
  }
  return env;
}

/** prlimit sets the limits, the relay (with egress) opens the proxy port, then the program runs. */
function sandboxCommand(
  host: SandboxHost,
  spec: SandboxSpec,
  limits: SandboxLimits,
  egress: boolean,
): string[] {
  const command = [
    host.prlimit,
    "--core=0",
    `--data=${limits.memoryBytes}`,
    `--nproc=${limits.maxProcesses}`,
    "--",
  ];
  if (egress) {
    command.push(
      host.node,
      SANDBOX_RELAY,
      "--socket",
      SANDBOX_EGRESS_SOCKET,
      "--port",
      String(RELAY_PORT),
      "--",
    );
  }
  command.push(spec.binary, ...spec.args);
  return command;
}

/** Every value scrubbed from the output: credential env values and the explicit list. */
export function secretsOf(spec: SandboxSpec): string[] {
  const values = [...Object.values(spec.secretEnv ?? {}), ...(spec.secrets ?? [])];
  return [...new Set(values.filter((value) => value !== ""))];
}

function validateSpec(spec: SandboxSpec): void {
  requirePath("binary", spec.binary);
  requirePath("work root", spec.workRoot);
  requirePath("cwd", spec.cwd);
  const reserved = [...SANDBOX_ROOTS, ...SYSTEM_ROOTS].find((root) =>
    overlaps(spec.workRoot, root),
  );
  if (reserved !== undefined || isUnder(SANDBOX_TMPFS, spec.workRoot)) {
    throw new SandboxSpecError(
      `the work root ${spec.workRoot} overlaps ${reserved ?? SANDBOX_TMPFS}`,
    );
  }
  if (!isUnder(spec.cwd, spec.workRoot)) {
    throw new SandboxSpecError(`cwd ${spec.cwd} is outside the work root ${spec.workRoot}`);
  }
  // A binary the agent can write to is a binary the agent can swap (I-34).
  for (const path of [spec.binary, ...(spec.readOnlyPaths ?? [])]) {
    requirePath("read-only path", path);
    if (overlaps(path, spec.workRoot)) {
      throw new SandboxSpecError(`${path} is inside the writable work root`);
    }
    if (!isMountableReadOnly(path)) {
      throw new SandboxSpecError(`${path} can't be mounted into the sandbox`);
    }
  }
  for (const env of [spec.env, spec.secretEnv]) {
    for (const [name, value] of Object.entries(env ?? {})) validateEnv(name, value);
  }
  const shadowed = Object.keys(spec.env ?? {}).find((name) =>
    Object.hasOwn(spec.secretEnv ?? {}, name),
  );
  if (shadowed !== undefined) {
    throw new SandboxSpecError(`${shadowed} is in both env and secretEnv`);
  }
  const names = new Set<string>();
  for (const file of spec.files ?? []) {
    if (!FILE_NAME.test(file.name) || file.name === "egress.sock") {
      throw new SandboxSpecError(`bad sandbox file name: ${JSON.stringify(file.name)}`);
    }
    if (names.has(file.name)) throw new SandboxSpecError(`duplicate sandbox file: ${file.name}`);
    names.add(file.name);
  }
  for (const arg of spec.args) {
    if (arg.includes("\0")) throw new SandboxSpecError("an argument contains a NUL byte");
  }
  if (spec.network?.kind === "egress" && spec.network.allow.length === 0) {
    throw new SandboxSpecError("egress needs at least one allowed host; use network none instead");
  }
}

function validateEnv(name: string, value: string): void {
  if (!ENV_NAME.test(name)) throw new SandboxSpecError(`bad environment variable name: ${name}`);
  if (RESERVED_ENV.has(name) || RESERVED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    throw new SandboxSpecError(`${name} is set by the runner and can't be overridden`);
  }
  if (value.includes("\0")) throw new SandboxSpecError(`${name} contains a NUL byte`);
}

function validateLimits(limits: SandboxLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new SandboxSpecError(`limit ${name} must be a positive integer`);
    }
  }
  // Node fires a longer timer at once, which would kill every program on start.
  if (limits.wallTimeMs > MAX_WALL_TIME_MS) {
    throw new SandboxSpecError(`limit wallTimeMs can't exceed ${MAX_WALL_TIME_MS}`);
  }
}

/** Absolute, normalized, no trailing slash, no NUL: bwrap and the checks above compare strings. */
function requirePath(what: string, path: string): void {
  if (
    !path.startsWith("/") ||
    path.includes("\0") ||
    posix.normalize(path) !== path ||
    (path.length > 1 && path.endsWith("/"))
  ) {
    throw new SandboxSpecError(
      `${what} must be an absolute, normalized path: ${JSON.stringify(path)}`,
    );
  }
}

/** Inside `/usr` (already visible), or clear of the sandbox's own and system directories and the shared `/tmp`. */
function isMountableReadOnly(path: string): boolean {
  if (isUnder(path, "/usr") && path !== "/usr") return true;
  if (SANDBOX_ROOTS.some((root) => overlaps(path, root))) return false;
  if (SYSTEM_ROOTS.some((root) => overlaps(path, root))) return false;
  return !isUnder(SANDBOX_TMPFS, path);
}

/** `path` is `root` or below it. */
export function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root === "/" ? "/" : `${root}/`);
}

function overlaps(a: string, b: string): boolean {
  return isUnder(a, b) || isUnder(b, a);
}

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? Buffer.from(content, "utf8") : content;
}
