import type { Tool } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type Definition, UpstreamError } from "../../gateway/pipeline/ports.ts";
import type { AccountRecord } from "../../store/directory.ts";
import type { Vault } from "../../vault/vault.ts";
import { listedTools, type MailTool, mailDefinition } from "../mail/tool.ts";
import type { FetchFn } from "../sign-in.ts";
import { StripeClient, StripeNotFoundError, StripeRefused } from "./client.ts";

/**
 * The Stripe definition: heel's own tools on Stripe's API
 * (https://docs.stripe.com/api),
 * connected with `heel connect stripe --credential-stdin` (a secret or,
 * better, a restricted key).
 *
 * - Actions: `stripe.read`, `stripe.refund`, `stripe.payment.create`,
 *   `stripe.customer.update` and `stripe.subscription.update`.
 * - Rules see `amount` (in the currency's smallest unit), `currency` and
 *   `customer`, read from Stripe before any rule.
 * - A refund always names its amount: with none given, heel reads what is
 *   left to refund and sends exactly that, so Stripe's own "the rest" default
 *   can never refund more than rules saw. More than what is left is refused.
 * - `list_payments` names its customer: an unfiltered list would show every
 *   customer's payments past a rule that denies reads on one.
 * - A customer's new email is that update's `recipients`: Stripe sends
 *   receipts and invoices there from then on.
 * - A payment's saved payment method must belong to its customer.
 * - heel offers no tool for webhook endpoints or API keys, which outlive
 *   revoking heel (I-70).
 *
 * Endpoints: GET /v1/payment_intents, GET /v1/payment_intents/{id},
 * GET /v1/charges/{id}, GET /v1/customers/{id}, GET /v1/subscriptions/{id},
 * POST /v1/refunds, POST /v1/payment_intents, POST /v1/customers/{id},
 * POST /v1/subscriptions/{id}.
 */

export interface StripeDeps {
  vault: Vault;
  fetch: FetchFn;
}

interface Box {
  client: StripeClient;
}

type StripeTool = MailTool<Box>;
const tool = <S extends z.ZodType, P, R>(t: MailTool<Box, S, P, R>) => t as unknown as StripeTool;

