import { createMcpHandler, Server } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { cappedFetch } from "../../src/definitions/mcp/capped-fetch.ts";
import { UpstreamPool } from "../../src/definitions/mcp/upstream.ts";
import { UpstreamError } from "../../src/gateway/pipeline/ports.ts";
import { findAccount } from "../../src/store/directory.ts";
import { connectAccount } from "../../src/vault/connect.ts";
import { captureLogger } from "../helpers/log.ts";
import { testStore } from "../helpers/store.ts";

/**
 * Red-team round 3: a remote MCP server could answer with any amount, and
 * heel read it all into memory; a local server stops at 10 MB.
 */

const URL_ = "http://localhost:9/mcp";

function server(size: number) {
  const handler = createMcpHandler(() => {
    const s = new Server({ name: "big", version: "1.0.0" }, { capabilities: { tools: {} } });
    s.setRequestHandler("tools/list", async () => ({
      tools: [{ name: "dump", inputSchema: { type: "object", properties: {} } }],
    }));
    s.setRequestHandler("tools/call", async () => ({
      content: [{ type: "text", text: "x".repeat(size) }],
    }));
    return s;
  });
  return async (input: string | URL | Request, init?: RequestInit) =>
    handler.fetch(new Request(input, init));
}

function setUp(size: number) {
  const t = testStore();
  connectAccount(
    t.db,
    null,
    { orgId: t.orgId, ownerId: t.ownerId, provider: "mcp", alias: "big", url: URL_ },
    new Date(),
  );
  const account = findAccount(t.db, t.orgId, "big");
  if (account === null) throw new Error("no account");
  const pool = new UpstreamPool({ vault: null, log: captureLogger().logger, fetch: server(size) });
  return { account, pool };
}

describe("a remote MCP server's replies", () => {
  it("are read up to 10 MB a message", async () => {
    const { account, pool } = setUp(1024);
    const result = await pool.callTool(account, "dump", {}, AbortSignal.timeout(10_000));
    expect(JSON.stringify(result)).toContain("x".repeat(1024));
    await pool.close();
  });

  it("past 10 MB are withheld with a 502 that says why", async () => {
    const { account, pool } = setUp(11 * 1024 * 1024);
    const error = await pool.callTool(account, "dump", {}, AbortSignal.timeout(20_000)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).status).toBe(502);
    expect(JSON.stringify((error as UpstreamError).body)).toContain("more than 10 MB");
    await pool.close();
  });
});

describe("cappedFetch", () => {
  const body = (chunks: string[], type: string) => async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
          controller.close();
        },
      }),
      { headers: { "content-type": type } },
    );

  it("limits each event of a stream, not the stream's whole life", async () => {
    const event = `data: ${"y".repeat(40)}\n\n`;
    const capped = cappedFetch(body(Array(10).fill(event), "text/event-stream"), 64);
    const text = await (await capped.fetch("http://x")).text();
    expect(text).toHaveLength(event.length * 10);
    expect(capped.failure).toBeNull();
  });

  it("stops one event that runs past the limit, even across chunks", async () => {
    const capped = cappedFetch(
      body(["data: ", "z".repeat(50), "z".repeat(50)], "text/event-stream"),
      64,
    );
    await expect((await capped.fetch("http://x")).text()).rejects.toThrow(/larger than 64 bytes/);
    expect(capped.failure?.maxBytes).toBe(64);
  });

  it("limits a JSON reply as a whole", async () => {
    const capped = cappedFetch(body(["{", "a".repeat(100), "}"], "application/json"), 64);
    await expect((await capped.fetch("http://x")).text()).rejects.toThrow(/larger than 64 bytes/);
  });
});
