import { describe, expect, it } from "vitest";
import { GOOGLE_CALENDAR_TOOLS } from "../../src/definitions/calendar/google.ts";
import { GITHUB_TOOLS } from "../../src/definitions/github/definition.ts";
import { GMAIL_TOOLS } from "../../src/definitions/gmail/definition.ts";
import { LINEAR_TOOLS } from "../../src/definitions/linear/definition.ts";
import { returnsSchema } from "../../src/definitions/mail/returns-schema.ts";
import { NOTION_TOOLS } from "../../src/definitions/notion/definition.ts";
import { OUTLOOK_TOOLS } from "../../src/definitions/outlook/definition.ts";
import { SLACK_TOOLS } from "../../src/definitions/slack/definition.ts";
import { STRIPE_TOOLS } from "../../src/definitions/stripe/definition.ts";
import { listedTool } from "../../src/gateway/mcp/names.ts";

/**
 * Code mode round 2, C5: built-in tools list an MCP outputSchema, made from
 * their `returns`, so a client's own code mode can rely on a result's shape.
 */

const ALL = [
  ...GITHUB_TOOLS,
  ...GMAIL_TOOLS,
  ...GOOGLE_CALENDAR_TOOLS,
  ...OUTLOOK_TOOLS,
  ...SLACK_TOOLS,
  ...LINEAR_TOOLS,
  ...NOTION_TOOLS,
  ...STRIPE_TOOLS,
];

describe("output schemas for built-in tools (C5)", () => {
  it("every listed built-in tool has a loose object schema: keys described, none required", () => {
    const missing = ALL.filter((t) => t.outputSchema === undefined).map((t) => t.name);
    expect(missing).toEqual([]);
    for (const tool of ALL) {
      expect(tool.outputSchema).toMatchObject({ type: "object" });
      expect(tool.outputSchema).not.toHaveProperty("required");
      expect(tool.outputSchema).not.toHaveProperty("additionalProperties");
    }
  });

  it("reads the shapes `returns` uses", () => {
    expect(
      returnsSchema('{"issues": [{"number", "title"}, ...], "next"} (pull requests left out)'),
    ).toEqual({
      type: "object",
      properties: {
        issues: { type: "array", items: { type: "object", properties: { number: {}, title: {} } } },
        next: {},
      },
    });
    expect(returnsSchema('{"addresses": [str, ...]}')).toEqual({
      type: "object",
      properties: { addresses: { type: "array", items: { type: "string" } } },
    });
    expect(returnsSchema("GitHub's answer as it came")).toBeNull();
    expect(returnsSchema('{"broken": [')).toBeNull();
  });

  it("is listed for a built-in account, never for a passthrough one", () => {
    const tool = {
      name: "x",
      inputSchema: { type: "object" as const },
      outputSchema: { type: "object" as const },
    };
    expect(listedTool(tool, "x", true)).toHaveProperty("outputSchema");
    expect(listedTool(tool, "x")).not.toHaveProperty("outputSchema");
  });
});
