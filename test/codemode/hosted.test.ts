import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { CodemodeHost, HostedCodeWorker } from "../../src/codemode/hosted.ts";
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

  it("won't widen what the helper may read when heel's path holds a wildcard", () => {
    const starred = new CodemodeHost({ installDir: "/opt/he*el" });
    expect(() => starred.args()).toThrow(/\*/);
  });
});
