import { randomUUID } from "node:crypto";
import { CredentialRejectedError } from "../../gateway/pipeline/ports.ts";
import type { FetchFn } from "../sign-in.ts";

/**
 * Stripe's REST API with the account's secret or restricted key (D12b;
 * https://docs.stripe.com/api). Requests are form-encoded, as Stripe takes
 * them (https://docs.stripe.com/api/request_ids, /api/errors).
 *
 * - Every request is pinned to `Stripe-Version: 2026-10-28.endive`
 *   (docs/design/research-provider-api-verification.md §7), so what rules
 *   see doesn't depend on the account's default version.
 * - Every write carries a fresh `Idempotency-Key`
 *   (https://docs.stripe.com/api/idempotent_requests). heel never retries,
 *   so a key derived from the parameters would only make Stripe replay an
 *   earlier answer to a later, deliberate call (an email set back, a decline
 *   cached for 24 hours) and report it as new.
 * - Errors: a 404 on a read is `StripeNotFoundError`. On a write, only 400,
 *   401, 402, 403, 404 and 429 mean Stripe refused before acting
 *   (https://docs.stripe.com/error-low-level): `StripeRefused`. Anything
 *   else (409, 424, 5xx, no answer, a 200 heel can't read) leaves the
 *   outcome unknown.
 */

export const STRIPE_API = "https://api.stripe.com";
export const STRIPE_VERSION = "2026-10-28.endive";

/** Write statuses Stripe answers before acting. */
const REFUSED = new Set([400, 401, 402, 403, 404, 429]);

export class StripeNotFoundError extends Error {
  override readonly name = "StripeNotFoundError";
}

export class StripeRefused extends Error {
  override readonly name = "StripeRefused";
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(`Stripe refused the request (${status} ${code})`);
    this.status = status;
    this.code = code;
  }
}

type Params = Record<string, string | number | boolean | undefined | Record<string, string>>;

/** Stripe's form encoding: `a=1&metadata[k]=v`, keys in a fixed order. */
export function formEncode(params: Params): string {
  const out = new URLSearchParams();
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (value === undefined) continue;
    if (typeof value === "object") {
      for (const sub of Object.keys(value).sort())
        out.append(`${key}[${sub}]`, value[sub] as string);
    } else {
      out.append(key, String(value));
    }
  }
  return out.toString();
}

export class StripeClient {
  readonly #fetch: FetchFn;
  readonly #token: () => Promise<string>;
  constructor(fetch: FetchFn, token: () => Promise<string>) {
    this.#fetch = fetch;
    this.#token = token;
  }

  async request(
    method: "GET" | "POST",
    path: string,
    params: Params,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const url = new URL(path, STRIPE_API);
    if (url.origin !== STRIPE_API) throw new Error("the request left Stripe's API");
    const encoded = formEncode(params);
    if (method === "GET" && encoded !== "") url.search = encoded;
    const key = method === "POST" ? `heel-${randomUUID()}` : undefined;
    const response = await this.#fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${await this.#token()}`,
        "stripe-version": STRIPE_VERSION,
        ...(method === "POST"
          ? {
              "content-type": "application/x-www-form-urlencoded",
              "idempotency-key": key as string,
            }
          : {}),
      },
      ...(method === "POST" ? { body: encoded } : {}),
      redirect: "error",
      signal,
    });
    let body: Record<string, unknown> | null = null;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      body = null;
    }
    if (response.ok) {
      // A write that answered 200 happened; an answer heel can't read leaves what it did unknown.
      if (body === null || typeof body !== "object")
        throw new Error("Stripe's answer isn't readable");
      return body;
    }
    // A bad key: Stripe turned it down before doing anything.
    if (response.status === 401) throw new CredentialRejectedError("Stripe");
    body ??= {};
    const error = (body["error"] ?? {}) as { code?: unknown; type?: unknown };
    const code = String(error.code ?? error.type ?? "error");
    if (method === "GET") {
      if (response.status === 404) throw new StripeNotFoundError(`${path}: ${code}`);
      throw new Error(`Stripe answered ${response.status} ${code} for ${path}`);
    }
    if (REFUSED.has(response.status)) throw new StripeRefused(response.status, code);
    throw new Error(`Stripe answered ${response.status} for a write; the outcome is unknown`);
  }
}
