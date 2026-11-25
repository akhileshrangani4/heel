import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { UpstreamPool } from "../../../src/definitions/mcp/upstream.ts";
import { definitionRegistry } from "../../../src/definitions/registry.ts";
import { formEncode } from "../../../src/definitions/stripe/client.ts";
import { addAgent } from "../../../src/gateway/agents.ts";
import { createPipeline } from "../../../src/gateway/pipeline/pipeline.ts";
import { SqliteApprovalStore } from "../../../src/store/approvals.ts";
import { SqlitePauseStore } from "../../../src/store/pauses.ts";
import { KEY_BYTES } from "../../../src/vault/crypto.ts";
import { Vault } from "../../../src/vault/vault.ts";
import { captureLogger } from "../../helpers/log.ts";
import { compileRules } from "../../helpers/pipeline.ts";
import { addAccount, testStore } from "../../helpers/store.ts";

/** The Stripe definition (D12b) through the real pipeline, against a fake Stripe API. */

const KEY = "stripe-test-key-not-real";

interface Sent {
  method: string;
  path: string;
  body: string;
  idempotency: string | null;
  version: string | null;
}

function fakeStripe(options: { status?: number; captured?: number; refunded?: number } = {}) {
  const sent: Sent[] = [];
  const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input.toString());
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    sent.push({
      method,
      path: url.pathname,
      body: String(init?.body ?? ""),
      idempotency: headers.get("idempotency-key"),
      version: headers.get("stripe-version"),
    });
    const p = url.pathname;
    if (method === "GET" && p === "/v1/payment_methods/pm_bobscard0001") {
      return Response.json({ id: "pm_bobscard0001", customer: "cus_bob0000001" });
    }
    if (method === "GET" && p === "/v1/payment_intents")
      return Response.json({ data: [], has_more: false });
    if (method === "GET" && p === "/v1/payment_intents/pi_paid000001") {
      return Response.json({
        id: "pi_paid000001",
        currency: "usd",
        customer: "cus_alice00001",
        latest_charge: "ch_paid000001",
      });
    }
    if (method === "GET" && p === "/v1/charges/ch_paid000001") {
      return Response.json({
        id: "ch_paid000001",
        amount_captured: options.captured ?? 5_000,
        amount_refunded: options.refunded ?? 1_000,
      });
    }
    if (method === "GET" && p === "/v1/customers/cus_alice00001")
      return Response.json({ id: "cus_alice00001" });
    if (method === "GET" && p === "/v1/customers/cus_gone000001")
      return Response.json({ id: "cus_gone000001", deleted: true });
    if (method === "GET")
      return Response.json(
        { error: { type: "invalid_request_error", code: "resource_missing" } },
        { status: 404 },
      );
    if (options.status !== undefined) {
      return Response.json(
        { error: { type: "card_error", code: "card_declined" } },
        { status: options.status },
      );
    }
    if (p === "/v1/refunds")
      return Response.json({ id: "re_1", amount: 1, currency: "usd", status: "succeeded" });
    if (p === "/v1/payment_intents")
      return Response.json({ id: "pi_new", amount: 1, currency: "usd", status: "succeeded" });
    return Response.json({ id: "x" });
  };
  return { fetch, sent };
}

