import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { lineReader, parseFromWorker } from "../../src/codemode/protocol.ts";
import { SandboxedCodeWorker } from "../../src/codemode/sandboxed.ts";
import { plainValue } from "../../src/codemode/values.ts";
import { DEFAULT_LIMITS } from "../../src/codemode/worker.ts";
import type { SandboxHost, SandboxOutcome } from "../../src/runner/index.ts";

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
      step: { kind: "call", module: "m", fn: "f", kwargs: {}, positional: 0, ...step },
    });

  it("accepts a well-formed call", () => {
    expect(call({ kwargs: { a: 1 } })).toEqual({
      type: "step",
      step: { kind: "call", module: "m", fn: "f", kwargs: { a: 1 }, positional: 0 },
    });
  });

  it.each([
    ["null kwargs", { kwargs: null }],
    ["string kwargs", { kwargs: "str" }],
    ["array kwargs", { kwargs: [1, 2] }],
    ["an own __proto__ key", { kwargs: JSON.parse('{"__proto__": {"x": 1}}') }],
    ["a string positional", { positional: "1" }],
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
      `${JSON.stringify({ type: "step", step: { kind: "call", module: "m", fn: "f", kwargs: {}, positional: 0 } })}\n`,
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
