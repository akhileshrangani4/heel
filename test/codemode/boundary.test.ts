import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lineReader, parseFromWorker } from "../../src/codemode/protocol.ts";
import { runScript } from "../../src/codemode/run.ts";
import { SandboxedCodeWorker } from "../../src/codemode/sandboxed.ts";
import { accountModule } from "../../src/codemode/stubs.ts";
import { plainValue } from "../../src/codemode/values.ts";
import { DEFAULT_LIMITS } from "../../src/codemode/worker.ts";
import type { Pipeline } from "../../src/gateway/pipeline/pipeline.ts";
import type { SandboxHost, SandboxOutcome, SandboxProcess } from "../../src/runner/index.ts";

/** The worker boundary (D6b): what crosses it, checked, and a worker that dies mid-call. */

describe("Python values leaving Monty", () => {
  it("turns nested dicts into objects, so no argument is lost", () => {
    const kwargs = new Map<string, unknown>([
      ["s", "x"],
      ["data", new Map([["a", new Map([["b", 1n]])]])],
      ["list", [new Map([["c", true]])]],
    ]);
    expect(plainValue(kwargs, "argument")).toEqual({
      s: "x",
      data: { a: { b: 1 } },
      list: [{ c: true }],
    });
  });

  it("refuses a dict key that isn't a string, and an int too large to send", () => {
    expect(() => plainValue(new Map([[1, "a"]]), "argument")).toThrow(/key/);
    expect(() => plainValue({ n: 2n ** 70n }, "argument")).toThrow(/too large/);
  });

  it("shows a large int in output as a string instead of failing the script", () => {
    expect(plainValue(2n ** 70n, "output")).toBe("1180591620717411303424");
  });
});

describe("messages from the worker", () => {
  const call = (step: Record<string, unknown>) =>
    parseFromWorker({
      type: "step",
      step: { kind: "call", module: "m", fn: "f", kwargs: {}, positional: 0, callId: 1, ...step },
    });

  it("accepts a well-formed call", () => {
    expect(call({ kwargs: { a: 1 } })).toEqual({
      type: "step",
      step: { kind: "call", module: "m", fn: "f", kwargs: { a: 1 }, positional: 0, callId: 1 },
    });
  });

  it.each([
    ["null kwargs", { kwargs: null }],
    ["string kwargs", { kwargs: "str" }],
    ["array kwargs", { kwargs: [1, 2] }],
    ["an own __proto__ key", { kwargs: JSON.parse('{"__proto__": {"x": 1}}') }],
    ["a string positional", { positional: "1" }],
    ["a negative call id", { callId: -1 }],
    ["a string call id", { callId: "1" }],
    ["a numeric module", { module: 1 }],
  ])("refuses %s", (_label, step) => {
    expect(call(step)).toBeNull();
  });

  it("refuses stdout that isn't a string", () => {
    expect(parseFromWorker({ type: "stdout", text: ["a"] })).toBeNull();
  });

  it("keeps a character split across two chunks whole", () => {
    const seen: unknown[] = [];
    const read = lineReader((m) => seen.push(m));
    const bytes = Buffer.from(`${JSON.stringify({ text: "€€" })}\n`);
    const cut = bytes.indexOf(Buffer.from("€")) + 1;
    read(bytes.subarray(0, cut));
    read(bytes.subarray(cut));
    expect(seen).toEqual([{ text: "€€" }]);
  });
});

