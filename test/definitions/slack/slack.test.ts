import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { UpstreamPool } from "../../../src/definitions/mcp/upstream.ts";
import { definitionRegistry } from "../../../src/definitions/registry.ts";
import { addAgent } from "../../../src/gateway/agents.ts";
import { createPipeline } from "../../../src/gateway/pipeline/pipeline.ts";
import { SqliteApprovalStore } from "../../../src/store/approvals.ts";
import { SqlitePauseStore } from "../../../src/store/pauses.ts";
import { KEY_BYTES } from "../../../src/vault/crypto.ts";
import { Vault } from "../../../src/vault/vault.ts";
import { captureLogger } from "../../helpers/log.ts";
import { compileRules } from "../../helpers/pipeline.ts";
import { addAccount, testStore } from "../../helpers/store.ts";

/** The Slack definition (D12b) through the real pipeline, against a fake Slack Web API. */

const TOKEN = "slack-test-token-not-real";
const INTERNAL = "C0INTERNAL";
const SHARED = "C0SHARED1";

interface Sent {
  method: string;
  params: Record<string, unknown>;
}

function fakeSlack(options: { refuse?: string; infoFails?: boolean } = {}) {
  const sent: Sent[] = [];
  const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input.toString());
    const method = url.pathname.replace("/api/", "");
    const params =
      init?.method === "POST"
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : Object.fromEntries(url.searchParams);
    sent.push({ method, params });
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${TOKEN}`) {
      return Response.json({ ok: false, error: "not_authed" });
    }
    switch (method) {
      case "conversations.info": {
        if (options.infoFails === true) return new Response("", { status: 500 });
        const id = String(params["channel"]);
        if (id !== INTERNAL && id !== SHARED)
          return Response.json({ ok: false, error: "channel_not_found" });
        return Response.json({ ok: true, channel: { id, is_ext_shared: id === SHARED } });
      }
      case "conversations.history":
        return Response.json({
          ok: true,
          messages: [{ ts: "1700000000.000100", user: "U1", text: "hi" }],
        });
      case "chat.postMessage":
      case "chat.update":
      case "chat.delete":
        if (options.refuse !== undefined)
          return Response.json({ ok: false, error: options.refuse });
        return Response.json({ ok: true, channel: params["channel"], ts: "1700000001.000200" });
      case "chat.scheduleMessage":
        return Response.json({
          ok: true,
          channel: params["channel"],
          scheduled_message_id: "Q1",
          post_at: params["post_at"],
        });
      default:
        return Response.json({ ok: false, error: "unknown_method" });
    }
  };
  return { fetch, sent };
}

function setUp(owner: string, slack = fakeSlack()) {
  const t = testStore();
  const accountId = addAccount(t, "slack", "slack");
  const vault = Vault.open(t.db, { bytes: randomBytes(KEY_BYTES), source: "test" });
  vault.put(accountId, { type: "static", value: TOKEN });
  const { logger } = captureLogger();
  const pipeline = createPipeline({
    db: t.db,
    rules: { set: compileRules({ owner }) },
    definitions: definitionRegistry({
      upstream: new UpstreamPool({ vault: null, log: logger }),
      gmail: null,
      slack: { vault, fetch: slack.fetch },
    }),
    pauses: new SqlitePauseStore(),
    approvals: new SqliteApprovalStore(),
    log: logger,
    alerts: { raise: () => {} },
    watch: false,
  });
  const { agentId } = addAgent(
    t.db,
    { orgId: t.orgId, ownerId: t.ownerId, name: "bot" },
    new Date(),
  );
  const agent = { orgId: t.orgId, agentId, agentName: "bot", ownerId: t.ownerId, tokenId: "tok_1" };
  const call = (tool: string, args: Record<string, unknown>) =>
    pipeline.run({ agent, surface: "mcp", account: "slack", tool, args });
  return { call, sent: slack.sent };
}

const INSIDE_ONLY = `rules:
  - match: { action: slack.read }
    then: allow
  - match: { action: slack.post, external: false }
    then: allow
  - match: { action: slack.post, external: true }
    then: ask
`;

const posts = (sent: Sent[]) => sent.filter((s) => s.method === "chat.postMessage");

describe("the Slack definition", () => {
  it("posts to an internal channel", async () => {
    const h = setUp(INSIDE_ONLY);
    const result = await h.call("post_message", { channel: INTERNAL, text: "standup in 5" });
    expect(result.status).toBe("allowed");
    expect(posts(h.sent)[0]?.params).toEqual({ channel: INTERNAL, text: "standup in 5" });
  });

  it("asks before posting to a channel shared with another organization", async () => {
    const h = setUp(INSIDE_ONLY);
    const result = await h.call("post_message", { channel: SHARED, text: "hello partners" });
    expect(result.status).toBe("pending");
    expect(posts(h.sent)).toEqual([]);
  });

  it("lets a rule name the channel", async () => {
    const h = setUp(
      `rules:\n  - match: { action: slack.post, channel: ${INTERNAL} }\n    then: allow\n`,
    );
    expect((await h.call("post_message", { channel: INTERNAL, text: "x" })).status).toBe("allowed");
    expect((await h.call("post_message", { channel: SHARED, text: "x" })).status).toBe("denied");
  });

  it("denies when it can't tell whether the channel is shared", async () => {
    const h = setUp(INSIDE_ONLY, fakeSlack({ infoFails: true }));
    const result = await h.call("post_message", { channel: INTERNAL, text: "x" });
    expect(result).toMatchObject({ status: "denied", reason: "lookup_unavailable" });
    expect(posts(h.sent)).toEqual([]);
  });

  it("denies a channel that isn't there as not available", async () => {
    const h = setUp(INSIDE_ONLY);
    const result = await h.call("read_channel", { channel: "C0MISSING" });
    expect(result).toMatchObject({ status: "denied", reason: "not_available" });
  });

  it("reports Slack's refusal of a post as an upstream error", async () => {
    const h = setUp(INSIDE_ONLY, fakeSlack({ refuse: "not_in_channel" }));
    const result = await h.call("post_message", { channel: INTERNAL, text: "x" });
    expect(result).toMatchObject({ status: "upstream_error", upstreamStatus: 400 });
  });

  it("treats a scheduled message as persistence, so a post rule doesn't cover it", async () => {
    const h = setUp(
      `rules:\n  - match: { action: slack.post }\n    then: allow\n  - match: { channel: ${INTERNAL} }\n    then: allow\n`,
    );
    const result = await h.call("schedule_message", {
      channel: INTERNAL,
      text: "x",
      post_at: 1_900_000_000,
    });
    expect(result).toMatchObject({ status: "denied", reason: "persistence_unnamed" });
    expect(h.sent.some((s) => s.method === "chat.scheduleMessage")).toBe(false);
  });

  it.each([
    ["blocks", { channel: INTERNAL, text: "x", blocks: [] }],
    ["a channel name", { channel: "#general", text: "x" }],
    ["empty text", { channel: INTERNAL, text: "" }],
  ])("refuses a post with %s", async (_label, args) => {
    const h = setUp(INSIDE_ONLY);
    expect(await h.call("post_message", args)).toMatchObject({
      status: "denied",
      reason: "unsupported",
    });
  });

  it("reads a channel, with its fields set for rules", async () => {
    const h = setUp(
      `rules:\n  - match: { action: slack.read, external: false }\n    then: allow\n`,
    );
    const result = await h.call("read_channel", { channel: INTERNAL });
    expect(result).toMatchObject({ status: "allowed" });
    expect((await h.call("read_channel", { channel: SHARED })).status).toBe("denied");
  });
});
