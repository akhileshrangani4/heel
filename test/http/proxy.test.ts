import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { matchOperation, parseOpenApi } from "../../src/definitions/http/openapi.ts";
import { UpstreamPool } from "../../src/definitions/mcp/upstream.ts";
import { definitionRegistry } from "../../src/definitions/registry.ts";
import { addAgent } from "../../src/gateway/agents.ts";
import { createAgentApp } from "../../src/gateway/app.ts";
import { proxiedPath } from "../../src/gateway/http-proxy.ts";
import { createPipeline } from "../../src/gateway/pipeline/pipeline.ts";
import { SqliteApprovalStore } from "../../src/store/approvals.ts";
import { SqlitePauseStore } from "../../src/store/pauses.ts";
import { ConnectError, connectAccount } from "../../src/vault/connect.ts";
import { KEY_BYTES } from "../../src/vault/crypto.ts";
import { Vault } from "../../src/vault/vault.ts";
import { captureLogger } from "../helpers/log.ts";
import { compileRules } from "../helpers/pipeline.ts";
import { testStore } from "../helpers/store.ts";

/** The HTTP proxy (D7a) through the real pipeline, against a fake upstream API. */

const OPENAPI = `openapi: 3.1.0
info: { title: Tickets, version: "1" }
paths:
  /tickets:
    get: { operationId: listTickets, x-heel-action: tickets.read, x-heel-kind: read }
    post: { operationId: createTicket, x-heel-action: tickets.create }
  /tickets/{id}:
    delete: { operationId: deleteTicket, x-heel-action: tickets.delete }
  /tickets/mine:
    get: { operationId: myTickets, x-heel-kind: read }
`;

const TOKEN = "api-test-secret";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function setUp(owner: string) {
  const t = testStore();
  const vault = Vault.open(t.db, { bytes: randomBytes(KEY_BYTES), source: "test" });
  const seen: Seen[] = [];
  const upstream = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    seen.push({
      url: input.toString(),
      method: init?.method ?? "GET",
      headers,
      body: init?.body === undefined ? "" : Buffer.from(init.body as Uint8Array).toString(),
    });
    const url = new URL(input.toString());
    if (url.pathname.endsWith("/redirect")) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/", "set-cookie": "s=1" },
      });
    }
    return Response.json(
      { ok: true, echoed: TOKEN },
      { status: 201, headers: { "set-cookie": "s=1" } },
    );
  };
  connectAccount(
    t.db,
    vault,
    {
      orgId: t.orgId,
      ownerId: t.ownerId,
      provider: "http",
      alias: "tickets",
      credential: { type: "static", value: TOKEN },
      http: { baseUrl: "https://api.example.com/v1", auth: "bearer", openapi: OPENAPI },
    },
    new Date(),
  );
  const { logger } = captureLogger();
  const pipeline = createPipeline({
    db: t.db,
    rules: { set: compileRules({ owner }) },
    definitions: definitionRegistry({
      upstream: new UpstreamPool({ vault: null, log: logger }),
      gmail: null,
      http: { vault, fetch: upstream },
    }),
    pauses: new SqlitePauseStore(),
    approvals: new SqliteApprovalStore(),
    log: logger,
    alerts: { raise: () => {} },
    watch: false,
  });
  const app = createAgentApp({ db: t.db, log: logger, http: { db: t.db, pipeline, log: logger } });
  const { token } = addAgent(
    t.db,
    { orgId: t.orgId, ownerId: t.ownerId, name: "inbox-bot" },
    new Date(),
  );
  const request = (path: string, init: RequestInit = {}) =>
    app.request(new URL(path, "http://localhost"), {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers as Record<string, string>) },
    });
  return { request, seen, t };
}

const ALLOW_TICKETS = `rules:
  - match: { action: tickets.create }
    then: allow
  - match: { kind: read }
    then: allow
  - match: { action: tickets.delete }
    then: ask
`;

describe("OpenAPI", () => {
  it("reads operations and matches literal paths over templates", () => {
    const ops = parseOpenApi(OPENAPI);
    expect(matchOperation(ops, "GET", "/tickets/mine")?.operationId).toBe("myTickets");
    expect(matchOperation(ops, "DELETE", "/tickets/42")?.template).toBe("/tickets/{id}");
    expect(matchOperation(ops, "GET", "/nope")).toBeNull();
  });
});

