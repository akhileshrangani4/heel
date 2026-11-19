import { describe, expect, it } from "vitest";
import { clientNameFrom } from "../../src/gateway/mcp/client-info.ts";
import { clientLabel } from "../../src/web/ui/summary.ts";

const init = (name: unknown) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version: "1" } },
});

describe("clientNameFrom", () => {
  it("reads clientInfo.name from initialize, alone or in a batch", () => {
    expect(clientNameFrom(init("claude-code"))).toBe("claude-code");
    expect(clientNameFrom([{ jsonrpc: "2.0", method: "ping", id: 2 }, init("cursor")])).toBe(
      "cursor",
    );
  });

  it("ignores other methods and names it won't show", () => {
    expect(clientNameFrom({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} })).toBeNull();
    expect(clientNameFrom(init("<script>"))).toBeNull();
    expect(clientNameFrom(init("x".repeat(81)))).toBeNull();
    expect(clientNameFrom(init(42))).toBeNull();
    expect(clientNameFrom("not json")).toBeNull();
  });
});

describe("clientLabel", () => {
  it("names known clients and shows anything else as it named itself", () => {
    expect(clientLabel("claude-code")).toBe("Claude Code");
    expect(clientLabel("my-agent")).toBe("my-agent");
  });
});
