/**
 * The code-mode escape corpus (D6b; spec: D6 acceptance, STK §11.3). Each
 * script runs in a real `heel codemode-worker` under bubblewrap and tries to
 * reach something it mustn't: files, sockets, the environment, `eval`
 * tricks, memory and loop bombs, too many host calls, and a `try/except`
 * around an ask. Every one must fail safely, and the worker must never get
 * past heel.
 *
 * Locally the suite skips when this host can't run a sandbox. CI sets
 * HEEL_REQUIRE_SANDBOX, so there a skip is a failure.
 */
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { CodemodeHost, HostedCodeWorker } from "../../src/codemode/hosted.ts";
import { MontyWorker } from "../../src/codemode/monty.ts";
import { runScript, type ScriptResult } from "../../src/codemode/run.ts";
import { SandboxedCodeWorker } from "../../src/codemode/sandboxed.ts";
import { accountModule } from "../../src/codemode/stubs.ts";
import type { CodeWorker } from "../../src/codemode/worker.ts";
import type { Pipeline } from "../../src/gateway/pipeline/pipeline.ts";
import type { CallRequest, PipelineResult } from "../../src/gateway/pipeline/ports.ts";
import { probeSandbox } from "../../src/runner/index.ts";

const probe = await probeSandbox();
if (!probe.ok && process.env["HEEL_REQUIRE_SANDBOX"] === "1") {
  throw new Error(`HEEL_REQUIRE_SANDBOX is set but the sandbox is unavailable: ${probe.detail}`);
}
const INSTALL_DIR = fileURLToPath(new URL("../..", import.meta.url));

const AGENT = { orgId: "org", agentId: "agt", agentName: "bot", ownerId: "usr", tokenId: "tok" };
const MODULE = accountModule("acct", [
  { name: "ok", inputSchema: { type: "object", properties: {} } },
  { name: "ask", inputSchema: { type: "object", properties: {} } },
]);

const RULE = { name: null, file: "rules/owner.yaml", line: 1 };

/** A pipeline that allows `ok` and asks about `ask`, recording what reached it. */
function fakePipeline(seen: string[]): Pipeline {
  return {
    async run(request: CallRequest): Promise<PipelineResult> {
      seen.push(request.tool);
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

const HOST = new CodemodeHost({ installDir: INSTALL_DIR });
afterAll(() => HOST.close());

const WORKERS: [string, boolean, () => CodeWorker][] = [
  [
    "under bubblewrap",
    probe.ok,
    () => {
      if (!probe.ok) throw new Error("no sandbox");
      return new SandboxedCodeWorker({ host: probe.host, installDir: INSTALL_DIR });
    },
  ],
  ["in WebAssembly", true, () => new MontyWorker("wasm")],
  ["in the locked-down helper", true, () => new HostedCodeWorker(HOST)],
];

for (const [where, available, makeWorker] of WORKERS) {
  async function run(code: string, limits = {}): Promise<{ result: ScriptResult; seen: string[] }> {
    if (MODULE === null) throw new Error("no module");
    const seen: string[] = [];
    const result = await runScript({
      code,
      agent: AGENT,
      modules: [{ ...MODULE, account: "acct" }],
      pipeline: fakePipeline(seen),
      worker: makeWorker(),
      limits,
    });
    return { result, seen };
  }

  describe.skipIf(!available)(`code mode ${where}`, () => {
    it("runs a script and relays an allowed call", async () => {
      const { result, seen } = await run(`import acct\nprint(acct.ok())`);
      expect(result).toMatchObject({ status: "completed" });
      expect(result.stdout).toContain("'ok': True");
      expect(seen).toEqual(["ok"]);
    }, 60_000);

    it.each([
      ["read a file", `open("/etc/passwd").read()`],
      ["open a socket", `import socket\nsocket.socket()`],
      ["read the environment", `import os\nos.environ["HOME"]`],
      ["eval its way out", `eval("__import__('os').system('id')")`],
      ["exec its way out", `exec("import subprocess")`],
      ["import subprocess", `import subprocess\nsubprocess.run(["id"])`],
    ])(
      "can't %s",
      async (_, code) => {
        const { result, seen } = await run(code);
        expect(result.status).toBe("error");
        expect(seen).toEqual([]);
      },
      60_000,
    );

    it("can't exhaust memory", async () => {
      const { result } = await run(`x = [0] * (10 ** 9)\nlen(x)`, { maxMemory: 64 * 1024 * 1024 });
      expect(result.status).toBe("error");
    }, 60_000);

    it("can't run forever", async () => {
      const { result } = await run(`while True:\n    pass`, { maxSeconds: 2 });
      expect(result.status).toBe("error");
    }, 60_000);

    it("can't make more host calls than its limit", async () => {
      const { result, seen } = await run(`import acct\nfor i in range(10):\n    acct.ok()`, {
        maxCalls: 3,
      });
      expect(result.status).toBe("error");
      expect(seen).toHaveLength(3);
    }, 60_000);

    it("I-59: can't swallow an ask with try/except", async () => {
      const { result } = await run(
        `import acct\ntry:\n    acct.ask()\nexcept BaseException:\n    print("caught")\nprint("after")`,
      );
      expect(result).toMatchObject({ status: "pending", approvalId: "apr_1" });
      expect(result.stdout).not.toContain("caught");
      expect(result.stdout).not.toContain("after");
    }, 60_000);
  });
}
