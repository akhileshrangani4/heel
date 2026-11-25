import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  CodemodeHost,
  type HelperExit,
  HostedCodeWorker,
  helperStoppedError,
  startupReason,
} from "../../src/codemode/hosted.ts";
import { runScript } from "../../src/codemode/run.ts";
import { accountModule } from "../../src/codemode/stubs.ts";
import type { Pipeline } from "../../src/gateway/pipeline/pipeline.ts";
import type { CallRequest, PipelineResult } from "../../src/gateway/pipeline/ports.ts";

/**
 * Code mode on the locked-down helper (`heel codemode-host`), where
 * bubblewrap isn't available: scripts run side by side, a stopped script
 * leaves nothing behind for the next, and heel outlives the helper.
 */

const INSTALL_DIR = fileURLToPath(new URL("../..", import.meta.url));
const AGENT = { orgId: "org", agentId: "agt", agentName: "bot", ownerId: "usr", tokenId: "tok" };
const MODULE = accountModule("acct", [
  { name: "ok", inputSchema: { type: "object", properties: {} } },
  { name: "ask", inputSchema: { type: "object", properties: {} } },
  { name: "note", inputSchema: { type: "object", properties: { note: {} } } },
]);
const RULE = { name: null, file: "rules/owner.yaml", line: 1 };

const host = new CodemodeHost({ installDir: INSTALL_DIR });
afterAll(() => host.close());

const LIMITS = {
  maxCalls: 200,
  maxSeconds: 10,
  maxMemory: 256 * 1024 * 1024,
  maxStdout: 1_000_000,
};

