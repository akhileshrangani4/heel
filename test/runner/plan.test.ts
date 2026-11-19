import { describe, expect, it } from "vitest";
import {
  ARGS_FD,
  type CredentialInjection,
  DEFAULT_LIMITS,
  isUnder,
  MAX_WALL_TIME_MS,
  planSandbox,
  RELAY_PORT,
  SANDBOX_CA_PATH,
  SANDBOX_EGRESS_SOCKET,
  SANDBOX_HOME,
  SANDBOX_RELAY,
  type SandboxHost,
  type SandboxSpec,
  SandboxSpecError,
  sandboxEnv,
  sandboxNoProxy,
  secretsOf,
  TRUST_ENV,
} from "../../src/runner/plan.ts";

const HOST: SandboxHost = {
  bwrap: "/usr/bin/bwrap",
  prlimit: "/usr/bin/prlimit",
  node: "/opt/node/bin/node",
  relay: "/opt/heel/src/runner/relay.ts",
  arch: "x64",
  systemDirs: [
    { path: "/bin", kind: "symlink", target: "usr/bin" },
    { path: "/lib64", kind: "dir" },
  ],
};
const SECCOMP = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const TOKEN = "ghp_planTestCredential0123456789";
const SPEC: SandboxSpec = {
  binary: "/usr/bin/gh",
  args: ["pr", "view", "12"],
  workRoot: "/srv/agents/ci-bot",
  cwd: "/srv/agents/ci-bot/web",
  secretEnv: { GH_TOKEN: TOKEN },
};

function plan(spec: Partial<SandboxSpec>, egressSocket?: string) {
  return planSandbox(HOST, { ...SPEC, ...spec }, SECCOMP, egressSocket);
}

function refusal(spec: Partial<SandboxSpec>, egressSocket?: string): string {
  try {
    plan(spec, egressSocket);
  } catch (error) {
    if (error instanceof SandboxSpecError) return error.message;
    throw error;
  }
  throw new Error("expected the spec to be refused");
}

/** The value after each occurrence of `flag` in the options. */
function valuesAfter(options: readonly string[], flag: string, count = 1): string[][] {
  return options.flatMap((option, i) =>
    option === flag ? [options.slice(i + 1, i + 1 + count)] : [],
  );
}

