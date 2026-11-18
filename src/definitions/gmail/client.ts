import { z } from "zod";
import { type FetchFn, GMAIL_API_BASE } from "../google/oauth.ts";

/**
 * The few Gmail API reads heel needs (Gmail API v1 reference, rev 20261106;
 * research §2.1). Every method takes the call's signal. GETs are retried
 * once on 429 and 5xx; heel never retries a POST, since a send that timed
 * out may have gone.
 *
 * Response shapes are parsed with zod and unknown fields ignored, so a
 * Gmail addition never breaks a read, and a missing field never passes as
 * an empty one.
 */

const HeaderSchema = z.object({ name: z.string(), value: z.string() });

export interface GmailPart {
  mimeType: string;
  filename?: string | undefined;
  headers?: { name: string; value: string }[] | undefined;
  body?:
    | { size?: number | undefined; data?: string | undefined; attachmentId?: string | undefined }
    | undefined;
  parts?: GmailPart[] | undefined;
}

const PartSchema: z.ZodType<GmailPart> = z.lazy(() =>
  z.object({
    mimeType: z.string(),
    filename: z.string().optional(),
    headers: z.array(HeaderSchema).optional(),
    body: z
      .object({
        size: z.number().optional(),
        data: z.string().optional(),
        attachmentId: z.string().optional(),
      })
      .optional(),
    parts: z.array(PartSchema).optional(),
  }),
);

export const MessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).default([]),
  snippet: z.string().default(""),
  internalDate: z.string().optional(),
  payload: PartSchema,
});
export type GmailMessage = z.output<typeof MessageSchema>;

const ListSchema = z.object({
  messages: z.array(z.object({ id: z.string(), threadId: z.string() })).default([]),
  nextPageToken: z.string().optional(),
});

const ThreadSchema = z.object({ id: z.string(), messages: z.array(MessageSchema).default([]) });
export type GmailThread = z.output<typeof ThreadSchema>;

const LabelsSchema = z.object({
  labels: z
    .array(z.object({ id: z.string(), name: z.string(), type: z.string().optional() }))
    .default([]),
});
export type GmailLabel = z.output<typeof LabelsSchema>["labels"][number];

const RawMessageSchema = z.object({ id: z.string(), threadId: z.string(), raw: z.string() });
export type GmailRawMessage = z.output<typeof RawMessageSchema>;

const DraftSchema = z.object({ id: z.string(), message: RawMessageSchema });
export type GmailDraft = z.output<typeof DraftSchema>;

const SentSchema = z.object({ id: z.string(), threadId: z.string() });
const DraftRefSchema = z.object({
  id: z.string(),
  message: z.object({ id: z.string(), threadId: z.string() }),
});

const SendAsSchema = z.object({
  sendAs: z
    .array(
      z.object({
        sendAsEmail: z.string(),
        isPrimary: z.boolean().optional(),
        verificationStatus: z.string().optional(),
      }),
    )
    .default([]),
});

/**
 * How much of a message to read. `metadata` gives headers and labels only;
 * `full` adds the body, which only `looks_like` and the message tools need.
 */
export type MessageFormat = "metadata" | "full";

/** The headers heel reads in `metadata` format. */
export const METADATA_HEADERS = [
  "From",
  "To",
  "Cc",
  "Bcc",
  "Subject",
  "Date",
  "Reply-To",
  "Message-ID",
  "References",
] as const;

/** Gmail answered 404: the message or thread doesn't exist, or isn't this mailbox's. */
export class GmailNotFoundError extends Error {
  override readonly name = "GmailNotFoundError";
}

/** Gmail answered with another error, or with a body that didn't parse. */
export class GmailError extends Error {
  override readonly name = "GmailError";
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const RETRYABLE = (status: number) => status === 429 || status >= 500;

/** Gmail refused a write. The write did not happen, so the call's outcome is known. */
export class GmailWriteRefused extends Error {
  override readonly name = "GmailWriteRefused";
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    super(`Gmail refused the write (${status})`);
    this.status = status;
    this.body = body;
  }
}

export class GmailClient {
  readonly #fetch: FetchFn;
  readonly #token: () => Promise<string>;

  /** `token` returns a fresh access token (the vault refreshes it). */
  constructor(fetch: FetchFn, token: () => Promise<string>) {
    this.#fetch = fetch;
    this.#token = token;
  }

