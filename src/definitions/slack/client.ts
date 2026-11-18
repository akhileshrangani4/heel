import type { FetchFn } from "../sign-in.ts";

/**
 * The Slack Web API with the account's token (D12b). Every method answers
 * HTTP 200 with `{ ok: false, error }` when it refuses
 * (https://api.slack.com/web#responses); heel reads that as a refusal, so
 * nothing happened. A read that names something missing (`channel_not_found`,
 * `message_not_found`, `thread_not_found`) is `SlackNotFoundError`. Anything
 * else, a non-200 or no answer, leaves a write's outcome unknown; heel never
 * retries one.
 */

export const SLACK_API = "https://slack.com/api/";

export class SlackNotFoundError extends Error {
  override readonly name = "SlackNotFoundError";
}

export class SlackRefused extends Error {
  override readonly name = "SlackRefused";
  readonly error: string;

  constructor(method: string, error: string) {
    super(`Slack refused ${method}: ${error}`);
    this.error = error;
  }
}

const NOT_FOUND = new Set(["channel_not_found", "message_not_found", "thread_not_found"]);

export class SlackClient {
  readonly #fetch: FetchFn;
  readonly #token: () => Promise<string>;

  constructor(fetch: FetchFn, token: () => Promise<string>) {
    this.#fetch = fetch;
    this.#token = token;
  }

  /**
   * Calls one Web API method. Reads go as a GET with query parameters, writes
   * as a POST with a JSON body (https://api.slack.com/web#posting_json).
   */
  async call(
    method: string,
    params: Record<string, string | number | boolean | undefined>,
    signal: AbortSignal,
    write = false,
  ): Promise<Record<string, unknown>> {
    if (!/^[a-z]+\.[A-Za-z.]+$/.test(method)) throw new Error(`not a Slack method: ${method}`);
    const url = new URL(method, SLACK_API);
    const defined = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));
    if (!write) {
      for (const [key, value] of Object.entries(defined)) url.searchParams.set(key, String(value));
    }
    const response = await this.#fetch(url, {
      method: write ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${await this.#token()}`,
        ...(write ? { "content-type": "application/json; charset=utf-8" } : {}),
      },
      ...(write ? { body: JSON.stringify(defined) } : {}),
      redirect: "error",
      signal,
    });
    if (response.status !== 200) {
      throw new Error(`Slack answered ${response.status} for ${method}`);
    }
    const body = (await response.json()) as Record<string, unknown>;
    if (body["ok"] === true) return body;
    const error = typeof body["error"] === "string" ? body["error"] : "unknown_error";
    if (!write && NOT_FOUND.has(error)) throw new SlackNotFoundError(`${method}: ${error}`);
    if (!write) throw new Error(`Slack refused ${method}: ${error}`);
    throw new SlackRefused(method, error);
  }
}
