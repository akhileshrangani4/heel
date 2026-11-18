import type { FetchFn } from "../sign-in.ts";

/**
 * Linear's GraphQL API with the account's credential (D12b;
 * https://linear.app/developers/graphql). A personal API key (`lin_api_...`)
 * is sent as `Authorization: <key>`, an OAuth access token as
 * `Authorization: Bearer <token>`.
 *
 * GraphQL answers errors with HTTP 200 and an `errors` list. On a read that
 * names something missing (`Entity not found`) it is `LinearNotFoundError`;
 * on a mutation with no data, Linear rejected it before acting, which is
 * `LinearRefused`. Anything else, a non-200 or no answer, leaves a write's
 * outcome unknown; heel never retries one.
 */

export const LINEAR_API = "https://api.linear.app/graphql";

export class LinearNotFoundError extends Error {
  override readonly name = "LinearNotFoundError";
}

export class LinearRefused extends Error {
  override readonly name = "LinearRefused";
  readonly messages: string[];

  constructor(messages: string[]) {
    super(`Linear refused the change: ${messages.join("; ")}`);
    this.messages = messages;
  }
}

export class LinearClient {
  readonly #fetch: FetchFn;
  readonly #token: () => Promise<string>;

  constructor(fetch: FetchFn, token: () => Promise<string>) {
    this.#fetch = fetch;
    this.#token = token;
  }

  async request(
    query: string,
    variables: Record<string, unknown>,
    signal: AbortSignal,
    write = false,
  ): Promise<Record<string, unknown>> {
    const token = await this.#token();
    const response = await this.#fetch(new URL(LINEAR_API), {
      method: "POST",
      headers: {
        authorization: token.startsWith("lin_api_") ? token : `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      redirect: "error",
      signal,
    });
    if (response.status !== 200) {
      // A 400 on a query is GraphQL rejecting the request before running it.
      if (write && response.status === 400) throw new LinearRefused([`HTTP ${response.status}`]);
      throw new Error(`Linear answered ${response.status}`);
    }
    const body = (await response.json()) as {
      data?: Record<string, unknown> | null;
      errors?: unknown;
    };
    const errors = Array.isArray(body.errors)
      ? (body.errors as { message?: unknown }[]).map((e) => String(e.message ?? "error"))
      : [];
    const data = body.data ?? null;
    if (errors.length === 0 && data !== null) return data;
    if (!write && errors.some((m) => /not found/i.test(m)))
      throw new LinearNotFoundError(errors.join("; "));
    // A mutation that returned no data didn't happen; one that returned data alongside errors might have.
    if (write && (data === null || Object.values(data).every((v) => v === null))) {
      throw new LinearRefused(errors);
    }
    throw new Error(`Linear answered with errors: ${errors.join("; ")}`);
  }
}
