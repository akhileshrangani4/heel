import { CredentialRejectedError, UpstreamError } from "../../gateway/pipeline/ports.ts";
import type { FetchFn } from "../sign-in.ts";
import { NotFoundError } from "../tool-table.ts";

/**
 * Linear's GraphQL API with the account's credential
 * (https://linear.app/developers/graphql). A personal API key (`lin_api_...`)
 * is sent as `Authorization: <key>`, an OAuth access token as
 * `Authorization: Bearer <token>`.
 *
 * GraphQL answers errors with HTTP 200 and an `errors` list. On a read that
 * names something missing (`Entity not found`) it is `NotFoundError`;
 * on a mutation with no data, Linear rejected it before acting (`refused`).
 * Anything else, a non-200 or no answer, leaves a write's outcome unknown;
 * heel never retries one.
 */

export const LINEAR_API = "https://api.linear.app/graphql";

/** Linear turned a change down before acting. GraphQL has no status of its own, so it's a 400. */
export function refused(messages: string[]): UpstreamError {
  return new UpstreamError(400, { errors: messages });
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
    // A bad key: Linear answers 400 with an authentication error, or 401, before doing anything.
    if (response.status === 400 || response.status === 401) {
      const answer = (await response.json().catch(() => null)) as { errors?: unknown } | null;
      if (response.status === 401 || isAuthenticationError(answer?.errors)) {
        throw new CredentialRejectedError("Linear");
      }
    }
    if (response.status !== 200) {
      // Rate limited: Linear rejects before running anything
      // (https://linear.app/developers/rate-limiting).
      if (write && response.status === 429) throw refused(["rate limited"]);
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
      throw new NotFoundError(errors.join("; "));
    // A mutation whose result is null throughout was rejected; any data alongside errors leaves it unknown.
    if (write && (data === null || Object.values(data).every((v) => v === null))) {
      throw refused(errors);
    }
    throw new Error(`Linear answered with errors: ${errors.join("; ")}`);
  }
}

/** Pure: whether Linear's GraphQL errors say the key wasn't accepted. */
function isAuthenticationError(errors: unknown): boolean {
  if (!Array.isArray(errors)) return false;
  return errors.some((e) => {
    const error = e as { extensions?: { code?: unknown; type?: unknown } };
    return /authentication/i.test(
      `${error.extensions?.code ?? ""} ${error.extensions?.type ?? ""}`,
    );
  });
}
