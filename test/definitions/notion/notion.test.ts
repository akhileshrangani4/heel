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

/** The Notion definition (D12b) through the real pipeline, against a fake Notion API. */

const TOKEN = "notion-test-token-not-real";
const WIKI = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOTE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NESTED = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BLOCK = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PRIVATE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const DATABASE = "12345678-1234-4234-8234-123456789012";
const ROW = "99999999-9999-4999-8999-999999999999";

const pages: Record<string, Record<string, unknown>> = {
  [WIKI]: {
    object: "page",
    id: WIKI,
    parent: { type: "workspace", workspace: true },
    properties: {},
  },
  [NOTE]: { object: "page", id: NOTE, parent: { type: "page_id", page_id: WIKI }, properties: {} },
  [NESTED]: {
    object: "page",
    id: NESTED,
    parent: { type: "block_id", block_id: BLOCK },
    properties: {},
  },
  [PRIVATE]: {
    object: "page",
    id: PRIVATE,
    parent: { type: "workspace", workspace: true },
    properties: {},
  },
  [ROW]: {
    object: "page",
    id: ROW,
    parent: {
      type: "data_source_id",
      data_source_id: "77777777-7777-4777-8777-777777777777",
      database_id: DATABASE,
    },
    properties: {},
  },
};

function fakeNotion(options: { refuse?: number; code?: string; moveAfterRead?: boolean } = {}) {
  let reads = 0;
  const sent: { method: string; path: string; body: unknown; version: string | null }[] = [];
  const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input.toString());
    const method = init?.method ?? "GET";
    sent.push({
      method,
      path: url.pathname,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      version: new Headers(init?.headers).get("notion-version"),
    });
    const page = /^\/v1\/pages\/([0-9a-f-]+)$/.exec(url.pathname);
    if (method === "GET" && page !== null) {
      reads++;
      const p = pages[page[1] as string];
      if (options.moveAfterRead === true && reads > 1 && p !== undefined) {
        return Response.json({ ...p, parent: { type: "workspace", workspace: true } });
      }
      return p === undefined
        ? Response.json({ object: "error", code: "object_not_found" }, { status: 404 })
        : Response.json(p);
    }
    if (method === "GET" && url.pathname === `/v1/blocks/${BLOCK}`) {
      return Response.json({
        object: "block",
        id: BLOCK,
        parent: { type: "page_id", page_id: NOTE },
      });
    }
    if (method !== "GET" && options.refuse !== undefined) {
      return Response.json(
        { object: "error", code: options.code ?? "validation_error" },
        { status: options.refuse },
      );
    }
    if (method === "POST" && url.pathname === "/v1/pages")
      return Response.json({ object: "page", id: "new" });
    if (method === "PATCH") return Response.json({ object: "page", id: "x", in_trash: true });
    return Response.json({ object: "error", code: "object_not_found" }, { status: 404 });
  };
  return { fetch, sent };
}

