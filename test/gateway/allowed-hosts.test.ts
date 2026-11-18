import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { requireServedHost } from "../../src/gateway/allowed-hosts.ts";

/** DNS-rebinding protection on the agent plane: only hosts heel serves get an answer. */

function app() {
  const hono = new Hono();
  hono.use("*", requireServedHost(["heel.internal", "agents.example.com"]));
  hono.get("*", (c) => c.text("ok"));
  return hono;
}

describe("served hosts", () => {
  it.each([
    "http://localhost:7300/mcp",
    "http://127.0.0.1:7300/mcp",
    "http://[::1]:7300/mcp",
    "http://heel.internal:7300/mcp",
    "https://agents.example.com/mcp",
  ])("answers %s", async (url) => {
    expect((await app().request(url)).status).toBe(200);
  });

  it("refuses a host it doesn't serve, as a rebound page would send", async () => {
    expect((await app().request("http://evil.example.com:7300/mcp")).status).toBe(403);
  });

  it("refuses a browser Origin it doesn't serve, even on a served host", async () => {
    const response = await app().request("http://127.0.0.1:7300/mcp", {
      headers: { origin: "http://evil.example.com" },
    });
    expect(response.status).toBe(403);
    const allowed = await app().request("http://127.0.0.1:7300/mcp", {
      headers: { origin: "http://localhost:7300" },
    });
    expect(allowed.status).toBe(200);
  });
});