  async #get<T>(
    path: string,
    query: [string, string][],
    schema: z.ZodType<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const url = new URL(path, GMAIL_API_BASE);
    for (const [key, value] of query) url.searchParams.append(key, value);
    let response: Response | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      response = await this.#fetch(url, {
        headers: { authorization: `Bearer ${await this.#token()}`, accept: "application/json" },
        signal,
      });
      if (!RETRYABLE(response.status)) break;
    }
    if (response === null) throw new GmailError(0, "no response");
    if (response.status === 404) throw new GmailNotFoundError(`${path} was not found`);
    if (!response.ok) throw new GmailError(response.status, `Gmail answered ${response.status}`);
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success)
      throw new GmailError(response.status, `Gmail's answer to ${path} didn't parse`);
    return parsed.data;
  }

  /**
   * A write: sent once, never retried, since a send that timed out may have
   * gone. A 4xx answer is a refusal (`GmailWriteRefused`): nothing happened.
   * A 5xx, a 408 or a network failure leaves the outcome unknown.
   */
  async #write<T>(
    method: "POST" | "PUT" | "DELETE",
    path: string,
    body: unknown,
    schema: z.ZodType<T> | null,
    signal: AbortSignal,
  ): Promise<T | null> {
    const response = await this.#fetch(new URL(path, GMAIL_API_BASE), {
      method,
      headers: {
        authorization: `Bearer ${await this.#token()}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
    // A 5xx or a timeout doesn't prove nothing happened: the outcome is unknown.
    if (response.status >= 500 || response.status === 408) {
      throw new Error(`Gmail answered ${response.status}; the write may have happened`);
    }
    if (!response.ok) {
      throw new GmailWriteRefused(response.status, await response.json().catch(() => null));
    }
    if (schema === null) return null;
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success)
      throw new GmailError(response.status, `Gmail's answer to ${path} didn't parse`);
    return parsed.data;
  }

  /** `users.settings.sendAs.list`: the addresses this mailbox may send as, verified ones only. */
  async listSendAs(signal: AbortSignal): Promise<string[]> {
    const { sendAs } = await this.#get("users/me/settings/sendAs", [], SendAsSchema, signal);
    return sendAs
      .filter((alias) => alias.isPrimary === true || alias.verificationStatus === "accepted")
      .map((alias) => alias.sendAsEmail);
  }

  /** `users.messages.get(format=raw)`: the message's exact bytes, base64url. */
  getRawMessage(id: string, signal: AbortSignal): Promise<GmailRawMessage> {
    return this.#get(
      `users/me/messages/${encodeURIComponent(id)}`,
      [["format", "raw"]],
      RawMessageSchema,
      signal,
    );
  }

  /** `users.drafts.get(format=raw)`. */
  getDraft(id: string, signal: AbortSignal): Promise<GmailDraft> {
    return this.#get(
      `users/me/drafts/${encodeURIComponent(id)}`,
      [["format", "raw"]],
      DraftSchema,
      signal,
    );
  }

  /** `users.messages.send`: sends to the raw message's To, Cc and Bcc. */
  async sendMessage(input: { raw: string; threadId?: string | undefined }, signal: AbortSignal) {
    const message = {
      raw: input.raw,
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
    };
    return (await this.#write(
      "POST",
      "users/me/messages/send",
      message,
      SentSchema,
      signal,
    )) as z.output<typeof SentSchema>;
  }

  /** `users.drafts.create`. */
  async createDraft(input: { raw: string; threadId?: string | undefined }, signal: AbortSignal) {
    const message = {
      raw: input.raw,
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
    };
    return (await this.#write(
      "POST",
      "users/me/drafts",
      { message },
      DraftRefSchema,
      signal,
    )) as z.output<typeof DraftRefSchema>;
  }

  /** `users.drafts.update`: replaces the draft's whole message. */
  async updateDraft(
    id: string,
    input: { raw: string; threadId?: string | undefined },
    signal: AbortSignal,
  ) {
    const message = {
      raw: input.raw,
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
    };
    return (await this.#write(
      "PUT",
      `users/me/drafts/${encodeURIComponent(id)}`,
      { id, message },
      DraftRefSchema,
      signal,
    )) as z.output<typeof DraftRefSchema>;
  }

  /** `users.drafts.delete`: permanent, but only ever a draft. */
  async deleteDraft(id: string, signal: AbortSignal): Promise<void> {
    await this.#write(
      "DELETE",
      `users/me/drafts/${encodeURIComponent(id)}`,
      undefined,
      null,
      signal,
    );
  }

  /** `users.messages.list`: ids only, newest first. */
  listMessages(
    input: { query: string; maxResults: number; pageToken?: string | undefined },
    signal: AbortSignal,
  ) {
    const query: [string, string][] = [
      ["q", input.query],
      ["maxResults", String(input.maxResults)],
    ];
    if (input.pageToken !== undefined) query.push(["pageToken", input.pageToken]);
    return this.#get("users/me/messages", query, ListSchema, signal);
  }

  /** `users.messages.get`. */
  getMessage(id: string, format: MessageFormat, signal: AbortSignal): Promise<GmailMessage> {
    return this.#get(
      `users/me/messages/${encodeURIComponent(id)}`,
      formatQuery(format),
      MessageSchema,
      signal,
    );
  }

  /** `users.threads.get`: every message in the thread, in order. */
  getThread(id: string, format: MessageFormat, signal: AbortSignal): Promise<GmailThread> {
    return this.#get(
      `users/me/threads/${encodeURIComponent(id)}`,
      formatQuery(format),
      ThreadSchema,
      signal,
    );
  }

  /** `users.labels.list`: system and user labels. */
  async listLabels(signal: AbortSignal): Promise<GmailLabel[]> {
    return (await this.#get("users/me/labels", [], LabelsSchema, signal)).labels;
  }
}

function formatQuery(format: MessageFormat): [string, string][] {
  if (format === "full") return [["format", "full"]];
  return [
    ["format", "metadata"],
    ...METADATA_HEADERS.map((h): [string, string] => ["metadataHeaders", h]),
  ];
}