function setUp(owner: string, notion = fakeNotion()) {
  const t = testStore();
  const accountId = addAccount(t, "notion", "notion");
  const vault = Vault.open(t.db, { bytes: randomBytes(KEY_BYTES), source: "test" });
  vault.put(accountId, { type: "static", value: TOKEN });
  const { logger } = captureLogger();
  const pipeline = createPipeline({
    db: t.db,
    rules: { set: compileRules({ owner }) },
    definitions: definitionRegistry({
      upstream: new UpstreamPool({ vault: null, log: logger }),
      gmail: null,
      notion: { vault, fetch: notion.fetch },
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
    pipeline.run({ agent, surface: "mcp", account: "notion", tool, args });
  return { call, sent: notion.sent };
}

const UNDER_WIKI = `rules:
  - match: { action: notion.page.update, parent: ${WIKI} }
    then: allow
  - match: { action: notion.page.create, parent: ${WIKI} }
    then: allow
  - match: { action: notion.page.delete }
    then: ask
`;

const writes = (sent: { method: string }[]) => sent.filter((s) => s.method !== "GET");

describe("the Notion definition", () => {
  it("appends to a page under an allowed parent, with the pinned API version", async () => {
    const h = setUp(UNDER_WIKI);
    expect(
      (await h.call("append_paragraphs", { page_id: NOTE, paragraphs: ["done"] })).status,
    ).toBe("allowed");
    expect(writes(h.sent)[0]).toMatchObject({
      method: "PATCH",
      path: `/v1/blocks/${NOTE}/children`,
      version: "2026-03-11",
    });
  });

  it("follows a block parent up to its page", async () => {
    const h = setUp(
      `rules:\n  - match: { action: notion.page.update, parent: ${NOTE} }\n    then: allow\n`,
    );
    expect((await h.call("append_paragraphs", { page_id: NESTED, paragraphs: ["x"] })).status).toBe(
      "allowed",
    );
  });

  it("denies a page under a parent the rule doesn't name", async () => {
    const h = setUp(UNDER_WIKI);
    expect(
      (await h.call("append_paragraphs", { page_id: PRIVATE, paragraphs: ["x"] })).status,
    ).toBe("denied");
    expect(writes(h.sent)).toEqual([]);
  });

  it("creates a page under a parent that is there, and denies one that isn't", async () => {
    const h = setUp(UNDER_WIKI);
    expect(
      (await h.call("create_page", { parent_page_id: WIKI.replaceAll("-", ""), title: "Notes" }))
        .status,
    ).toBe("allowed");
    expect(
      await h.call("create_page", {
        parent_page_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        title: "x",
      }),
    ).toEqual({ status: "denied", reason: "not_available", rule: null });
  });

  it("asks before trashing, with in_trash", async () => {
    const h = setUp(UNDER_WIKI);
    expect((await h.call("trash_page", { page_id: NOTE })).status).toBe("pending");
  });

  it("reports Notion's refusal as an upstream error", async () => {
    const h = setUp(UNDER_WIKI, fakeNotion({ refuse: 400 }));
    expect(await h.call("append_paragraphs", { page_id: NOTE, paragraphs: ["x"] })).toEqual({
      status: "upstream_error",
      upstreamStatus: 400,
      body: { code: "validation_error" },
    });
  });

  it.each([
    ["a block of another type", { page_id: NOTE, paragraphs: ["x"], blocks: [] }],
    ["a paragraph over 2,000 characters", { page_id: NOTE, paragraphs: ["x".repeat(2_001)] }],
    ["an id that isn't one", { page_id: "../users", paragraphs: ["x"] }],
  ])("refuses %s", async (_label, args) => {
    const h = setUp(UNDER_WIKI);
    expect(await h.call("append_paragraphs", args)).toMatchObject({ reason: "unsupported" });
  });

  it("gives a database row its database as parent", async () => {
    const h = setUp(
      `rules:\n  - match: { action: notion.page.delete, parent: "${DATABASE.replaceAll("-", "")}" }\n    then: deny\n  - match: {}\n    then: allow\n`,
    );
    expect((await h.call("trash_page", { page_id: ROW })).status).toBe("denied");
  });

  it("sends nothing when the page moved after heel checked it", async () => {
    const h = setUp(UNDER_WIKI, fakeNotion({ moveAfterRead: true }));
    expect(await h.call("append_paragraphs", { page_id: NOTE, paragraphs: ["x"] })).toEqual({
      status: "upstream_error",
      upstreamStatus: 409,
      body: { code: "moved_after_check" },
    });
    expect(writes(h.sent)).toEqual([]);
  });

  it.each([
    ["a 4xx that isn't Notion's own error", 408, "timeout"],
    ["a 5xx", 503, "service_unavailable"],
  ])("leaves %s unknown", async (_label, refuse, code) => {
    const h = setUp(UNDER_WIKI, fakeNotion({ refuse, code }));
    expect(await h.call("append_paragraphs", { page_id: NOTE, paragraphs: ["x"] })).toEqual({
      status: "upstream_outcome_unknown",
    });
  });
});
