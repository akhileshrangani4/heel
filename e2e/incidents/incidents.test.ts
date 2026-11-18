/**
 * The four README incidents, replayed end to end against heel (D14; spec:
 * "The four incident replays"). The agent is a real MCP client that added
 * heel as its Gmail and Outlook servers; heel runs its real pipeline, stores
 * and built-in definitions, with the README's example rules file unchanged,
 * in front of fake Gmail and Graph mailboxes. Each replay checks two things:
 * the harmful call is stopped before anything reaches the mailbox, and the
 * useful path in that same story still runs.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { UpstreamPool } from "../../src/definitions/mcp/upstream.ts";
import { definitionRegistry } from "../../src/definitions/registry.ts";
import { addAgent } from "../../src/gateway/agents.ts";
import { createAgentApp } from "../../src/gateway/app.ts";
import { createMcpSurface } from "../../src/gateway/mcp/server.ts";
import { createPipeline } from "../../src/gateway/pipeline/pipeline.ts";
import { defaultLooksLikeJudge } from "../../src/lookslike/judge.ts";
import { SqliteApprovalStore } from "../../src/store/approvals.ts";
import { pause, SqlitePauseStore } from "../../src/store/pauses.ts";
import { accounts } from "../../src/store/schema.ts";
import { KEY_BYTES } from "../../src/vault/crypto.ts";
import { Vault } from "../../src/vault/vault.ts";
import { FakeGmail, GMAIL_TEST_TOKEN } from "../../test/helpers/fake-gmail.ts";
import { FakeGraph, GRAPH_TEST_TOKEN, MAILBOX } from "../../test/helpers/fake-graph.ts";
import { captureLogger } from "../../test/helpers/log.ts";
import { compileRules } from "../../test/helpers/pipeline.ts";
import { addAccount, testStore } from "../../test/helpers/store.ts";

/** The README's example rules, exactly as published (README "Rules"). */
const README_RULES = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "..",
    "test",
    "fixtures",
    "rules",
    "readme",
    "rules",
    "owner.yaml",
  ),
  "utf8",
);

const PERSONAL_TOKEN = "gmail-personal-test-access";

type Decision = { status: string; reason?: string; rule?: { name: string | null } | null };

async function setUp() {
  const t = testStore();
  const work = new FakeGmail();
  const personal = new FakeGmail();
  const graph = new FakeGraph();
  const vault = Vault.open(t.db, { bytes: randomBytes(KEY_BYTES), source: "test" });
  const gmailWork = addAccount(t, "gmail-work", "gmail");
  const gmailPersonal = addAccount(t, "gmail-personal", "gmail");
  const outlook = addAccount(t, "outlook-work", "outlook");
  t.db
    .update(accounts)
    .set({ settings: { mailbox: MAILBOX } })
    .where(eq(accounts.id, outlook))
    .run();
  vault.put(gmailWork, { type: "oauth", accessToken: GMAIL_TEST_TOKEN, refreshToken: "r" });
  vault.put(gmailPersonal, { type: "oauth", accessToken: PERSONAL_TOKEN, refreshToken: "r" });
  vault.put(outlook, { type: "oauth", accessToken: GRAPH_TEST_TOKEN, refreshToken: "r" });

  // One Gmail fetch for both accounts: the token says which mailbox it is.
  const gmailFetch = async (input: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (headers.get("authorization") === `Bearer ${PERSONAL_TOKEN}`) {
      headers.set("authorization", `Bearer ${GMAIL_TEST_TOKEN}`);
      return personal.fetch(input, { ...init, headers });
    }
    return work.fetch(input, init);
  };
  const { logger } = captureLogger();
  const definitions = definitionRegistry({
    upstream: new UpstreamPool({ vault: null, log: logger }),
    gmail: { vault, fetch: gmailFetch },
    outlook: { vault, fetch: graph.fetch },
  });
  const pauses = new SqlitePauseStore();
  const pipeline = createPipeline({
    db: t.db,
    rules: { set: compileRules({ owner: README_RULES }) },
    definitions,
    pauses,
    approvals: new SqliteApprovalStore(),
    log: logger,
    alerts: { raise: () => {} },
    watch: false,
    // heel's own classifier, as `heel serve` loads it: the README hides password resets and login codes.
    looksLike: defaultLooksLikeJudge((error) => {
      throw new Error(`the looks_like model didn't load: ${error}`);
    }),
  });
  const mcp = createMcpSurface({ db: t.db, pipeline, definitions, log: logger, version: "test" });
  const app = createAgentApp({ db: t.db, log: logger, mcp });
  const { token } = addAgent(
    t.db,
    { orgId: t.orgId, ownerId: t.ownerId, name: "inbox-bot" },
    new Date(),
  );

  /** The agent's MCP client for one account, as a custom MCP server pointing at heel. */
  const connect = async (account: string) => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`/mcp/${account}`, "http://localhost"),
      {
        fetch: async (input, init) => app.fetch(new Request(input, init)),
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      },
    );
    const client = new Client({ name: "incident-agent", version: "1.0.0" });
    await client.connect(transport);
    return client;
  };
  const call = async (
    client: Client,
    name: string,
    args: Record<string, unknown>,
    runId?: string,
  ): Promise<{ ok: boolean; decision?: Decision }> => {
    const result = await client.callTool({
      name,
      arguments: args,
      ...(runId === undefined ? {} : { _meta: { "heel/runId": runId } }),
    });
    return result.isError === true
      ? { ok: false, decision: result.structuredContent as Decision }
      : { ok: true };
  };
  return { t, work, personal, graph, connect, call };
}