describe("planSandbox", () => {
  it("I-34: the credential travels over fd 3, never on bwrap's command line", () => {
    const { argv, options, fds } = plan({});
    expect(argv.join("\0")).not.toContain(TOKEN);
    expect(argv.slice(0, 3)).toEqual(["--args", String(ARGS_FD), "--"]);
    expect(valuesAfter(options, "--setenv", 2)).toContainEqual(["GH_TOKEN", TOKEN]);
    const args = fds[0];
    expect(args?.fd).toBe(ARGS_FD);
    expect(args?.kind === "write" ? Buffer.from(args.data).toString("utf8") : "").toBe(
      options.map((option) => `${option}\0`).join(""),
    );
  });

  it("I-30: runs the binary with its argv as given, never through a shell", () => {
    const { argv } = plan({ binary: "/usr/bin/sh", args: ["-c", "gh auth token; echo $GH_TOKEN"] });
    expect(argv.slice(-3)).toEqual(["/usr/bin/sh", "-c", "gh auth token; echo $GH_TOKEN"]);
    // prlimit is the sandbox's first program; the rest of the argv is passed through untouched.
    expect(argv.slice(3, 9)).toEqual([
      HOST.prlimit,
      "--core=0",
      `--data=${DEFAULT_LIMITS.memoryBytes}`,
      `--nproc=${DEFAULT_LIMITS.maxProcesses}`,
      "--",
      "/usr/bin/sh",
    ]);
  });

  it("unshares every namespace, clears the environment and dies with heel", () => {
    const { options } = plan({});
    for (const flag of [
      "--unshare-user",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--unshare-net",
      "--disable-userns",
      "--die-with-parent",
      "--new-session",
      "--clearenv",
    ]) {
      expect(options).toContain(flag);
    }
  });

  it("mounts the work root read-write, the rest of the root read-only, and starts in cwd", () => {
    const { options } = plan({});
    expect(valuesAfter(options, "--bind", 2)).toContainEqual([SPEC.workRoot, SPEC.workRoot]);
    expect(valuesAfter(options, "--remount-ro")).toContainEqual(["/"]);
    expect(valuesAfter(options, "--chdir")).toEqual([[SPEC.cwd]]);
    expect(valuesAfter(options, "--tmpfs")).toContainEqual([SANDBOX_HOME]);
  });

  it("binds a binary outside /usr read-only, and doesn't remount one inside it", () => {
    expect(
      valuesAfter(plan({ binary: "/opt/kubectl/kubectl" }).options, "--ro-bind", 2),
    ).toContainEqual(["/opt/kubectl/kubectl", "/opt/kubectl/kubectl"]);
    expect(valuesAfter(plan({}).options, "--ro-bind", 2)).not.toContainEqual([
      "/usr/bin/gh",
      "/usr/bin/gh",
    ]);
  });

  it("numbers the status, seccomp and file fds after the options fd", () => {
    const result = plan({ files: [{ name: "kubeconfig", content: "apiVersion: v1\n" }] });
    expect(result.fds.map((fd) => [fd.fd, fd.kind])).toEqual([
      [3, "write"],
      [4, "status"],
      [5, "write"],
      [6, "write"],
    ]);
    expect(result.statusFd).toBe(4);
    expect(valuesAfter(result.options, "--json-status-fd")).toEqual([["4"]]);
    expect(valuesAfter(result.options, "--seccomp")).toEqual([["5"]]);
    expect(valuesAfter(result.options, "--ro-bind-data", 2)).toEqual([
      ["6", "/heel/run/kubeconfig"],
    ]);
  });

  it("with egress, runs the relay first and mounts the proxy socket", () => {
    const result = plan(
      { network: { kind: "egress", allow: ["api.github.com"] } },
      "/run/heel/e/egress.sock",
    );
    expect(result.argv).toContain(SANDBOX_RELAY);
    expect(result.argv.slice(result.argv.indexOf(SANDBOX_RELAY) - 1)).toEqual([
      HOST.node,
      SANDBOX_RELAY,
      "--socket",
      SANDBOX_EGRESS_SOCKET,
      "--port",
      String(RELAY_PORT),
      "--",
      "/usr/bin/gh",
      "pr",
      "view",
      "12",
    ]);
    expect(valuesAfter(result.options, "--bind", 2)).toContainEqual([
      "/run/heel/e/egress.sock",
      SANDBOX_EGRESS_SOCKET,
    ]);
  });

  it("merges limits over the spec defaults", () => {
    expect(plan({ limits: { wallTimeMs: 5_000 } }).limits).toEqual({
      ...DEFAULT_LIMITS,
      wallTimeMs: 5_000,
    });
  });

  it("scrubs every credential value, once each", () => {
    expect(plan({ secrets: [TOKEN, "kube-token"] }).secrets).toEqual([TOKEN, "kube-token"]);
  });
});

