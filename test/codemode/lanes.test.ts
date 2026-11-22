import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { CodemodeHost, CodemodeHostOptions } from "../../src/codemode/hosted.ts";
import { CodemodeHost as Host } from "../../src/codemode/hosted.ts";
import { CodemodeLanes, defaultLanes } from "../../src/codemode/lanes.ts";
import { runScript } from "../../src/codemode/run.ts";
import { accountModule } from "../../src/codemode/stubs.ts";
import type { Pipeline } from "../../src/gateway/pipeline/pipeline.ts";
import type { PipelineResult } from "../../src/gateway/pipeline/ports.ts";

/**
 * Lanes: one code-mode helper per agent, a few at a time. Agents never
 * share a process, an agent's scripts share its lane, and an agent past the
 * cap waits for a lane rather than joining another agent's.
 */

const INSTALL_DIR = fileURLToPath(new URL("../..", import.meta.url));
const MODULE = accountModule("acct", [
  { name: "ok", inputSchema: { type: "object", properties: {} } },
]);
const RULE = { name: null, file: "rules/owner.yaml", line: 1 };
const agent = (agentId: string) => ({
  orgId: "org",
  agentId,
  agentName: agentId,
  ownerId: "usr",
  tokenId: `tok_${agentId}`,
});

/** A pipeline that allows every call, after `delayMs` (time a script spends in heel). */
const pipeline = (delayMs = 0): Pipeline => ({
  async run(): Promise<PipelineResult> {
    await new Promise((r) => setTimeout(r, delayMs));
    return {
      status: "allowed",
      result: { ok: true },
      via: { kind: "rule", rule: RULE, standingApprovalId: null },
    };
  },
});

let lanes: CodemodeLanes | null = null;
const hosts: CodemodeHost[] = [];
afterEach(async () => {
  await lanes?.close();
  lanes = null;
  hosts.length = 0;
});

function makeLanes(options: { maxLanes: number; idleMs?: number }) {
  lanes = new CodemodeLanes({
    installDir: INSTALL_DIR,
    ...options,
    makeHost: (o: CodemodeHostOptions) => {
      const host = new Host(o);
      hosts.push(host);
      return host;
    },
  });
  return lanes;
}

function run(l: CodemodeLanes, agentId: string, code: string, delayMs = 0) {
  if (MODULE === null) throw new Error("no module");
  return runScript({
    code,
    agent: agent(agentId),
    modules: [{ ...MODULE, account: "acct" }],
    pipeline: pipeline(delayMs),
    worker: l.worker(agentId),
    limits: {},
  });
}

/** A script with one call, enough to put its agent on a lane. */
const PID = `import acct\nacct.ok()\n`;

