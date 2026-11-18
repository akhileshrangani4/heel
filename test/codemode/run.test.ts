import { describe, expect, it } from "vitest";
import { MontyWorker } from "../../src/codemode/monty.ts";
import { runScript } from "../../src/codemode/run.ts";
import { accountModule, moduleName, pythonType } from "../../src/codemode/stubs.ts";
import { oneRule, pipelineHarness } from "../helpers/pipeline.ts";

/**
 * Code mode's run loop (D6a) with real Monty in-process driving the real
 * pipeline (fake provider). D6b moves Monty into a sandboxed worker.
 */

const TOOLS = [
  {
    name: "send",
    description: "Send mail.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string" },
        recipients: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
      },
      required: ["action"],
    },
  },
  {
    name: "trash",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string" }, items: { type: "integer" } },
      required: ["action"],
    },
  },
];

function setUp(owner: string) {
  const h = pipelineHarness({ owner });
  const module = accountModule("gmail-work", TOOLS);
  if (module === null) throw new Error("no module");
  const run = (code: string, runId?: string, limits = {}) =>
    runScript({
      code,
      agent: h.agent,
      runId,
      modules: [{ ...module, account: "gmail-work" }],
      pipeline: h.pipeline,
      worker: new MontyWorker(),
      limits,
    });
  return { h, run };
}

const SEND = `gmail_work.send(action="email.send", recipients=["bob@vendor.com"], subject="Q3")`;

describe("stubs", () => {
  it("name modules after the alias and type keyword-only parameters", () => {
    expect(moduleName("gmail-work")).toBe("gmail_work");
    expect(pythonType({ type: "array", items: { type: "string" } })).toBe("list[str]");
    expect(pythonType({ enum: ["a", "b"] })).toBe('Literal["a", "b"]');
    const module = accountModule("notes", [
      {
        name: "create-page",
        inputSchema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        },
      },
      { name: "create_page", inputSchema: { type: "object" } },
      { name: "class", inputSchema: { type: "object" } },
    ]);
    expect(module?.stubs).toContain("def create_page(*, title: str) -> Any:");
    expect(module?.skipped.map((s) => s.tool)).toEqual(["create_page", "class"]);
  });
});

describe("running a script", () => {
  it("resumes an allowed call with its result", async () => {
    const { run } = setUp(oneRule("{ action: email.send }"));
    const result = await run(`import gmail_work\nr = ${SEND}\nprint(r)`);
    expect(result).toMatchObject({
      status: "completed",
      calls: [{ tool: "send", decision: "allow" }],
    });
    expect(result.stdout).toContain("send");
  });

  it("raises a denial at the call, as a PermissionError the script may catch", async () => {
    const { run } = setUp(oneRule("{ action: email.send }", "deny"));
    const result = await run(
      `import gmail_work\ntry:\n    ${SEND}\nexcept PermissionError as e:\n    print("denied:", e)\nprint("went on")`,
    );
    expect(result).toMatchObject({ status: "completed", calls: [{ decision: "deny" }] });
    expect(result.stdout).toContain("denied: heel denied send on gmail-work");
    expect(result.stdout).toContain("went on");
  });

  it("I-59: an ask stops the script for good; try/except can't swallow it", async () => {
    const { h, run } = setUp(oneRule("{ action: email.send }", "ask"));
    const result = await run(
      `import gmail_work\ntry:\n    ${SEND}\nexcept BaseException:\n    print("caught")\nprint("after")\n${SEND.replace("Q3", "Q4")}`,
    );
    expect(result).toMatchObject({ status: "pending", approvalId: expect.any(String) });
    expect(result.stdout).not.toContain("caught");
    expect(result.stdout).not.toContain("after");
    expect(h.provider.executed).toEqual([]);
  });

  it("I-62: a pause stops the script at its next call", async () => {
    const { h, run } = setUp(oneRule("{ action: email.send }"));
    h.pauses.paused.global = true;
    const result = await run(`import gmail_work\n${SEND}\nprint("after")`);
    expect(result).toMatchObject({ status: "paused", calls: [{ decision: "paused" }] });
    expect(result.stdout).not.toContain("after");
  });

  it("I-27: each call is checked and counted on its own, so a loop meets the same limits", async () => {
    const { h, run } = setUp(`rules:
  - match: { action: email.remove, items: { over: 2, per: run } }
    then: deny
  - match: { action: email.remove }
    then: allow
`);
    const result = await run(
      `import gmail_work\nfor i in range(3):\n    try:\n        gmail_work.trash(action="email.remove")\n    except PermissionError:\n        print("stopped at", i)`,
      "run-1",
    );
    expect(result.calls.map((c) => c.decision)).toEqual(["allow", "allow", "deny"]);
    expect(result.stdout).toContain("stopped at 2");
    expect(h.provider.executed).toHaveLength(2);
  });

  it("type-checks against the stubs before any call runs", async () => {
    const { h, run } = setUp(oneRule("{ action: email.send }"));
    const result = await run(`import gmail_work\ngmail_work.send(action=3)`);
    expect(result).toMatchObject({ status: "error", calls: [] });
    expect(h.provider.executed).toEqual([]);
  });

  it("stops a script past its call limit", async () => {
    const { run } = setUp(oneRule("{ action: email.send }"));
    const result = await run(`import gmail_work\nfor i in range(5):\n    ${SEND}`, undefined, {
      maxCalls: 2,
    });
    expect(result.status).toBe("error");
    expect(result.calls).toHaveLength(2);
  });

  it("refuses the environment and files", async () => {
    const { run } = setUp(oneRule("{ action: email.send }"));
    const env = await run(`import os\nos.getenv("HOME")`);
    expect(env.status).toBe("error");
  });
});