function setUp(owner: string, stripe = fakeStripe()) {
  const t = testStore();
  const accountId = addAccount(t, "stripe", "stripe");
  const vault = Vault.open(t.db, { bytes: randomBytes(KEY_BYTES), source: "test" });
  vault.put(accountId, { type: "static", value: KEY });
  const { logger } = captureLogger();
  const pipeline = createPipeline({
    db: t.db,
    rules: { set: compileRules({ owner }) },
    definitions: definitionRegistry({
      upstream: new UpstreamPool({ vault: null, log: logger }),
      gmail: null,
      stripe: { vault, fetch: stripe.fetch },
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
    pipeline.run({ agent, surface: "mcp", account: "stripe", tool, args });
  return { call, sent: stripe.sent };
}

const SMALL_REFUNDS = `rules:
  - match: { action: stripe.refund, currency: usd, amount: { max: 5000 } }
    then: allow
  - match: { action: stripe.refund }
    then: ask
  - match: { action: stripe.payment.create, amount: { max: 2000 } }
    then: allow
`;

const posts = (sent: Sent[]) => sent.filter((s) => s.method === "POST");

describe("the Stripe definition", () => {
  it("refunds exactly what is left when no amount is given, and rules see it", async () => {
    const h = setUp(SMALL_REFUNDS);
    expect((await h.call("refund", { payment_intent: "pi_paid000001" })).status).toBe("allowed");
    const refund = posts(h.sent)[0];
    expect(refund?.path).toBe("/v1/refunds");
    expect(new URLSearchParams(refund?.body).get("amount")).toBe("4000");
  });

  it("asks for a refund over the rule's amount", async () => {
    const h = setUp(SMALL_REFUNDS, fakeStripe({ captured: 90_000, refunded: 0 }));
    expect((await h.call("refund", { payment_intent: "pi_paid000001" })).status).toBe("pending");
    expect(posts(h.sent)).toEqual([]);
  });

  it("refuses a refund larger than what is left", async () => {
    const h = setUp(SMALL_REFUNDS);
    expect(
      await h.call("refund", { payment_intent: "pi_paid000001", amount: 4_001 }),
    ).toMatchObject({
      reason: "unsupported",
    });
  });

  it("denies a payment intent that isn't there as not available", async () => {
    const h = setUp(SMALL_REFUNDS);
    expect(await h.call("refund", { payment_intent: "pi_missing0001" })).toEqual({
      status: "denied",
      reason: "not_available",
      rule: null,
    });
  });

  it("I-42: denies a customer Stripe says was deleted as not available", async () => {
    const h = setUp(SMALL_REFUNDS);
    expect(
      await h.call("create_payment", { amount: 100, currency: "usd", customer: "cus_gone000001" }),
    ).toEqual({ status: "denied", reason: "not_available", rule: null });
    expect(h.sent.map((s) => s.path)).toContain("/v1/customers/cus_gone000001");
    expect(posts(h.sent)).toEqual([]);
  });

  it("sends a fresh idempotency key and the pinned API version on every write", async () => {
    const h = setUp(SMALL_REFUNDS);
    await h.call("create_payment", { amount: 500, currency: "usd", customer: "cus_alice00001" });
    await h.call("create_payment", { amount: 500, currency: "usd", customer: "cus_alice00001" });
    const writes = posts(h.sent);
    expect(writes[0]?.idempotency).toMatch(/^heel-[0-9a-f-]{36}$/);
    expect(writes[1]?.idempotency).not.toBe(writes[0]?.idempotency);
    expect(h.sent.every((s) => s.version === "2026-10-28.endive")).toBe(true);
  });

  it("leaves a 424 unknown, since Stripe may have acted", async () => {
    const h = setUp(SMALL_REFUNDS, fakeStripe({ status: 424 }));
    expect(
      await h.call("create_payment", { amount: 100, currency: "usd", customer: "cus_alice00001" }),
    ).toEqual({ status: "upstream_outcome_unknown" });
  });

  it("lists payments only for a named customer", async () => {
    const h = setUp("rules:\n  - match: { action: stripe.read }\n    then: allow\n");
    expect(await h.call("list_payments", {})).toMatchObject({ reason: "unsupported" });
    expect((await h.call("list_payments", { customer: "cus_alice00001" })).status).toBe("allowed");
  });

  it("refuses a payment method that isn't the customer's", async () => {
    const h = setUp(SMALL_REFUNDS);
    expect(
      await h.call("create_payment", {
        amount: 100,
        currency: "usd",
        customer: "cus_alice00001",
        payment_method: "pm_bobscard0001",
        confirm: true,
      }),
    ).toMatchObject({ reason: "unsupported" });
    expect(posts(h.sent)).toEqual([]);
  });

  it("makes a new email the recipients of a customer update", async () => {
    const h = setUp(
      "rules:\n  - match: { action: stripe.customer.update, recipients: { all_domain_in: [example.com] } }\n    then: allow\n",
    );
    expect(
      (await h.call("update_customer", { customer: "cus_alice00001", email: "a@example.com" }))
        .status,
    ).toBe("allowed");
    expect(
      (await h.call("update_customer", { customer: "cus_alice00001", email: "a@evil.test" }))
        .status,
    ).toBe("denied");
  });

  it("denies a payment over the rule's amount", async () => {
    const h = setUp(SMALL_REFUNDS);
    expect(
      (
        await h.call("create_payment", {
          amount: 2_001,
          currency: "usd",
          customer: "cus_alice00001",
        })
      ).status,
    ).toBe("denied");
  });

  it("refuses to confirm a payment with no saved payment method", async () => {
    const h = setUp(SMALL_REFUNDS);
    expect(
      await h.call("create_payment", {
        amount: 100,
        currency: "usd",
        customer: "cus_alice00001",
        confirm: true,
      }),
    ).toMatchObject({ reason: "unsupported" });
  });

  it("reports a declined card as an upstream error, and a 409 as unknown", async () => {
    const declined = setUp(SMALL_REFUNDS, fakeStripe({ status: 402 }));
    expect(
      await declined.call("create_payment", {
        amount: 100,
        currency: "usd",
        customer: "cus_alice00001",
      }),
    ).toEqual({ status: "upstream_error", upstreamStatus: 402, body: { code: "card_declined" } });
    const conflict = setUp(SMALL_REFUNDS, fakeStripe({ status: 409 }));
    expect(
      await conflict.call("create_payment", {
        amount: 100,
        currency: "usd",
        customer: "cus_alice00001",
      }),
    ).toEqual({ status: "upstream_outcome_unknown" });
  });

  it.each([400, 403, 404, 429])("reports a write Stripe answers %i as refused", async (status) => {
    const h = setUp(SMALL_REFUNDS, fakeStripe({ status }));
    expect(
      await h.call("create_payment", { amount: 100, currency: "usd", customer: "cus_alice00001" }),
    ).toEqual({
      status: "upstream_error",
      upstreamStatus: status,
      body: { code: "card_declined" },
    });
  });

  it("leaves a 5xx write unknown", async () => {
    const h = setUp(SMALL_REFUNDS, fakeStripe({ status: 500 }));
    expect(
      await h.call("create_payment", { amount: 100, currency: "usd", customer: "cus_alice00001" }),
    ).toEqual({ status: "upstream_outcome_unknown" });
  });

  it("encodes nested parameters as Stripe reads them, in a fixed order", () => {
    expect(formEncode({ b: 1, a: "x", metadata: { k: "v" }, skip: undefined })).toBe(
      "a=x&b=1&metadata%5Bk%5D=v",
    );
  });

  it("refuses a rule whose amount isn't a number when it loads", () => {
    expect(() =>
      setUp(
        'rules:\n  - match: { action: stripe.refund, amount: { max: "5000" } }\n    then: allow\n',
      ),
    ).toThrow();
  });
});
