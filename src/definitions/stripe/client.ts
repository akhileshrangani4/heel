import { createHash } from "node:crypto";
import type { FetchFn } from "../sign-in.ts";

/**
 * Stripe's REST API with the account's secret or restricted key (D12b;
 * https://docs.stripe.com/api). Requests are form-encoded, as Stripe takes
 * them (https://docs.stripe.com/api/request_ids, /api/errors).
 *
 * - Every write carries an `Idempotency-Key` derived from the account, the
 *   method, the path and the exact parameters
 *   (https://docs.stripe.com/api/idempotent_requests). The same write sent
 *   again within Stripe's 24-hour window returns the first result instead
 *   of charging or refunding twice; a different one gets a different key.
 * - Errors: a 404 on a read is `StripeNotFoundError`. On a write, a 4xx
 *   other than 409 (Stripe's idempotency conflict, or a lock) means Stripe
 *   refused it before acting: `StripeRefused`. A 409, a 5xx or no answer
 *   leaves the outcome unknown; heel never retries.
 */

export const STRIPE_API = "https://api.stripe.com";

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
  readonly #accountId: string;

  constructor(fetch: FetchFn, token: () => Promise<string>, accountId: string) {
    this.#fetch = fetch;
    this.#token = token;
    this.#accountId = accountId;
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
    const key =
      method === "POST"
        ? `heel-${createHash("sha256").update(`${this.#accountId}\n${path}\n${encoded}`).digest("hex")}`
        : undefined;
    const response = await this.#fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${await this.#token()}`,
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
    let body: Record<string, unknown> = {};
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    if (response.ok) return body;
    const error = (body["error"] ?? {}) as { code?: unknown; type?: unknown };
    const code = String(error.code ?? error.type ?? "error");
    if (method === "GET") {
      if (response.status === 404) throw new StripeNotFoundError(`${path}: ${code}`);
      throw new Error(`Stripe answered ${response.status} ${code} for ${path}`);
    }
    if (response.status >= 400 && response.status < 500 && response.status !== 409) {
      throw new StripeRefused(response.status, code);
    }
    throw new Error(`Stripe answered ${response.status} for a write; the outcome is unknown`);
  }
}
