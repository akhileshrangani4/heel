import { describe, expect, it, vi } from "vitest";
import { MontyWorker } from "../../src/codemode/monty.ts";
import type { CodeWorker, Step } from "../../src/codemode/worker.ts";
import { addAgent } from "../../src/gateway/agents.ts";
import { SandboxSlots } from "../../src/gateway/sandbox-slots.ts";
import { type McpHarness, mcpHarness } from "../helpers/mcp.ts";

/**
 * How many code-mode scripts may run at once (red-team: 60 parallel
 * `run_code` calls OOM-killed workers and starved `heel run`). Over a limit,
 * `run_code` answers `busy` at once and starts no worker; every way a script
 * can end gives its slot back.
 */

const SEARCH_ALLOWED = `rules:
  - match: { tool: search_notes }
    then: allow
  - match: { tool: delete_note }
    then: ask
`;

type RunBody = { status: string; stdout: string; calls: unknown[]; error: string | null };

/** A worker whose script runs until the test ends it, or its run stops it. */
class HeldWorker implements CodeWorker {
  stopped = 0;
  #end: ((step: Step) => void) | null = null;

  start(): Promise<Step> {
    return new Promise((resolve) => {
      this.#end = resolve;
    });
  }

  finish(step: Step = { kind: "done", output: null }): void {
    this.#end?.(step);
  }

  async stop(): Promise<void> {
    this.stopped += 1;
    this.finish({ kind: "failed", error: "the script was stopped" });
  }
}

function held() {
  const workers: HeldWorker[] = [];
  return {
    workers,
    make: () => {
      const worker = new HeldWorker();
      workers.push(worker);
      return worker;
    },
  };
}

async function runCode(
  h: McpHarness,
  token: string = h.token,
): Promise<{ isError?: boolean; body: RunBody }> {
  const client = await h.connect("/mcp", { token });
  const result = await client.callTool({ name: "run_code", arguments: { code: "1" } });
  return {
    ...(result.isError === undefined ? {} : { isError: result.isError as boolean }),
    body: result.structuredContent as RunBody,
  };
}

function secondAgent(h: McpHarness): string {
  return addAgent(h.t.db, { orgId: h.t.orgId, ownerId: h.t.ownerId, name: "other-bot" }, new Date())
    .token;
}

describe("code mode's concurrency limits", () => {
  it("refuses an agent's script over its own limit with busy, and starts no worker", async () => {
    const slots = new SandboxSlots({ perAgent: 2, total: 10 });
    const w = held();
    const h = await mcpHarness({ owner: SEARCH_ALLOWED, codeWorker: w.make, slots });
    const running = [runCode(h), runCode(h)];
    await vi.waitFor(() => expect(slots.inUse()).toBe(2));

    const third = await runCode(h);
    expect(third.isError).toBe(true);
    expect(third.body.status).toBe("busy");
    expect(third.body.error).toContain("this agent already has 2");
    expect(w.workers).toHaveLength(2);

    for (const worker of w.workers) worker.finish();
    expect((await Promise.all(running)).map((r) => r.body.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(slots.inUse()).toBe(0);
  });

  it("lets another agent run while one agent is at its limit", async () => {
    const slots = new SandboxSlots({ perAgent: 1, total: 10 });
    const w = held();
    const h = await mcpHarness({ owner: SEARCH_ALLOWED, codeWorker: w.make, slots });
    const other = secondAgent(h);
    const first = runCode(h);
    await vi.waitFor(() => expect(slots.inUse()).toBe(1));
    expect((await runCode(h)).body.status).toBe("busy");

    const theirs = runCode(h, other);
    await vi.waitFor(() => expect(slots.inUse()).toBe(2));
    w.workers[1]?.finish();
    expect((await theirs).body.status).toBe("completed");
    w.workers[0]?.finish();
    expect((await first).body.status).toBe("completed");
  });

  it("refuses every agent once the overall limit is reached", async () => {
    const slots = new SandboxSlots({ perAgent: 2, total: 2 });
    const w = held();
    const h = await mcpHarness({ owner: SEARCH_ALLOWED, codeWorker: w.make, slots });
    const running = [runCode(h), runCode(h)];
    await vi.waitFor(() => expect(slots.inUse()).toBe(2));

    const theirs = await runCode(h, secondAgent(h));
    expect(theirs.body.status).toBe("busy");
    expect(theirs.body.error).toContain("heel is already running 2");

    for (const worker of w.workers) worker.finish();
    await Promise.all(running);
    expect(slots.inUse()).toBe(0);
  });

  it.each([
    ["completes", "print('hi')", "completed"],
    ["fails", "raise ValueError('no')", "error"],
    ["stops at an ask", `import notes\nnotes.delete_note(id="n1")`, "pending"],
  ])("frees the slot when a script %s", async (_name, code, status) => {
    const slots = new SandboxSlots({ perAgent: 1, total: 1 });
    const h = await mcpHarness({
      owner: SEARCH_ALLOWED,
      codeWorker: () => new MontyWorker(),
      slots,
    });
    const client = await h.connect("/mcp");
    for (let i = 0; i < 2; i++) {
      const result = await client.callTool({ name: "run_code", arguments: { code } });
      expect((result.structuredContent as RunBody).status).toBe(status);
      expect(slots.inUse()).toBe(0);
    }
  });

  it("frees the slot and stops the worker when the worker throws", async () => {
    const slots = new SandboxSlots({ perAgent: 1, total: 1 });
    const stopped: string[] = [];
    const h = await mcpHarness({
      owner: SEARCH_ALLOWED,
      codeWorker: () => ({
        start: async (): Promise<Step> => ({
          kind: "call",
          module: "notes",
          fn: "search_notes",
          kwargs: { query: "q" },
          positional: 0,
          resume: () => Promise.reject(new Error("the worker crashed")),
          raise: () => Promise.reject(new Error("the worker crashed")),
          park: () => Promise.reject(new Error("the worker crashed")),
        }),
        stop: async () => {
          stopped.push("stop");
        },
      }),
      slots,
    });
    const client = await h.connect("/mcp");
    await expect(client.callTool({ name: "run_code", arguments: { code: "1" } })).rejects.toThrow();
    expect(stopped.length).toBeGreaterThan(0);
    expect(slots.inUse()).toBe(0);
  });

  it("frees the slot when the worker doesn't start", async () => {
    const slots = new SandboxSlots({ perAgent: 1, total: 1 });
    const h = await mcpHarness({
      owner: SEARCH_ALLOWED,
      codeWorker: () => ({
        start: () => Promise.reject(new Error("bwrap failed")),
        stop: async () => {},
      }),
      slots,
    });
    const client = await h.connect("/mcp");
    await expect(client.callTool({ name: "run_code", arguments: { code: "1" } })).rejects.toThrow();
    expect(slots.inUse()).toBe(0);
  });

  it("stops the script and frees the slot when the client hangs up", async () => {
    const slots = new SandboxSlots({ perAgent: 1, total: 1 });
    const w = held();
    const h = await mcpHarness({ owner: SEARCH_ALLOWED, codeWorker: w.make, slots });
    const hangUp = new AbortController();
    const response = h.request("/mcp", {
      method: "POST",
      signal: hangUp.signal,
      headers: {
        authorization: `Bearer ${h.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "run_code", arguments: { code: "1" } },
      }),
    });
    await vi.waitFor(() => expect(slots.inUse()).toBe(1));

    hangUp.abort();
    await response.catch(() => {});
    await vi.waitFor(() => expect(slots.inUse()).toBe(0));
    expect(w.workers[0]?.stopped).toBeGreaterThan(0);
  });
});