/** A helper that is a few lines of Node instead of heel's, with no sandbox around it. */
class FakeHelper extends CodemodeHost {
  readonly #program: string;
  constructor(program: string, exits: HelperExit[]) {
    super({ installDir: INSTALL_DIR, seatbelt: false, onExit: (exit) => exits.push(exit) });
    this.#program = program;
  }
  override command(): { file: string; args: string[] } {
    return { file: process.execPath, args: ["-e", this.#program] };
  }
}

function pipeline(onCall: (tool: string) => void = () => {}): Pipeline {
  return {
    async run(request: CallRequest): Promise<PipelineResult> {
      onCall(request.tool);
      return request.tool === "ask"
        ? { status: "pending", approvalId: "apr_1", rule: RULE }
        : {
            status: "allowed",
            result: { ok: true },
            via: { kind: "rule", rule: RULE, standingApprovalId: null },
          };
    },
  };
}

function run(code: string, p = pipeline()) {
  if (MODULE === null) throw new Error("no module");
  return runScript({
    code,
    agent: AGENT,
    modules: [{ ...MODULE, account: "acct" }],
    pipeline: p,
    worker: new HostedCodeWorker(host),
    limits: {},
  });
}

describe("the code-mode helper", () => {
  it("is locked down: Node's permission model, reads only, no writes, network or child processes", () => {
    const args = host.args();
    expect(args[0]).toBe("--permission");
    expect(args).toContain("--allow-worker");
    expect(args.some((a) => /^--allow-(fs-write|net|child-process|addons|wasi)/.test(a))).toBe(
      false,
    );
    for (const read of args.filter((a) => a.startsWith("--allow-fs-read="))) {
      expect(read).not.toBe("--allow-fs-read=*");
    }
  });

  it("parks a script at a call and resumes it in a fresh worker at that call (C2)", async () => {
    if (MODULE === null) throw new Error("no module");
    const limits = {
      maxCalls: 200,
      maxSeconds: 30,
      maxMemory: 256 * 1024 * 1024,
      maxStdout: 1_000_000,
    };
    let printed = "";
    const first = new HostedCodeWorker(host);
    let step = await first.start(
      'import acct\nacct.ok()\nprint("before")\nr = acct.ask()\nprint("after", r)',
      [MODULE],
      limits,
      (text) => {
        printed += text;
      },
    );
    if (step.kind !== "call") throw new Error(`expected a call, got ${step.kind}`);
    step = await step.resume({ ok: true });
    if (step.kind !== "call" || step.fn !== "ask") throw new Error("expected the ask");
    const parked = await step.park();
    await first.stop();
    if (parked.kind !== "parked") throw new Error(`expected parked, got ${JSON.stringify(parked)}`);

    const second = new HostedCodeWorker(host);
    let resumed = await second.start(
      "",
      [MODULE],
      limits,
      (text) => {
        printed += text;
      },
      parked.snapshot,
    );
    if (resumed.kind !== "call" || resumed.fn !== "ask")
      throw new Error("expected to resume at the ask");
    resumed = await resumed.resume("approved");
    await second.stop();
    expect(resumed.kind).toBe("done");
    expect(printed).toBe("before\nafter approved\n");
  });

  it("runs scripts side by side", async () => {
    const results = await Promise.all(
      [1, 2, 3, 4].map((n) => run(`import acct\nacct.ok()\nprint(${n})`)),
    );
    expect(results.map((r) => r.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
    expect(results.map((r) => r.stdout.trim())).toEqual(["1", "2", "3", "4"]);
  }, 60_000);

  it("leaves nothing of a stopped script for the next one", async () => {
    const first = await run(`import acct\nsecret = "s3cret"\nacct.ask()`);
    expect(first).toMatchObject({ status: "pending", approvalId: "apr_1" });
    const second = await run(`print(secret)`);
    expect(second.status).toBe("error");
    expect(second.stdout).not.toContain("s3cret");
  }, 60_000);

  it("holds a stopped script's slot until its worker is gone: a busy one at its time limit", async () => {
    const worker = new HostedCodeWorker(host);
    const started = Date.now();
    const running = runScript({
      code: "while True:\n    pass",
      agent: AGENT,
      modules: [],
      pipeline: pipeline(),
      worker,
      limits: { maxSeconds: 2 },
    });
    await new Promise((r) => setTimeout(r, 300));
    await worker.stop();
    const held = Date.now() - started;
    // Not cut off mid-turn, and not held past the limit plus Monty's grace.
    expect(held).toBeGreaterThan(1_500);
    expect(held).toBeLessThan(6_000);
    expect((await running).status).toBe("error");
    const next = await run(`import acct\nacct.ok()\nprint("next")`);
    expect(next.stdout).toContain("next");
  }, 60_000);

  it("survives the helper dying mid-call: the script fails, never retried, and the next one runs", async () => {
    const calls: string[] = [];
    const dying = await run(
      `import acct\nacct.ok()\nacct.ok()`,
      pipeline((tool) => {
        calls.push(tool);
        if (calls.length === 1) host.kill();
      }),
    );
    expect(dying.status).toBe("error");
    expect(dying.error).toBe("the code-mode helper stopped; heel's log says why (heel logs)");
    expect(calls).toEqual(["ok"]);
    const next = await run(`import acct\nacct.ok()\nprint("fine")`);
    expect(next).toMatchObject({ status: "completed" });
    expect(next.stdout).toContain("fine");
  }, 60_000);

  it("fails a script whose worker can't start, instead of leaving it waiting", async () => {
    // A helper that may not start worker threads can't make a worker for any script.
    class NoWorkers extends CodemodeHost {
      override args(): string[] {
        return super.args().filter((a) => a !== "--allow-worker");
      }
    }
    const broken = new NoWorkers({ installDir: INSTALL_DIR });
    try {
      const result = await runScript({
        code: `print("never")`,
        agent: AGENT,
        modules: [],
        pipeline: pipeline(),
        worker: new HostedCodeWorker(broken),
        limits: {},
      });
      expect(result.status).toBe("error");
      expect(result.stdout).toBe("");
    } finally {
      await broken.close();
    }
  }, 20_000);

  it("never starts a script that was stopped before it started, as when the client hangs up early", async () => {
    const calls: string[] = [];
    const worker = new HostedCodeWorker(host);
    await worker.stop();
    const result = await runScript({
      code: `import acct\nacct.ok()`,
      agent: AGENT,
      modules: MODULE === null ? [] : [{ ...MODULE, account: "acct" }],
      pipeline: pipeline((tool) => calls.push(tool)),
      worker,
      limits: {},
    });
    expect(result).toMatchObject({ status: "error", error: "the script was stopped" });
    expect(calls).toEqual([]);
  }, 20_000);

  it("refuses an argument too large to send, before it reaches heel, and keeps the helper up", async () => {
    const calls: string[] = [];
    const big = await run(
      `import acct\ns = "a" * 1_000_000\nacct.note(note=s * 20)`,
      pipeline((tool) => calls.push(tool)),
    );
    expect(big.status).toBe("error");
    expect(big.error).toContain("too large");
    expect(calls).toEqual([]);
    // A list of one string repeated is small in Monty but big once sent: refused as it's counted.
    const repeated = await run(`import acct\ns = "a" * 1_000_000\nacct.note(note=[s] * 450)`);
    expect(repeated.status).toBe("error");
    const next = await run(`import acct\nacct.ok()\nprint("up")`);
    expect(next.stdout).toContain("up");
  }, 60_000);

  it("refuses a __proto__ key rather than dropping it", async () => {
    const calls: string[] = [];
    const result = await run(
      `import acct\nacct.note(note={"__proto__": 1})`,
      pipeline((tool) => calls.push(tool)),
    );
    expect(result.status).toBe("error");
    expect(calls).toEqual([]);
  }, 30_000);

  it("hands the script an error, not the result, when a result is too large to send", async () => {
    const huge: Pipeline = {
      async run(): Promise<PipelineResult> {
        return {
          status: "allowed",
          result: { body: "x".repeat(17 * 1024 * 1024) },
          via: { kind: "rule", rule: RULE, standingApprovalId: null },
        };
      },
    };
    const result = await run(
      `import acct\ntry:\n    acct.ok()\nexcept RuntimeError as e:\n    print("caught", e)`,
      huge,
    );
    expect(result.stdout).toContain("too large");
  }, 60_000);

  it("tells the script why a helper that couldn't start stopped, from its stderr", async () => {
    // Node's own words when the sandbox keeps it from its OpenSSL config.
    const stderr =
      "/opt/homebrew/bin/node: OpenSSL configuration error:\n" +
      "80:error:80000001:system library:BIO_new_file:Operation not permitted:crypto/bio/bss_file.c:73:calling fopen(/opt/homebrew/etc/openssl@4/openssl.cnf, rb)\n\n";
    const exits: HelperExit[] = [];
    const dead = new FakeHelper(
      `process.stderr.write(${JSON.stringify(stderr)}, () => process.exit(1));`,
      exits,
    );
    try {
      const step = await new HostedCodeWorker(dead).start("1 + 1", [], LIMITS, () => {});
      expect(step).toEqual({
        kind: "failed",
        error:
          "the code-mode helper couldn't start: /opt/homebrew/bin/node: OpenSSL configuration error: " +
          "80:error:80000001:system library:BIO_new_file:Operation not permitted:crypto/bio/bss_file.c:73:" +
          "calling fopen(/opt/homebrew/etc/openssl@4/openssl.cnf, rb) (more in heel's log: heel logs)",
      });
      expect(exits[0]?.detail).toContain("OpenSSL configuration error");
    } finally {
      await dead.close();
    }
  }, 20_000);

  it("keeps what a helper wrote to stderr after it answered out of the script's error, in the log only", async () => {
    const exits: HelperExit[] = [];
    // Answers the script once, then writes something private to stderr and dies.
    const answered = new FakeHelper(
      `process.stdin.once("data", (line) => {
        const id = JSON.parse(String(line).split("\\n")[0]).id;
        process.stdout.write(JSON.stringify({ id, type: "stdout", text: "hi" }) + "\\n", () =>
          process.stderr.write("password=hunter2\\n", () => process.exit(1)));
      });`,
      exits,
    );
    try {
      let printed = "";
      const step = await new HostedCodeWorker(answered).start("1 + 1", [], LIMITS, (text) => {
        printed += text;
      });
      expect(printed).toBe("hi");
      expect(step).toEqual({
        kind: "failed",
        error: "the code-mode helper stopped; heel's log says why (heel logs)",
      });
      expect(JSON.stringify(step)).not.toContain("hunter2");
      expect(exits[0]?.detail).toContain("password=hunter2");
    } finally {
      await answered.close();
    }
  }, 20_000);

  it("won't widen what the helper may read when heel's path holds a wildcard", () => {
    const starred = new CodemodeHost({ installDir: "/opt/he*el" });
    expect(() => starred.args()).toThrow(/\*/);
  });
});

describe("why a helper stopped, as the script hears it", () => {
  it("is the line Node wrote, with the line after it when the first ends in a colon", () => {
    expect(startupReason("node: bad option: --nope\n")).toBe("node: bad option: --nope");
    expect(
      startupReason("\n  node: OpenSSL configuration error:\n  80:error:fopen(/x, rb)\n\n"),
    ).toBe("node: OpenSSL configuration error: 80:error:fopen(/x, rb)");
    expect(startupReason("spawn /usr/bin/sandbox-exec ENOENT")).toBe(
      "spawn /usr/bin/sandbox-exec ENOENT",
    );
  });

  it("is cut short, and nothing when the helper wrote nothing", () => {
    const long = startupReason(`node: ${"x".repeat(1000)}\nsecond line`);
    expect(long?.length).toBe(300);
    expect(long?.endsWith("…")).toBe(true);
    expect(startupReason("")).toBeNull();
    expect(startupReason("\n \n")).toBeNull();
  });

  it("carries stderr only from a helper that never answered; after that, it points to the log", () => {
    expect(helperStoppedError(false, "node: bad option: --nope")).toBe(
      "the code-mode helper couldn't start: node: bad option: --nope (more in heel's log: heel logs)",
    );
    expect(helperStoppedError(true, "token=abc123")).toBe(
      "the code-mode helper stopped; heel's log says why (heel logs)",
    );
    expect(helperStoppedError(false, "")).toBe(
      "the code-mode helper stopped; heel's log says why (heel logs)",
    );
  });
});