describe("planSandbox refuses a spec that would weaken the sandbox", () => {
  it("I-34: a binary inside the writable work root, which the agent could swap", () => {
    expect(refusal({ binary: "/srv/agents/ci-bot/bin/gh" })).toMatch(
      /inside the writable work root/,
    );
    expect(refusal({ readOnlyPaths: ["/srv/agents/ci-bot/lib"] })).toMatch(
      /inside the writable work root/,
    );
  });

  it("I-34: prlimit, node or the relay inside the work root", () => {
    expect(() =>
      planSandbox({ ...HOST, prlimit: "/srv/agents/ci-bot/prlimit" }, SPEC, SECCOMP),
    ).toThrow(/inside the writable work root/);
    expect(() =>
      planSandbox(
        { ...HOST, relay: "/srv/agents/ci-bot/relay.ts" },
        { ...SPEC, network: { kind: "egress", allow: ["api.github.com"] } },
        SECCOMP,
        "/run/heel/e/egress.sock",
      ),
    ).toThrow(/inside the writable work root/);
  });

  it.each([
    ["a relative binary", { binary: "gh" }],
    ["a binary path with ..", { binary: "/usr/bin/../bin/gh" }],
    ["a trailing slash", { workRoot: "/srv/agents/ci-bot/" }],
  ])("a path that isn't absolute and normalized: %s", (_name, spec) => {
    expect(refusal(spec)).toMatch(/absolute, normalized path/);
  });

  it.each(["/", "/usr/local/work", "/proc/self", "/heel", "/etc", "/tmp"])(
    "a work root that overlaps a system or sandbox directory: %s",
    (workRoot) => {
      expect(refusal({ workRoot, cwd: workRoot })).toMatch(/overlaps/);
    },
  );

  it("allows a work root below /tmp, which mounts over the sandbox's own tmpfs", () => {
    expect(() => plan({ workRoot: "/tmp/work", cwd: "/tmp/work" })).not.toThrow();
  });

  it("a cwd outside the work root", () => {
    expect(refusal({ cwd: "/srv/agents/other" })).toMatch(/outside the work root/);
    expect(refusal({ cwd: "/srv/agents/ci-bot2" })).toMatch(/outside the work root/);
  });

  it.each(["/proc/1/root", "/etc/passwd", "/tmp", "/heel/run"])(
    "a read-only path heel can't mount safely: %s",
    (path) => {
      expect(refusal({ readOnlyPaths: [path] })).toMatch(/can't be mounted/);
    },
  );

  it.each([
    "PATH",
    "HOME",
    "HTTPS_PROXY",
    "no_proxy",
    "LD_PRELOAD",
    "NODE_OPTIONS",
    "BASH_FUNC_x%%",
  ])("an env name the runner owns or that loads code: %s", (name) => {
    expect(() => plan({ env: { [name]: "x" } })).toThrow(SandboxSpecError);
    expect(() => plan({ secretEnv: { [name]: "x" } })).toThrow(SandboxSpecError);
  });

  it("a variable in both env and secretEnv", () => {
    expect(refusal({ env: { GH_TOKEN: "visible" } })).toMatch(/both env and secretEnv/);
  });

  it("NUL bytes in arguments or env values", () => {
    expect(refusal({ args: ["a\0b"] })).toMatch(/NUL/);
    expect(refusal({ env: { X: "a\0b" } })).toMatch(/NUL/);
  });

  it.each(["../x", ".hidden", "a/b", "egress.sock", ""])("a bad sandbox file name: %j", (name) => {
    expect(refusal({ files: [{ name, content: "" }] })).toMatch(/bad sandbox file name/);
  });

  it("two sandbox files with the same name", () => {
    expect(
      refusal({
        files: [
          { name: "a", content: "" },
          { name: "a", content: "" },
        ],
      }),
    ).toMatch(/duplicate/);
  });

  it("egress with an empty allowlist, or an egress socket that doesn't match the network", () => {
    expect(refusal({ network: { kind: "egress", allow: [] } }, "/run/e.sock")).toMatch(
      /at least one/,
    );
    expect(refusal({ network: { kind: "egress", allow: ["a.example"] } })).toMatch(/egress socket/);
    expect(refusal({}, "/run/e.sock")).toMatch(/egress socket/);
  });

  it.each([
    { wallTimeMs: 0 },
    { memoryBytes: -1 },
    { maxProcesses: 1.5 },
    { maxOutputBytes: Number.NaN },
    { wallTimeMs: MAX_WALL_TIME_MS + 1 },
  ])("a limit that isn't a usable positive integer: %j", (limits) => {
    expect(refusal({ limits })).toMatch(/limit/);
  });
});

describe("sandboxEnv", () => {
  it("is the caller's env plus credentials, with HOME, TMPDIR and PATH set by the runner", () => {
    expect(sandboxEnv({ ...SPEC, env: { GH_PROMPT_DISABLED: "1" } }, false)).toEqual({
      GH_PROMPT_DISABLED: "1",
      GH_TOKEN: TOKEN,
      HOME: SANDBOX_HOME,
      TMPDIR: "/tmp",
      PATH: "/usr/local/bin:/usr/bin:/bin",
    });
  });

  it("points both proxy spellings at the relay only with egress", () => {
    const proxy = `http://127.0.0.1:${RELAY_PORT}`;
    expect(sandboxEnv(SPEC, true)).toMatchObject({
      HTTPS_PROXY: proxy,
      https_proxy: proxy,
      NODE_USE_ENV_PROXY: "1",
      // Node's env proxy would otherwise send the sandbox's own loopback to heel's proxy.
      NO_PROXY: "localhost,127.0.0.1,::1",
      no_proxy: "localhost,127.0.0.1,::1",
    });
  });

  it("leaves an allowlisted loopback address out of NO_PROXY: it's the host's, reached through the proxy", () => {
    const spec = { ...SPEC, network: { kind: "egress", allow: ["127.0.0.1:8443"] } } as const;
    expect(sandboxEnv(spec, true)).toMatchObject({ NO_PROXY: "localhost,::1" });
    expect(sandboxNoProxy(["[::1]:9", "localhost:80", "127.0.0.1"])).toBe("");
    expect(sandboxEnv(SPEC, false)).not.toHaveProperty("HTTPS_PROXY");
  });
});

describe("secretsOf", () => {
  it("collects credential env values and extra secrets, deduplicated, without empties", () => {
    expect(
      secretsOf({ ...SPEC, secretEnv: { A: "one", B: "", C: "one" }, secrets: ["two", "one"] }),
    ).toEqual(["one", "two"]);
  });
});

describe("isUnder", () => {
  it.each([
    ["/a/b", "/a", true],
    ["/a", "/a", true],
    ["/ab", "/a", false],
    ["/anything", "/", true],
  ] as const)("%s under %s is %s", (path, root, expected) => {
    expect(isUnder(path, root)).toBe(expected);
  });
});

describe("credential hosts", () => {
  const PLACEHOLDER = "heel-placeholder-0123456789abcdef0123";
  const TRUST = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
  const injecting = (overrides: Partial<CredentialInjection> = {}): Partial<SandboxSpec> => ({
    secretEnv: {},
    env: { GH_TOKEN: PLACEHOLDER },
    network: {
      kind: "egress",
      allow: ["api.github.com", "github.com", "uploads.github.com"],
      inject: {
        hosts: ["api.github.com", "github.com"],
        auth: { type: "authorization", schemes: ["token"] },
        placeholder: PLACEHOLDER,
        credential: async () => TOKEN,
        ...overrides,
      },
    },
  });
  const planWith = (spec: Partial<SandboxSpec>, trust?: string) =>
    planSandbox(HOST, { ...SPEC, ...spec }, SECCOMP, "/tmp/e/egress.sock", trust);

  it("writes the CA bundle under /heel/run and points every TLS stack at it", () => {
    const planned = planWith(injecting(), TRUST);
    const [bind] = valuesAfter(planned.options, "--ro-bind-data", 2).filter(
      ([, path]) => path === SANDBOX_CA_PATH,
    );
    expect(bind).toBeDefined();
    const fd = planned.fds.find((entry) => entry.fd === Number(bind?.[0]));
    expect(fd?.kind === "write" && Buffer.from(fd.data).toString("utf8")).toBe(TRUST);
    const env = Object.fromEntries(
      valuesAfter(planned.options, "--setenv", 2).map(([name, value]) => [name, value]),
    );
    for (const name of TRUST_ENV) expect(env[name]).toBe(SANDBOX_CA_PATH);
    expect(env["NODE_USE_ENV_PROXY"]).toBe("1");
    expect(env["GH_TOKEN"]).toBe(PLACEHOLDER);
    // The token isn't in anything bwrap is handed.
    expect(planned.options.join("\n")).not.toContain(TOKEN);
  });

  it.each([...TRUST_ENV, "NODE_USE_ENV_PROXY"])("a spec can't set %s itself", (name) => {
    expect(refusal({ env: { [name]: "/work/evil.pem" } })).toMatch(/set by the runner/);
  });

  it("a spec can't write its own ca.pem", () => {
    expect(refusal({ files: [{ name: "ca.pem", content: "x" }] })).toMatch(/bad sandbox file name/);
  });

  it("needs the CA bundle exactly when it has credential hosts", () => {
    expect(() => planWith(injecting())).toThrow(/CA bundle/);
    expect(() =>
      planWith({ network: { kind: "egress", allow: ["api.github.com"] } }, TRUST),
    ).toThrow(/CA bundle/);
  });

  it.each([
    [
      "a credential host outside the egress list",
      injecting({ hosts: ["evil.example"] }),
      /isn't in the egress list/,
    ],
    ["no credential hosts", injecting({ hosts: [] }), /at least one host/],
    [
      "a placeholder heel didn't make",
      injecting({ placeholder: "ghp_lookslikeatoken" }),
      /placeholder/,
    ],
    [
      "the real credential in a variable as well",
      { ...injecting(), secretEnv: { GH_TOKEN: TOKEN }, env: {} },
      /credential variables/,
    ],
  ] as const)("refuses %s", (_, spec, message) => {
    expect(() => planWith(spec, TRUST)).toThrow(message);
  });
});