describe("the sandboxed worker", () => {
  const host = { node: "/usr/bin/node" } as SandboxHost;

  function fakeSandbox() {
    const stdout = new PassThrough();
    let end: (outcome: SandboxOutcome) => void = () => {};
    const done = new Promise<SandboxOutcome>((resolve) => {
      end = resolve;
    });
    const process = {
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
      done,
      kill: () => end({ kind: "aborted" }),
    };
    return { process, stdout, end: (o: SandboxOutcome) => end(o) };
  }

  it("fails the next step at once when the worker ended while heel was in the pipeline", async () => {
    const fake = fakeSandbox();
    const worker = new SandboxedCodeWorker({
      host,
      installDir: "/opt/heel",
      start: async () => fake.process,
    });
    const started = worker.start("code", [], DEFAULT_LIMITS, () => {});
    fake.stdout.write(
      `${JSON.stringify({ type: "step", step: { kind: "call", module: "m", fn: "f", kwargs: {}, positional: 0, callId: 1 } })}\n`,
    );
    const step = await started;
    expect(step.kind).toBe("call");
    // The worker dies while heel is "in the pipeline": nobody is waiting on a step.
    fake.end({ kind: "limit", limit: "time" });
    await fake.process.done;
    if (step.kind !== "call") throw new Error("expected a call");
    const next = await step.resume({ ok: true });
    expect(next).toEqual({ kind: "failed", error: "the script passed its time limit" });
    await worker.stop();
  });

  it("fails the step heel is waiting on when it's stopped from outside, as on a hang-up", async () => {
    const fake = fakeSandbox();
    const worker = new SandboxedCodeWorker({
      host,
      installDir: "/opt/heel",
      start: async () => fake.process,
    });
    // The script never answers: the step stays awaited until the worker is stopped.
    const started = worker.start("code", [], DEFAULT_LIMITS, () => {});
    await new Promise((resolve) => setImmediate(resolve));
    await worker.stop();
    expect(await started).toEqual({ kind: "failed", error: "the script was stopped" });
  });

  it("removes its work directory when the sandbox doesn't start", async () => {
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith("heel-codemode-")).length;
    const worker = new SandboxedCodeWorker({
      host,
      installDir: "/opt/heel",
      start: async () => {
        throw new Error("bwrap refused");
      },
    });
    await expect(worker.start("code", [], DEFAULT_LIMITS, () => {})).rejects.toThrow("bwrap");
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith("heel-codemode-")).length;
    expect(after).toBe(before);
  });
});

/**
 * `heel codemode-worker` itself, started as a plain process: bubblewrap only
 * runs on Linux, and the worker's side of the protocol should be checked on
 * every OS. The escape corpus covers the sandbox around it.
 */
describe("the worker process, without its sandbox", () => {
  const INSTALL_DIR = fileURLToPath(new URL("../..", import.meta.url));
  const AGENT = { orgId: "org", agentId: "agt", agentName: "bot", ownerId: "usr", tokenId: "tok" };
  const MODULE = accountModule("acct", [
    { name: "ok", inputSchema: { type: "object", properties: {} } },
  ]);
  const allowAll: Pipeline = {
    run: async () => ({
      status: "allowed",
      result: { ok: true },
      via: {
        kind: "rule",
        rule: { name: null, file: "rules/owner.yaml", line: 1 },
        standingApprovalId: null,
      },
    }),
  };

  function unsandboxed() {
    return new SandboxedCodeWorker({
      host: { node: process.execPath } as SandboxHost,
      installDir: INSTALL_DIR,
      start: async (_host, spec): Promise<SandboxProcess> => {
        const child = spawn(spec.binary, spec.args, { stdio: ["pipe", "pipe", "pipe"] });
        const done = new Promise<SandboxOutcome>((resolve) => {
          child.once("exit", (code) => resolve({ kind: "exited", code: code ?? 137 }));
        });
        return {
          stdin: child.stdin,
          stdout: child.stdout,
          stderr: child.stderr,
          done,
          kill: () => void child.kill("SIGKILL"),
        };
      },
    });
  }

  function run(code: string, limits = {}) {
    if (MODULE === null) throw new Error("no module");
    return runScript({
      code,
      agent: AGENT,
      modules: [{ ...MODULE, account: "acct" }],
      pipeline: allowAll,
      worker: unsandboxed(),
      limits,
    });
  }

  it("runs a script, relays its call to heel and resumes it with the result", async () => {
    const result = await run(`import acct\nprint("before")\nr = acct.ok()\nprint(r["ok"])\n7`);
    expect(result).toMatchObject({ status: "completed", output: 7, error: null });
    expect(result.stdout).toBe("before\nTrue\n");
    expect(result.calls).toEqual([{ account: "acct", tool: "ok", decision: "allow" }]);
  }, 60_000);

  it("drops stdout past the script's limit", async () => {
    const result = await run(`print("abcdefghij")\nprint("more")`, { maxStdout: 4 });
    expect(result.status).toBe("completed");
    expect(result.stdout).toBe("abcd");
  }, 60_000);
});