describe("claude-code#99453: a send set to need approval went out with no prompt", () => {
  it("asks before the send, and nothing reaches Gmail until someone approves", async () => {
    const h = await setUp();
    const gmail = await h.connect("gmail-work");
    const send = await h.call(gmail, "send", {
      from: "alice@company.com",
      to: ["bob@vendor.example"],
      subject: "Contract",
      body: "Signed copy attached.",
    });
    expect(send).toMatchObject({ ok: false, decision: { status: "pending" } });
    expect(h.work.sent).toEqual([]);
  });

  it("still lets the agent read the inbox", async () => {
    const h = await setUp();
    h.work.add({
      id: "m1",
      threadId: "t1",
      from: "bob@vendor.example",
      subject: "Contract",
      text: "hi",
    });
    const gmail = await h.connect("gmail-work");
    expect((await h.call(gmail, "search", { query: "contract" })).ok).toBe(true);
  });
});

describe("claude-code#96004: client emails went out from the personal account", () => {
  it("denies any send from gmail-personal to a client domain", async () => {
    const h = await setUp();
    const personal = await h.connect("gmail-personal");
    const send = await h.call(personal, "send", {
      from: "alice@company.com",
      to: ["ceo@clientco.com"],
      subject: "Proposal",
      body: "As discussed.",
    });
    expect(send).toMatchObject({ ok: false, decision: { status: "denied", reason: "rule" } });
    expect(h.personal.sent).toEqual([]);
  });

  it("asks about a send from gmail-personal to any other outside domain", async () => {
    const h = await setUp();
    const personal = await h.connect("gmail-personal");
    const send = await h.call(personal, "send", {
      from: "alice@company.com",
      to: ["support@vendor.example"],
      subject: "Ticket",
      body: "Please look.",
    });
    expect(send).toMatchObject({ ok: false, decision: { status: "pending" } });
    expect(h.personal.sent).toEqual([]);
  });

  it("still lets the agent read both mailboxes", async () => {
    const h = await setUp();
    for (const account of ["gmail-work", "gmail-personal"]) {
      expect((await h.call(await h.connect(account), "search", { query: "in:inbox" })).ok).toBe(
        true,
      );
    }
  });
});

describe("Kiro#8500: asked for drafts, the agent replied-all to a customer", () => {
  it("asks before the reply-all, and nothing reaches Outlook", async () => {
    const h = await setUp();
    h.graph.add({
      id: "msg-1",
      conversationId: "conv-1",
      folder: "inbox",
      from: "buyer@customer.example",
      to: [MAILBOX],
      cc: ["pm@company.com"],
      subject: "Renewal",
      text: "Hi Alice, can you confirm the renewal pricing for next year? Thanks, Bob",
    });
    const outlook = await h.connect("outlook-work");
    const reply = await h.call(outlook, "reply_all", {
      message_id: "msg-1",
      from: MAILBOX,
      body: "Draft: here's the pricing.",
    });
    expect(reply).toMatchObject({ ok: false, decision: { status: "pending" } });
    expect(h.graph.sent).toEqual([]);
  });

  it("still lets the agent read the thread it was asked to draft from", async () => {
    const h = await setUp();
    h.graph.add({
      id: "msg-1",
      conversationId: "conv-1",
      folder: "inbox",
      from: "buyer@customer.example",
      to: [MAILBOX],
      subject: "Renewal",
      text: "Hi Alice, can you confirm the renewal pricing for next year? Thanks, Bob",
    });
    const outlook = await h.connect("outlook-work");
    expect((await h.call(outlook, "get_message", { message_id: "msg-1" })).ok).toBe(true);
  });
});

describe("OpenClaw: told to suggest deletions, the agent cleared the inbox and ignored stop", () => {
  const inbox = (gmail: FakeGmail, n: number) => {
    for (let i = 1; i <= n; i++) {
      gmail.add({
        id: `m${i}`,
        threadId: `t${i}`,
        from: "news@example.com",
        subject: `Issue ${i}`,
        text: "x",
      });
    }
  };

  it("trashes up to 20 messages a run, then asks", async () => {
    const h = await setUp();
    inbox(h.work, 25);
    const gmail = await h.connect("gmail-work");
    const outcomes: string[] = [];
    for (let i = 1; i <= 21; i++) {
      const result = await h.call(gmail, "trash", { message_ids: [`m${i}`] }, "cleanup-1");
      outcomes.push(result.ok ? "ran" : (result.decision?.status ?? "?"));
    }
    // The useful path: removals under the limit run.
    expect(outcomes.slice(0, 20)).toEqual(Array(20).fill("ran"));
    expect(outcomes[20]).toBe("pending");
  });

  it("asks at once for one batch of more than 20", async () => {
    const h = await setUp();
    inbox(h.work, 25);
    const gmail = await h.connect("gmail-work");
    const ids = Array.from({ length: 25 }, (_, i) => `m${i + 1}`);
    expect(await h.call(gmail, "trash", { message_ids: ids }, "cleanup-2")).toMatchObject({
      ok: false,
      decision: { status: "pending" },
    });
  });

  it("stops the loop the moment someone pauses it, whatever the agent does next", async () => {
    const h = await setUp();
    inbox(h.work, 10);
    const gmail = await h.connect("gmail-work");
    expect((await h.call(gmail, "trash", { message_ids: ["m1"] }, "cleanup-3")).ok).toBe(true);
    // `heel pause` from a phone: the account's calls stop.
    pause(h.t.db, h.t.orgId, { scope: "account", target: "gmail-work" }, h.t.ownerId, new Date());
    for (let i = 2; i <= 5; i++) {
      expect(await h.call(gmail, "trash", { message_ids: [`m${i}`] }, "cleanup-3")).toMatchObject({
        ok: false,
        decision: { status: "paused" },
      });
    }
  });
});
