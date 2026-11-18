import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { filterResponse, parseHideMapping } from "../../src/definitions/http/hide-map.ts";
import { OpenApiError, parseOpenApi } from "../../src/definitions/http/openapi.ts";
import { UpstreamPool } from "../../src/definitions/mcp/upstream.ts";
import { definitionRegistry } from "../../src/definitions/registry.ts";
import { addAgent } from "../../src/gateway/agents.ts";
import { createAgentApp } from "../../src/gateway/app.ts";
import { createPipeline } from "../../src/gateway/pipeline/pipeline.ts";
import { SqliteApprovalStore } from "../../src/store/approvals.ts";
import { SqlitePauseStore } from "../../src/store/pauses.ts";
import { connectAccount } from "../../src/vault/connect.ts";
import { KEY_BYTES } from "../../src/vault/crypto.ts";
import { Vault } from "../../src/vault/vault.ts";
import { captureLogger } from "../helpers/log.ts";
import { compileRules } from "../helpers/pipeline.ts";
import { testStore } from "../helpers/store.ts";

/** Hiding on an OpenAPI account (D7b): `x-heel-hide` mappings on the operation. */

const OPENAPI = `openapi: 3.1.0
info: { title: Mail, version: "1" }
paths:
  /messages:
    get:
      x-heel-kind: read
      x-heel-hide:
        items: $.messages[*]
        from: $.sender.email
        to: $.recipients[*]
        subject: $.subject
  /messages/{id}:
    get:
      x-heel-kind: read
      x-heel-hide: { items: $, from: $.sender.email, subject: $.subject }
  /unmapped:
    get: { x-heel-kind: read }
`;

const MESSAGES = {
  messages: [
    {
      id: "1",
      sender: { email: "Boss@Example.com" },
      recipients: ["me@example.com"],
      subject: "Offer",
    },
    {
      id: "2",
      sender: { email: "friend@example.com" },
      recipients: ["me@example.com"],
      subject: "Lunch",
    },
  ],
  next: null,
};

const RULES = `rules:
  - match: { kind: read }
    then: allow
hide:
  - email: { from: { any_of: [boss@example.com] } }
`;

function setUp(answer: (path: string) => Response) {
  const t = testStore();
  const vault = Vault.open(t.db, { bytes: randomBytes(KEY_BYTES), source: "test" });
  connectAccount(
    t.db,
    vault,
    {
      orgId: t.orgId,
      ownerId: t.ownerId,
      provider: "http",
      alias: "mail",
      credential: { type: "static", value: "mail-test-token" },
      http: { baseUrl: "https://mail.example.com/api", auth: "bearer", openapi: OPENAPI },
    },
    new Date(),
  );
  const { logger } = captureLogger();
  const pipeline = createPipeline({
    db: t.db,
    rules: { set: compileRules({ owner: RULES }) },
    definitions: definitionRegistry({
      upstream: new UpstreamPool({ vault: null, log: logger }),
      gmail: null,
      http: { vault, fetch: async (input) => answer(new URL(input.toString()).pathname) },
    }),
    pauses: new SqlitePauseStore(),
    approvals: new SqliteApprovalStore(),
    log: logger,
    alerts: { raise: () => {} },
    watch: false,
  });
  const app = createAgentApp({ db: t.db, log: logger, http: { db: t.db, pipeline, log: logger } });
  const { token } = addAgent(t.db, { orgId: t.orgId, ownerId: t.ownerId, name: "bot" }, new Date());
  return (path: string) =>
    app.request(new URL(path, "http://localhost"), {
      headers: { authorization: `Bearer ${token}` },
    });
}

describe("x-heel-hide mappings", () => {
  it("are read from the OpenAPI file", () => {
    const ops = parseOpenApi(OPENAPI);
    expect(ops.find((o) => o.template === "/messages")?.hide).toEqual({
      items: "$.messages[*]",
      from: "$.sender.email",
      to: "$.recipients[*]",
      subject: "$.subject",
    });
  });

  it.each([
    ["no items", { from: "$.from" }],
    ["items not ending in [*]", { items: "$.messages", from: "$.from" }],
    ["[*] before the end", { items: "$.pages[*].messages[*]", from: "$.from" }],
    ["a path outside the subset", { items: "$..messages[*]", from: "$.from" }],
    ["an unknown field", { items: "$", from: "$.from", cc: "$.cc" }],
    ["no field at all", { items: "$" }],
  ])("refuse %s", (_label, mapping) => {
    expect(() => parseHideMapping(mapping, "GET /x")).toThrow();
  });

  it("refuse a bad mapping as a bad OpenAPI file", () => {
    expect(() =>
      parseOpenApi(`openapi: 3.0.0\npaths:\n  /x:\n    get: { x-heel-hide: { items: "$..x" } }\n`),
    ).toThrow(OpenApiError);
  });

  it("drop hidden items and leave everything else as it was", () => {
    const mapping = parseHideMapping(
      { items: "$.messages[*]", from: "$.sender.email" },
      "GET /messages",
    );
    const response = structuredClone(MESSAGES);
    const filtered = filterResponse(response, mapping, (c) => c.from === "boss@example.com", false);
    expect(filtered).toEqual({
      kind: "list",
      hidden: 1,
      value: { messages: [MESSAGES.messages[1]], next: null },
    });
  });

  it("call a response whose items path isn't a list unreadable", () => {
    const mapping = parseHideMapping({ items: "$.messages[*]", from: "$.from" }, "GET /m");
    expect(filterResponse({ messages: "nope" }, mapping, () => false, false)).toEqual({
      kind: "unreadable",
    });
  });
});

describe("hiding through the HTTP proxy", () => {
  it("removes hidden items from a list and says how many", async () => {
    const request = setUp(() => Response.json(MESSAGES));
    const response = await request("/http/mail/messages");
    expect(response.status).toBe(200);
    expect(response.headers.get("heel-hidden")).toBe("1");
    const body = (await response.json()) as typeof MESSAGES;
    expect(body.messages.map((m) => m.id)).toEqual(["2"]);
    expect(JSON.stringify(body)).not.toContain("Offer");
  });

  it("answers a single hidden item as not available", async () => {
    const request = setUp(() => Response.json(MESSAGES.messages[0]));
    const response = await request("/http/mail/messages/1");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ status: "denied", reason: "not_available" });
  });

  it("withholds a mapped response it can't read", async () => {
    const request = setUp(
      () => new Response("<html>", { headers: { "content-type": "text/html" } }),
    );
    const response = await request("/http/mail/messages");
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("html");
  });

  it("leaves an operation with no mapping as it is (I-46)", async () => {
    const request = setUp(() => Response.json(MESSAGES));
    const response = await request("/http/mail/unmapped");
    expect(response.status).toBe(200);
    expect(response.headers.get("heel-hidden")).toBeNull();
  });
});