describe("the proxy's path checks", () => {
  it.each([
    ["an encoded slash", "/http/tickets/a%2Fb"],
    ["a dot-dot segment", "/http/tickets/a/../b"],
    ["an encoded dot-dot", "/http/tickets/a/%2e%2e/b"],
    ["a backslash", "/http/tickets/a%5Cb"],
    ["a scheme-relative path", "/http/tickets//evil.example/x"],
  ])("refuses %s", (_, path) => {
    expect(proxiedPath(path)).toMatchObject({ status: 400 });
  });
});

describe("the HTTP proxy", () => {
  it("forwards an allowed call with heel's credential, never the agent's headers", async () => {
    const { request, seen } = setUp(ALLOW_TICKETS);
    const response = await request("/http/tickets/tickets?team=ops", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "agent=1", "x-api-key": "agent-key" },
      body: JSON.stringify({ title: "Broken" }),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("heel-decision")).toBe("allow");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).toContain("[redacted by heel]");
    expect(seen[0]).toMatchObject({
      url: "https://api.example.com/v1/tickets?team=ops",
      method: "POST",
      body: JSON.stringify({ title: "Broken" }),
    });
    expect(seen[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(seen[0]?.headers["cookie"]).toBeUndefined();
    expect(seen[0]?.headers["x-api-key"]).toBeUndefined();
  });

  it("I-20: kind read only for operations the file marks read", async () => {
    const { request, seen } = setUp(`rules:
  - match: { kind: read }
    then: allow
`);
    expect((await request("/http/tickets/tickets/mine")).status).toBe(201);
    // No x-heel-kind on this path: default deny.
    expect((await request("/http/tickets/other")).status).toBe(403);
    expect(seen).toHaveLength(1);
  });

  it("answers 202 for an ask, 403 for a deny, and sends nothing upstream", async () => {
    const { request, seen } = setUp(ALLOW_TICKETS);
    const asked = await request("/http/tickets/tickets/42", { method: "DELETE" });
    expect(asked.status).toBe(202);
    expect(await asked.json()).toMatchObject({
      status: "pending",
      check: expect.stringMatching(/^\/approvals\//),
    });
    const denied = await request("/http/tickets/admin", { method: "POST" });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ status: "denied", reason: "no_rule_matched" });
    expect(seen).toEqual([]);
  });

  it("rules see the method, path template, query and parsed body", async () => {
    const { request } = setUp(`rules:
  - match: { method: POST, path: /tickets, query.team: ops, body.title: Broken }
    then: allow
`);
    const ok = await request("/http/tickets/tickets?team=ops", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Broken" }),
    });
    expect(ok.status).toBe(201);
    const other = await request("/http/tickets/tickets?team=sales", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Broken" }),
    });
    expect(other.status).toBe(403);
  });

  it("never follows a redirect", async () => {
    const { request, seen } = setUp(`rules:
  - match: { method: GET }
    then: allow
`);
    const response = await request("/http/tickets/redirect");
    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(seen).toHaveLength(1);
  });

  it("refuses an unknown account, and a host override", async () => {
    const { request } = setUp(ALLOW_TICKETS);
    expect((await request("/http/nope/tickets")).status).toBe(404);
    expect(
      (await request("/http/tickets/tickets", { headers: { "x-forwarded-host": "evil" } })).status,
    ).toBe(400);
  });
});

describe("connecting an HTTP account", () => {
  it("needs https, a valid auth spec, an OpenAPI 3 file and a credential", () => {
    const t = testStore();
    const vault = Vault.open(t.db, { bytes: randomBytes(KEY_BYTES), source: "test" });
    const base = {
      orgId: t.orgId,
      ownerId: t.ownerId,
      provider: "http",
      credential: { type: "static" as const, value: "x" },
    };
    for (const [alias, http] of [
      ["a", { baseUrl: "http://api.example.com", auth: "bearer", openapi: OPENAPI }],
      ["b", { baseUrl: "https://api.example.com", auth: "token", openapi: OPENAPI }],
      ["c", { baseUrl: "https://api.example.com", auth: "bearer", openapi: "swagger: '2.0'" }],
    ] as const) {
      expect(() => connectAccount(t.db, vault, { ...base, alias, http }, new Date())).toThrow(
        ConnectError,
      );
    }
  });
});
