import { CredentialRejectedError, UpstreamError } from "../../gateway/pipeline/ports.ts";
import type { FetchFn } from "../sign-in.ts";
import { NotFoundError } from "../tool-table.ts";

/**
 * The Slack Web API with the account's token. Every method answers
 * HTTP 200 with `{ ok: false, error }` when it refuses
 * (https://docs.slack.dev/apis/web-api/#responses). On a write, only the
 * errors listed in `NOTHING_HAPPENED` count as a refusal; Slack documents
 * that others (`internal_error`, `fatal_error`) may follow a partial
 * success, so those leave the outcome unknown. A 429 is a refusal too. A read that names something missing (`channel_not_found`,
 * `message_not_found`, `thread_not_found`) is `NotFoundError`. Anything
 * else, a non-200 or no answer, leaves a write's outcome unknown; heel never
 * retries one.
 */

export const SLACK_API = "https://slack.com/api/";

/** Slack's answers to a token that's wrong, expired or revoked: nothing ran. */
const KEY_REJECTED = new Set([
  "not_authed",
  "invalid_auth",
  "account_inactive",
  "token_revoked",
  "token_expired",
]);

const NOT_FOUND = new Set(["channel_not_found", "message_not_found", "thread_not_found"]);

/** Write errors Slack raises before it acts (docs.slack.dev, each method's "Errors"). */
const NOTHING_HAPPENED = new Set([
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "msg_too_long",
  "no_text",
  "too_many_attachments",
  "restricted_action",
  "restricted_action_read_only_channel",
  "restricted_action_thread_only_channel",
  "restricted_action_non_threadable_channel",
  "cant_update_message",
  "cant_delete_message",
  "edit_window_closed",
  "message_not_found",
  "thread_not_found",
  "time_in_past",
  "time_too_far",
  "invalid_time",
  "ratelimited",
  "rate_limited",
  "not_authed",
  "invalid_auth",
  "account_inactive",
  "token_revoked",
  "missing_scope",
  "not_allowed_token_type",
  "invalid_arguments",
  "invalid_arg_name",
  "invalid_blocks",
  "duplicate_channel_not_found",
]);

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
    // Rate limited: Slack did nothing (https://docs.slack.dev/apis/web-api/rate-limits).
    if (response.status === 429 && write) throw new UpstreamError(429, { error: "ratelimited" });
    if (response.status !== 200) {
      throw new Error(`Slack answered ${response.status} for ${method}`);
    }
    const body = (await response.json()) as Record<string, unknown>;
    if (body["ok"] === true) return body;
    const error = typeof body["error"] === "string" ? body["error"] : "unknown_error";
    // A bad token: Slack turned it down before doing anything.
    if (KEY_REJECTED.has(error)) throw new CredentialRejectedError("Slack");
    if (!write && NOT_FOUND.has(error)) throw new NotFoundError(`${method}: ${error}`);
    if (!write) throw new Error(`Slack refused ${method}: ${error}`);
    if (NOTHING_HAPPENED.has(error)) throw new UpstreamError(400, { error });
    throw new Error(`Slack answered ${method} with ${error}; it may have taken effect`);
  }
}
