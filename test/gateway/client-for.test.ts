import { describe, expect, it } from "vitest";
import { clientFor } from "../../src/gateway/pipeline/pipeline.ts";

/** T9: the client an approval names is the one this call came through. */
describe("clientFor", () => {
  it("records the MCP client only for MCP and code-mode calls", () => {
    expect(clientFor("mcp", "claude-code")).toBe("claude-code");
    expect(clientFor("code", "claude-code")).toBe("claude-code");
    expect(clientFor("mcp", null)).toBeNull();
    // The same token over the HTTP proxy or heel run isn't that client.
    expect(clientFor("http", "claude-code")).toBeNull();
    expect(clientFor("cli", "claude-code")).toBeNull();
  });
});
