import { CredentialRejectedError, UpstreamError } from "../../gateway/pipeline/ports.ts";
import type { FetchFn } from "../sign-in.ts";
import { NotFoundError } from "../tool-table.ts";
export const GITHUB_API = "https://api.github.com";

/**
 * GitHub's REST API with the account's token. Reads that come back
 * 404 are `NotFoundError`, so a missing target is denied like a hidden
 * one. A write GitHub answered with a 4xx is an `UpstreamError`: nothing
 * happened. A 5xx, or no answer, leaves the outcome unknown; heel never
 * retries a write.
 */

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export class GitHubClient {
  readonly #fetch: FetchFn;
  readonly #token: () => Promise<string>;

  constructor(fetch: FetchFn, token: () => Promise<string>) {
    this.#fetch = fetch;
    this.#token = token;
  }

  async request(
    method: Method,
    path: string,
    signal: AbortSignal,
    options: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
      accept?: string;
    } = {},
  ): Promise<unknown> {
    const url = new URL(path, GITHUB_API);
    if (url.origin !== GITHUB_API) throw new Error("the request left GitHub's API");
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const response = await this.#fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${await this.#token()}`,
        accept: options.accept ?? "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      redirect: "error",
      signal,
    });
    const text = await response.text();
    let body: unknown = text;
    if ((response.headers.get("content-type") ?? "").includes("json")) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (response.ok) return body;
    // A bad token: GitHub turned it down before doing anything.
    if (response.status === 401) throw new CredentialRejectedError("GitHub");
    if (method === "GET") {
      if (response.status === 404) throw new NotFoundError(`${path} not found`);
      throw new Error(`GitHub answered ${response.status} for ${path}`);
    }
    // A 4xx means GitHub refused it and nothing happened; a 5xx may have done it.
    if (response.status >= 400 && response.status < 500) {
      throw new UpstreamError(response.status, body);
    }
    throw new Error(`GitHub answered ${response.status} for a write; the outcome is unknown`);
  }

  get(path: string, signal: AbortSignal, query?: Record<string, string | number | undefined>) {
    return this.request("GET", path, signal, query === undefined ? {} : { query });
  }
}
