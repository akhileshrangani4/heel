import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addAgent } from "../../src/gateway/agents.ts";
import { fullSetupPrompt, installPrompt, setupPrompt } from "../../src/gateway/mcp/setup-prompt.ts";
import { mcpHarness } from "../helpers/mcp.ts";

/**
 * The setup prompt (roadmap 2.6): served as an MCP prompt, printed in
 * docs/setup.md, and backed by heel_accounts, which shows an agent what's
 * behind heel and what it asked for, by name only.
 */

const READS = `rules:\n  - match: { tool: search_notes }\n    then: allow\n`;

type Answer = {
  accounts: { alias: string; service: string; status: string }[];
  waiting: {
    connections: { alias: string; service: string; expiresAt: string }[];
    ruleProposals: { proposalId: string }[];
  };
};

describe("the setup prompt", () => {
  it("is listed as the MCP prompt setup, and its text says nothing changes without a passkey", async () => {
    const h = await mcpHarness({ owner: READS });
    const client = await h.connect("/mcp?tools=direct");
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(["setup"]);
    const got = await client.getPrompt({ name: "setup" });
    const message = got.messages[0];
    expect(message?.role).toBe("user");
    const text = message?.content.type === "text" ? message.content.text : "";
    expect(text).toBe(setupPrompt(null));
    expect(text).toContain("heel_accounts");
    expect(text).toContain("Never read, print, copy or send the value of a key");
    await expect(client.getPrompt({ name: "nope" })).rejects.toThrow(/Unknown prompt/);
  });

  it("names heel's approval page when heel knows it", () => {
    expect(setupPrompt("https://heel.example/approvals")).toContain(
      "heel's approval page (https://heel.example/approvals)",
    );
  });

  it("is printed in docs/setup.md whole, install first, so one line to an agent sets heel up", () => {
    const doc = readFileSync(new URL("../../docs/setup.md", import.meta.url), "utf8");
    expect(doc).toContain(`\`\`\`text\n${fullSetupPrompt(null)}\n\`\`\``);
    expect(doc).toContain("Set up heel for me by following https://useheel.dev/setup.md");
    expect(fullSetupPrompt(null).startsWith(installPrompt())).toBe(true);
    expect(fullSetupPrompt(null).endsWith(setupPrompt(null))).toBe(true);
  });

  it("keeps the install half to installing, starting, the passkey link and adding itself", () => {
    const text = installPrompt();
    for (const step of [
      "npm install -g useheel",
      "heel init --yes",
      "heel start",
      "heel user enroll owner",
      "heel agent add",
    ]) {
      expect(text).toContain(step);
    }
    expect(text).toContain(
      "Don't run heel connect, edit heel's rules files or approve anything yourself",
    );
    expect(text).toContain("check each one first and skip it if it's done");
  });
});

describe("heel_accounts", () => {
  it("lists the accounts the agent can use and its own waiting requests, never another agent's", async () => {
    const h = await mcpHarness({ owner: READS });
    const client = await h.connect("/mcp?tools=direct");
    await client.callTool({
      name: "heel_request_connection",
      arguments: { service: "gmail", alias: "gmail-work", why: "to triage your mail" },
    });
    // Another agent of the same owner asks for something too.
    const other = addAgent(
      h.t.db,
      { orgId: h.t.orgId, ownerId: h.t.ownerId, name: "other-bot" },
      new Date(),
    );
    const otherClient = await h.connect("/mcp?tools=direct", { token: other.token });
    await otherClient.callTool({
      name: "heel_request_connection",
      arguments: { service: "outlook", alias: "outlook-home", why: "calendar" },
    });

    const result = await client.callTool({ name: "heel_accounts", arguments: {} });
    const answer = result.structuredContent as Answer;
    expect(answer.accounts).toEqual([{ alias: "notes", service: "mcp", status: "active" }]);
    expect(answer.waiting.connections.map((c) => [c.alias, c.service])).toEqual([
      ["gmail-work", "gmail"],
    ]);
    expect(answer.waiting.ruleProposals).toEqual([]);
    // Names and services only.
    expect(JSON.stringify(answer)).not.toMatch(/token|secret|credential/i);
  });
});
