import { describe, expect, it } from "vitest";
import { MontyWorker } from "../../src/codemode/monty.ts";
import { mcpHarness } from "../helpers/mcp.ts";

/**
 * Code mode on bare /mcp (D6b): `run_code`, `heel_stubs` and `heel_status`,
 * with Monty in-process standing in for the sandboxed worker (the worker
 * under bubblewrap is covered by e2e/codemode).
 */

const SEARCH_ALLOWED = `rules:
  - match: { tool: search_notes }
    then: allow
  - match: { tool: delete_note }
    then: ask
`;

describe("code mode over MCP", () => {
  it("lists run_code, heel_stubs and heel's own tools, and nothing else", async () => {
    const h = await mcpHarness({ owner: SEARCH_ALLOWED, codeWorker: () => new MontyWorker() });
    const client = await h.connect("/mcp");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "run_code",
      "heel_stubs",
      "heel_status",
      "heel_propose_rules",
    ]);
  });

  it("serves each account as a module, with its tools' stubs", async () => {
    const h = await mcpHarness({ owner: SEARCH_ALLOWED, codeWorker: () => new MontyWorker() });
    const client = await h.connect("/mcp");
    const result = await client.callTool({ name: "heel_stubs", arguments: {} });
    const text = (result.content as { text: string }[])[0]?.text ?? "";
    expect(text).toContain("# notes.pyi");
    expect(text).toContain("def search_notes(*, query: str = ...) -> Any:");
  });

  it("runs a script; an ask stops it and returns the approval id with what ran", async () => {
    const h = await mcpHarness({ owner: SEARCH_ALLOWED, codeWorker: () => new MontyWorker() });
    const client = await h.connect("/mcp");
    const result = await client.callTool({
      name: "run_code",
      arguments: {
        code: `import notes\nprint(notes.search_notes(query="q3"))\nnotes.delete_note(id="n1")\nprint("after")`,
      },
    });
    const body = result.structuredContent as {
      status: string;
      approvalId?: string;
      stdout: string;
      calls: { tool: string; decision: string }[];
    };
    expect(body.status).toBe("pending");
    expect(body.approvalId).toEqual(expect.any(String));
    expect(body.calls.map((c) => [c.tool, c.decision])).toEqual([
      ["search_notes", "allow"],
      ["delete_note", "ask"],
    ]);
    expect(body.stdout).not.toContain("after");
    expect(h.upstream.calls.map((c) => c.name)).toEqual(["search_notes"]);
  });

  it("says code mode needs the sandbox when there's no worker", async () => {
    const h = await mcpHarness({ owner: SEARCH_ALLOWED });
    const response = await h.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(501);
    expect(await response.text()).toContain("needs the sandbox");
  });
});
