import type { FetchFn } from "../sign-in.ts";

/**
 * Notion's REST API with the account's integration token (D12b;
 * https://developers.notion.com/reference). heel pins the API version it
 * was written against, `Notion-Version: 2026-03-11`.
 *
 * Error answers (https://developers.notion.com/reference/status-codes): a 404
 * `object_not_found` on a read is `NotionNotFoundError`; on a write, a 4xx
 * (validation, conflict, rate limit, restricted) is a refusal, nothing
 * changed. A 5xx, or no answer, leaves a write's outcome unknown; heel never
 * retries one.
 */

export const NOTION_API = "https://api.notion.com";
export const NOTION_VERSION = "2026-03-11";

export class NotionNotFoundError extends Error {
  override readonly name = "NotionNotFoundError";
}

export class NotionRefused extends Error {
  override readonly name = "NotionRefused";
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(`Notion refused the change (${status} ${code})`);
    this.status = status;
    this.code = code;
  }
}

/** Error codes Notion raises before changing anything (https://developers.notion.com/reference/status-codes). */
const REFUSED = new Set([
  "invalid_json",
  "invalid_request_url",
  "invalid_request",
  "invalid_grant",
  "validation_error",
  "missing_version",
  "unauthorized",
  "restricted_resource",
  "object_not_found",
  "conflict_error",
  "rate_limited",
]);

export class NotionClient {
  readonly #fetch: FetchFn;
  readonly #token: () => Promise<string>;

  constructor(fetch: FetchFn, token: () => Promise<string>) {
    this.#fetch = fetch;
    this.#token = token;
  }

  async request(
    method: "GET" | "POST" | "PATCH",
    path: string,
    signal: AbortSignal,
    body?: unknown,
    query?: Record<string, string | number | undefined>,
  ): Promise<Record<string, unknown>> {
    const url = new URL(path, NOTION_API);
    if (url.origin !== NOTION_API) throw new Error("the request left Notion's API");
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const response = await this.#fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${await this.#token()}`,
        "notion-version": NOTION_VERSION,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal,
    });
    let parsed: Record<string, unknown> = {};
    try {
      parsed = (await response.json()) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    if (response.ok) return parsed;
    const code = typeof parsed["code"] === "string" ? parsed["code"] : "error";
    if (method === "GET" || path === "/v1/search") {
      if (response.status === 404) throw new NotionNotFoundError(`${path}: ${code}`);
      throw new Error(`Notion answered ${response.status} ${code} for ${path}`);
    }
    // Only Notion's own error codes mean it refused before acting; anything else (a proxy's 408) is unknown.
    if (REFUSED.has(code)) throw new NotionRefused(response.status, code);
    throw new Error(`Notion answered ${response.status} for a write; the outcome is unknown`);
  }
}
