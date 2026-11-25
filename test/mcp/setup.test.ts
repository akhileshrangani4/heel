import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addAgent } from "../../src/gateway/agents.ts";
import { fullSetupPrompt, installPrompt, setupPrompt } from "../../src/gateway/mcp/setup-prompt.ts";
import { proposeRules } from "../../src/proposals/rules.ts";
import { KEY_SERVICES } from "../../src/requests/connection.ts";
import { agents } from "../../src/store/schema.ts";
import { connectAccount } from "../../src/vault/connect.ts";
import { mcpHarness } from "../helpers/mcp.ts";

/**
 * The setup prompt (roadmap 2.6): served as an MCP prompt, printed in
 * docs/quickstart.md, and backed by heel_accounts, which shows an agent what's
 * behind heel and what it asked for, by name only.
 */

const READS = `rules:\n  - match: { tool: search_notes }\n    then: allow\n`;

/** Where the owner makes each key service's key; a new key service needs its page in the prompt. */
const KEY_PAGES: Readonly<Record<(typeof KEY_SERVICES)[number], string>> = {
  github: "https://github.com/settings/personal-access-tokens/new",
  slack: "https://api.slack.com/apps",
  linear: "https://linear.app/settings/account/security",
  notion: "https://www.notion.so/my-integrations",
  stripe: "https://dashboard.stripe.com/apikeys",
};

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

  it("is printed in docs/quickstart.md whole, install first, so one line to an agent sets heel up", () => {
    const doc = readFileSync(new URL("../../docs/quickstart.md", import.meta.url), "utf8");
    expect(doc).toContain(`\`\`\`text\n${fullSetupPrompt(null)}\n\`\`\``);
    expect(doc).toContain(
      "Set up heel for me: run curl -fsSL https://useheel.dev/setup.md and follow it",
    );
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

  it("hands the owner the sign-in command, since the agent's own session can't sign in", () => {
    const text = installPrompt();
    expect(text).toContain("ask me to run claude mcp login heel in my own terminal");
    expect(text).toContain("claude mcp login heel --no-browser");
    expect(text).toContain("claude mcp list no longer says Needs authentication");
    // The session that added heel doesn't have its tools until it reloads or a new one starts.
    expect(text).toContain("start a new session and give it this same line");
  });

  it("checks Node in a login shell over ssh, and upgrades it before installing heel", () => {
    const text = installPrompt();
    expect(text).toContain(`ssh <host> '$SHELL -lc "<command>"'`);
    expect(text).toContain("upgrade it the way that machine gets Node (brew upgrade node");
    expect(text.indexOf("before step 2")).toBeLessThan(text.indexOf("npm install -g useheel"));
  });

  it("helps the owner make each key in chat, with both ways to hand it over, and never asks for it", () => {
    const text = setupPrompt(null);
    for (const service of KEY_SERVICES) expect(text).toContain(KEY_PAGES[service]);
    expect(text).toContain("never ask me for one, and never put one in a command you run");
    expect(text).toContain("paste it on heel's page, or pipe it in from my own terminal");
    expect(text).toContain("pbpaste | heel connect github --as github --credential-stdin");
    // gh auth token is the owner's choice, with its tradeoff, never forbidden.
    expect(text).toContain("gh auth token works too");
    expect(text).toContain("heel's rules gate your calls either way, so let me choose");
    expect(text).not.toMatch(/never use|don't use/i);
  });

  it("never has the owner revoke the key heel now holds", () => {
    const text = setupPrompt(null);
    expect(text).toContain("Once an account works through heel");
    expect(text).toContain(
      "suggest revoking an old one with the service only after I say heel doesn't hold it",
    );
    expect(text).toContain("revoking GitHub CLI on GitHub would cut heel off");
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

  it("still lists a request the owner's own heel connect didn't settle, as the setup prompt says", async () => {
    const h = await mcpHarness({ owner: READS });
    const client = await h.connect("/mcp?tools=direct");
    await client.callTool({
      name: "heel_request_connection",
      arguments: { service: "github", alias: "github", why: "to review your pull requests" },
    });
    // What heel connect does on the owner's side (the admin socket's account.connect).
    connectAccount(
      h.t.db,
      null,
      { orgId: h.t.orgId, ownerId: h.t.ownerId, provider: "github", alias: "github" },
      new Date(),
    );
    const answer = (await client.callTool({ name: "heel_accounts", arguments: {} }))
      .structuredContent as Answer;
    expect(answer.accounts.map((a) => a.alias)).toContain("github");
    expect(answer.waiting.connections.map((c) => c.alias)).toEqual(["github"]);
    expect(setupPrompt(null)).toContain(
      "The command doesn't settle a request, so request only what I'll paste",
    );
  });

  it("lists only the agent's own proposals, not heel's suggestions about it (2.10)", async () => {
    const h = await mcpHarness({ owner: READS });
    const client = await h.connect("/mcp?tools=direct");
    const agentId = h.t.db.select({ id: agents.id }).from(agents).get()?.id ?? "";
    // biome-ignore lint/suspicious/noThenProperty: `then` is the rules file's key.
    const rule = { match: { tool: "search_notes" }, then: "allow" };
    const who = { orgId: h.t.orgId, ownerId: h.t.ownerId, agentId };
    const own = proposeRules(
      h.t.db,
      who,
      { rules: [{ rule, why: "to search notes" }] },
      new Date(),
    );
    proposeRules(h.t.db, who, { rules: [{ rule, why: "to search notes" }] }, new Date(), {
      by: "heel",
      before: "x",
    });
    const answer = (await client.callTool({ name: "heel_accounts", arguments: {} }))
      .structuredContent as Answer;
    expect(answer.waiting.ruleProposals.map((p) => p.proposalId)).toEqual([
      own.ok ? own.proposalId : "",
    ]);
  });
});