const id = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9]{6,64}$`), `expected a ${prefix}_ id`);
const PaymentIntent = id("pi");
const Customer = id("cus");
const Subscription = id("sub");
const PaymentMethod = id("pm");
const Currency = z
  .string()
  .regex(/^[A-Za-z]{3}$/, "expected a three-letter currency code")
  .transform((c) => c.toLowerCase());
const Amount = z.number().int().min(1).max(99_999_999);
const Limit = z.number().int().min(1).max(100).default(25);

const str = (v: unknown) => (typeof v === "string" ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);
const customerOf = (v: unknown) =>
  typeof v === "string" ? v : str((v as { id?: unknown } | null)?.id);

async function customerExists(box: Box, customer: string, signal: AbortSignal) {
  const c = await box.client.request("GET", `/v1/customers/${customer}`, {}, signal);
  if (c["id"] !== customer || c["deleted"] === true) throw new StripeNotFoundError(customer);
}

const shownPayment = (p: Record<string, unknown>) => ({
  id: p["id"],
  amount: p["amount"],
  amount_received: p["amount_received"] ?? null,
  currency: p["currency"],
  status: p["status"],
  customer: customerOf(p["customer"]),
  description: p["description"] ?? null,
});

const TOOLS: Record<string, StripeTool> = {
  list_payments: tool({
    returns:
      '{"payments": [{"id", "amount", "amount_received", "currency", "status", "customer", "description"}, ...], "has_more"}',
    description: "List a customer's payments (payment intents), newest first.",
    args: z.strictObject({
      customer: Customer,
      limit: Limit,
      starting_after: PaymentIntent.optional(),
    }),
    readOnly: true,
    prepare: async (_box, args) => ({
      args,
      action: "stripe.read",
      fields: { customer: args.customer },
    }),
    run: (box, a, signal) =>
      box.client.request(
        "GET",
        "/v1/payment_intents",
        { customer: a.customer, limit: a.limit, starting_after: a.starting_after },
        signal,
      ),
    show: async (_box, body: Record<string, unknown>) => ({
      payments: Array.isArray(body["data"])
        ? (body["data"] as Record<string, unknown>[]).map(shownPayment)
        : [],
      has_more: body["has_more"] === true,
    }),
  }),

  get_customer: tool({
    returns: '{"id", "email", "name", "description", "deleted"}',
    description: "Read a customer.",
    args: z.strictObject({ customer: Customer }),
    readOnly: true,
    prepare: async (_box, args) => ({
      args,
      action: "stripe.read",
      fields: { customer: args.customer },
      targets: [args.customer],
    }),
    run: (box, a, signal) => box.client.request("GET", `/v1/customers/${a.customer}`, {}, signal),
    show: async (_box, c: Record<string, unknown>) => ({
      id: c["id"],
      email: c["email"] ?? null,
      name: c["name"] ?? null,
      description: c["description"] ?? null,
      deleted: c["deleted"] === true,
    }),
  }),

  refund: tool({
    returns: '{"id", "amount", "currency", "status"}',
    description:
      "Refund a payment, in part or in full. Without an amount, heel refunds exactly what is left to refund.",
    args: z.strictObject({
      payment_intent: PaymentIntent,
      amount: Amount.optional(),
      reason: z.enum(["duplicate", "fraudulent", "requested_by_customer"]).optional(),
    }),
    readOnly: false,
    prepare: async (box, args, _h, signal) => {
      const pi = await box.client.request(
        "GET",
        `/v1/payment_intents/${args.payment_intent}`,
        {},
        signal,
      );
      const chargeId = str(pi["latest_charge"]);
      const currency = str(pi["currency"]);
      if (pi["id"] !== args.payment_intent || chargeId === null || currency === null) {
        return { deny: "unsupported" };
      }
      const charge = await box.client.request("GET", `/v1/charges/${chargeId}`, {}, signal);
      const captured = num(charge["amount_captured"]);
      const refunded = num(charge["amount_refunded"]);
      if (captured === null || refunded === null) return { deny: "lookup_unavailable" };
      const left = captured - refunded;
      const amount = args.amount ?? left;
      if (amount < 1 || amount > left) return { deny: "unsupported" };
      const customer = customerOf(pi["customer"]);
      return {
        args: { ...args, amount },
        action: "stripe.refund",
        targets: [args.payment_intent],
        fields: {
          amount,
          currency: currency.toLowerCase(),
          ...(customer === null ? {} : { customer }),
        },
      };
    },
    run: (box, a, signal) =>
      box.client.request(
        "POST",
        "/v1/refunds",
        { payment_intent: a.payment_intent, amount: a.amount, reason: a.reason },
        signal,
      ),
    show: async (_box, r: Record<string, unknown>) => ({
      id: r["id"],
      amount: r["amount"],
      currency: r["currency"],
      status: r["status"],
    }),
  }),

  create_payment: tool({
    returns: '{"id", "amount", "amount_received", "currency", "status", "customer", "description"}',
    description:
      "Create a payment for a customer. With confirm and a saved payment method, Stripe charges it now, without the customer present.",
    args: z.strictObject({
      amount: Amount,
      currency: Currency,
      customer: Customer,
      payment_method: PaymentMethod.optional(),
      confirm: z.boolean().default(false),
      description: z.string().max(1_000).optional(),
    }),
    readOnly: false,
    prepare: async (box, args, _h, signal) => {
      if (args.confirm && args.payment_method === undefined) return { deny: "unsupported" };
      await customerExists(box, args.customer, signal);
      if (args.payment_method !== undefined) {
        const pm = await box.client.request(
          "GET",
          `/v1/payment_methods/${args.payment_method}`,
          {},
          signal,
        );
        if (customerOf(pm["customer"]) !== args.customer) return { deny: "unsupported" };
      }
      return {
        args,
        action: "stripe.payment.create",
        fields: { amount: args.amount, currency: args.currency, customer: args.customer },
      };
    },
    run: (box, a, signal) =>
      box.client.request(
        "POST",
        "/v1/payment_intents",
        {
          amount: a.amount,
          currency: a.currency,
          customer: a.customer,
          payment_method: a.payment_method,
          description: a.description,
          ...(a.confirm ? { confirm: true, off_session: true } : {}),
        },
        signal,
      ),
    show: async (_box, p: Record<string, unknown>) => shownPayment(p),
  }),

  update_customer: tool({
    returns: '{"id", "email", "name"}',
    description: "Change a customer's email, name or description.",
    args: z.strictObject({
      customer: Customer,
      email: z.email().max(512).optional(),
      name: z.string().max(256).optional(),
      description: z.string().max(1_000).optional(),
    }),
    readOnly: false,
    prepare: async (box, args, _h, signal) => {
      await customerExists(box, args.customer, signal);
      return {
        args,
        action: "stripe.customer.update",
        fields: { customer: args.customer },
        targets: [args.customer],
        // Receipts and invoices go to the new address from now on.
        ...(args.email === undefined ? {} : { recipients: [args.email.toLowerCase()] }),
      };
    },
    run: (box, { customer, ...change }, signal) =>
      box.client.request("POST", `/v1/customers/${customer}`, change, signal),
    show: async (_box, c: Record<string, unknown>) => ({
      id: c["id"],
      email: c["email"] ?? null,
      name: c["name"] ?? null,
    }),
  }),

  set_subscription_cancellation: tool({
    returns: '{"id", "status", "cancel_at_period_end"}',
    description:
      "Cancel a subscription at the end of its current period, or undo that. Nothing is cancelled at once.",
    args: z.strictObject({ subscription: Subscription, cancel_at_period_end: z.boolean() }),
    readOnly: false,
    prepare: async (box, args, _h, signal) => {
      const sub = await box.client.request(
        "GET",
        `/v1/subscriptions/${args.subscription}`,
        {},
        signal,
      );
      const customer = customerOf(sub["customer"]);
      if (sub["id"] !== args.subscription || customer === null)
        return { deny: "lookup_unavailable" };
      return {
        args,
        action: "stripe.subscription.update",
        fields: {
          customer,
          ...(str(sub["currency"]) === null
            ? {}
            : { currency: String(sub["currency"]).toLowerCase() }),
        },
        targets: [args.subscription],
      };
    },
    run: (box, a, signal) =>
      box.client.request(
        "POST",
        `/v1/subscriptions/${a.subscription}`,
        { cancel_at_period_end: a.cancel_at_period_end },
        signal,
      ),
    show: async (_box, s: Record<string, unknown>) => ({
      id: s["id"],
      status: s["status"],
      cancel_at_period_end: s["cancel_at_period_end"] === true,
    }),
  }),
};

export const STRIPE_TOOLS: readonly Tool[] = listedTools(TOOLS);

export function stripeDefinition(account: AccountRecord, deps: StripeDeps): Definition {
  const token = async () => (await deps.vault.accessToken(account.id)).reveal();
  return mailDefinition({
    tools: TOOLS,
    listed: STRIPE_TOOLS,
    mailbox: { client: new StripeClient(deps.fetch, token) },
    errors: {
      isNotFound: (error) => error instanceof StripeNotFoundError,
      refusal: (error) =>
        error instanceof StripeRefused
          ? new UpstreamError(error.status, { code: error.code })
          : null,
    },
    stateCheck: async () => "fail",
  });
}