describe("code-mode lanes", () => {
  it("runs futures through an agent's lane and resolves them when awaited (C4)", async () => {
    if (MODULE === null) throw new Error("no module");
    const l = makeLanes({ maxLanes: 2 });
    const limits = {
      maxCalls: 200,
      maxSeconds: 30,
      maxMemory: 256 * 1024 * 1024,
      maxStdout: 1_000_000,
    };
    const worker = l.worker("agt_b");
    const fn = [...MODULE.functions.keys()][0] ?? "";
    let step = await worker.start(
      `import asyncio\nimport acct\nr = await asyncio.gather(acct.${fn}(), acct.${fn}())\nr`,
      [MODULE],
      limits,
      () => {},
    );
    const ids: number[] = [];
    while (step.kind === "call") {
      ids.push(step.callId);
      step = await step.future();
    }
    if (step.kind !== "await") throw new Error(`expected await, got ${step.kind}`);
    const done = await step.resolve(ids.map((callId) => ({ callId, value: callId })));
    await worker.stop();
    expect(done).toEqual({ kind: "done", output: ids });
  }, 60_000);

  it("parks a script and resumes it through an agent's lane (C2)", async () => {
    if (MODULE === null) throw new Error("no module");
    const l = makeLanes({ maxLanes: 2 });
    const limits = {
      maxCalls: 200,
      maxSeconds: 30,
      maxMemory: 256 * 1024 * 1024,
      maxStdout: 1_000_000,
    };
    let printed = "";
    const print = (text: string) => {
      printed += text;
    };
    const first = l.worker("agt_a");
    const fn = [...MODULE.functions.keys()][0] ?? "";
    const step = await first.start(
      `import acct\nprint("before")\nr = acct.${fn}()\nprint("after", r)`,
      [MODULE],
      limits,
      print,
    );
    if (step.kind !== "call") throw new Error(`expected a call, got ${step.kind}`);
    const parked = await step.park();
    await first.stop();
    if (parked.kind !== "parked") throw new Error(`expected parked, got ${JSON.stringify(parked)}`);
    const second = l.worker("agt_a");
    const resumed = await second.start("", [MODULE], limits, print, parked.snapshot);
    if (resumed.kind !== "call") throw new Error(`expected the parked call, got ${resumed.kind}`);
    const done = await resumed.resume("approved");
    await second.stop();
    expect(done.kind).toBe("done");
    expect(printed).toBe("before\nafter approved\n");
  }, 60_000);

  it("sizes the cap from memory: one lane per 2 GB, between 2 and 8", () => {
    expect(defaultLanes(2 ** 30)).toBe(2);
    expect(defaultLanes(16 * 2 ** 30)).toBe(8);
    expect(defaultLanes(64 * 2 ** 30)).toBe(8);
    expect(defaultLanes(10 * 2 ** 30)).toBe(5);
  });

  it("gives two agents two processes, and an agent's scripts one", async () => {
    const l = makeLanes({ maxLanes: 2 });
    const [a1, a2, b] = await Promise.all([
      run(l, "a", PID, 300),
      run(l, "a", PID, 300),
      run(l, "b", PID, 300),
    ]);
    expect([a1.status, a2.status, b.status]).toEqual(["completed", "completed", "completed"]);
    expect(l.agents().sort()).toEqual(["a", "b"]);
    const used = hosts.filter((h) => h.pid !== null);
    // Two lanes, plus the spare kept ready: three processes, never one shared by a and b.
    expect(new Set(used.map((h) => h.pid)).size).toBe(used.length);
  }, 60_000);

  it("makes an agent past the cap wait for a lane, then gives it a fresh process", async () => {
    const l = makeLanes({ maxLanes: 1 });
    const first = run(l, "a", `import acct\nfor i in range(5):\n    acct.ok()`, 150);
    await new Promise((r) => setTimeout(r, 200));
    const aHost = hosts[0];
    const aPid = aHost?.pid;
    const second = run(l, "b", `import acct\nacct.ok()\nprint("b ran")`);
    await new Promise((r) => setTimeout(r, 100));
    expect(l.waiting).toBe(1);
    expect((await first).status).toBe("completed");
    const b = await second;
    expect(b.stdout).toContain("b ran");
    expect(l.agents()).toEqual(["b"]);
    // a's helper was ended, not handed to b.
    expect(aHost?.pid).toBeNull();
    expect(hosts.some((h) => h.pid !== null && h.pid !== aPid)).toBe(true);
  }, 60_000);

  it("closes a lane left idle, and the agent's next script gets a new one", async () => {
    const l = makeLanes({ maxLanes: 2, idleMs: 200 });
    await run(l, "a", PID);
    expect(l.agents()).toEqual(["a"]);
    await new Promise((r) => setTimeout(r, 600));
    expect(l.agents()).toEqual([]);
    const again = await run(l, "a", `print("again")`);
    expect(again.stdout).toContain("again");
  }, 60_000);

  it("stops a script still waiting for a lane, and it never runs", async () => {
    const l = makeLanes({ maxLanes: 1 });
    const busy = run(l, "a", `import acct\nfor i in range(4):\n    acct.ok()`, 150);
    await new Promise((r) => setTimeout(r, 200));
    const worker = l.worker("b");
    const started = worker.start(
      `print("ran")`,
      [],
      {
        maxCalls: 5,
        maxSeconds: 5,
        maxMemory: 64 * 1024 * 1024,
        maxStdout: 1000,
      },
      () => {},
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(l.waiting).toBe(1);
    await worker.stop();
    expect(await started).toEqual({ kind: "failed", error: "the script was stopped" });
    expect(l.waiting).toBe(0);
    expect((await busy).status).toBe("completed");
  }, 60_000);

  it("starts an agent's first script on the spare, without waiting for a process", async () => {
    const l = makeLanes({ maxLanes: 2 });
    await run(l, "a", PID);
    // The spare was made and started as soon as a's lane took the first helper.
    expect(hosts).toHaveLength(2);
    const spare = hosts[1];
    const sparePid = spare?.pid;
    expect(sparePid).not.toBeNull();
    const b = await run(l, "b", `print("quick")`);
    expect(b.stdout).toContain("quick");
    // b ran on that already-running process, and a new spare took its place.
    expect(spare?.pid).toBe(sparePid);
    expect(hosts).toHaveLength(3);
    expect(l.agents().sort()).toEqual(["a", "b"]);
  }, 60_000);
});
