import { z } from "zod";
import { getWithRetry, throwIfWriteFailed } from "../http-retry.ts";
import { GRAPH_API_BASE } from "../microsoft/oauth.ts";
import type { FetchFn } from "../sign-in.ts";

/**
 * The Microsoft Graph v1.0 mail calls heel needs.
 *
 * - Every request asks for immutable ids, so a message keeps its id when it
 *   moves folders, and for text bodies.
 * - GETs are retried once on 429 and 5xx. Writes are sent once, never
 *   retried: a 5xx or 408 leaves the outcome unknown, and any other non-2xx
 *   is a refusal (nothing happened).
 * - A paging link from Graph is only followed when it points back at this
 *   mailbox on Graph, so an agent can't steer heel's token elsewhere.
 */

const PREFER = 'IdType="ImmutableId", outlook.body-content-type="text"';

const RecipientSchema = z.object({
  emailAddress: z
    .object({ name: z.string().nullable().optional(), address: z.string().nullable().optional() })
    .default({}),
});
export type Recipient = z.output<typeof RecipientSchema>;

/**
 * The fields hiding needs. Graph returns them by default; a message missing
 * any (as a `$select` would cause) is marked incomplete, and hides.
 */
const FIELDS_HIDING_NEEDS = [
  "from",
  "toRecipients",
  "ccRecipients",
  "bccRecipients",
  "categories",
  "parentFolderId",
  "body",
  "hasAttachments",
  "isDraft",
] as const;

export const OutlookMessageSchema = z.preprocess(
  (raw) =>
    typeof raw === "object" && raw !== null
      ? { ...raw, complete: FIELDS_HIDING_NEEDS.every((key) => key in raw) }
      : raw,
  z.object({
    id: z.string(),
    complete: z.boolean(),
    conversationId: z.string().default(""),
    subject: z.string().nullable().default(null),
    bodyPreview: z.string().default(""),
    body: z.object({ contentType: z.string(), content: z.string() }).nullable().optional(),
    from: RecipientSchema.nullable().optional(),
    toRecipients: z.array(RecipientSchema).default([]),
    ccRecipients: z.array(RecipientSchema).default([]),
    bccRecipients: z.array(RecipientSchema).default([]),
    replyTo: z.array(RecipientSchema).default([]),
    internetMessageId: z.string().nullable().optional(),
    parentFolderId: z.string().default(""),
    categories: z.array(z.string()).default([]),
    isDraft: z.boolean().default(false),
    hasAttachments: z.boolean().default(false),
    receivedDateTime: z.string().nullable().optional(),
  }),
);
export type OutlookMessage = z.output<typeof OutlookMessageSchema>;

const MessageListSchema = z.object({
  value: z.array(OutlookMessageSchema).default([]),
  "@odata.nextLink": z.string().optional(),
});

const FolderSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  parentFolderId: z.string().nullable().optional(),
  childFolderCount: z.number().default(0),
  isHidden: z.boolean().default(false),
});
export type OutlookFolder = z.output<typeof FolderSchema>;
const FolderListSchema = z.object({
  value: z.array(FolderSchema).default([]),
  "@odata.nextLink": z.string().optional(),
});

const RuleSchema = z.object({
  id: z.string(),
  displayName: z.string().default(""),
  conditions: z.record(z.string(), z.unknown()).nullable().optional(),
  actions: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type OutlookRule = z.output<typeof RuleSchema>;
const RuleListSchema = z.object({ value: z.array(RuleSchema).default([]) });

const GraphEventSchema = z.object({
  id: z.string(),
  subject: z.string().nullable().optional(),
  bodyPreview: z.string().optional(),
  start: z.object({ dateTime: z.string(), timeZone: z.string() }).optional(),
  end: z.object({ dateTime: z.string(), timeZone: z.string() }).optional(),
  location: z.object({ displayName: z.string().nullable().optional() }).optional(),
  attendees: z
    .array(
      z.object({
        emailAddress: z
          .object({
            address: z.string().nullable().optional(),
            name: z.string().nullable().optional(),
          })
          .default({}),
        type: z.string().optional(),
        status: z.object({ response: z.string().optional() }).optional(),
      }),
    )
    .default([]),
  organizer: RecipientSchema.nullable().optional(),
  isOrganizer: z.boolean().optional(),
  isCancelled: z.boolean().optional(),
  webLink: z.string().optional(),
});
export type GraphEvent = z.output<typeof GraphEventSchema>;
const GraphEventListSchema = z.object({
  value: z.array(GraphEventSchema).default([]),
  "@odata.nextLink": z.string().optional(),
});
const CalendarListSchema = z.object({
  value: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        isDefaultCalendar: z.boolean().optional(),
      }),
    )
    .default([]),
});

/** Graph answered 404: the item doesn't exist, or isn't this mailbox's. */
export class OutlookNotFoundError extends Error {
  override readonly name = "OutlookNotFoundError";
}

/** Graph answered with another error, or with a body that didn't parse. */
export class OutlookError extends Error {
  override readonly name = "OutlookError";
}

/** Graph refused a write: it didn't happen. */
export class OutlookWriteRefused extends Error {
  override readonly name = "OutlookWriteRefused";
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    super(`Graph refused the write (${status})`);
    this.status = status;
    this.body = body;
  }
}

const MAILBOX_PREFIX = `${GRAPH_API_BASE}me/`;
const MAX_FOLDERS = 500;

/** A Graph OData string literal: single quotes doubled. */
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export class OutlookClient {
  readonly #fetch: FetchFn;
  readonly #token: () => Promise<string>;

  /** `token` returns a fresh access token (the vault refreshes it). */
  constructor(fetch: FetchFn, token: () => Promise<string>) {
    this.#fetch = fetch;
    this.#token = token;
  }

  async #headers(extra: Record<string, string> = {}) {
    return {
      authorization: `Bearer ${await this.#token()}`,
      accept: "application/json",
      prefer: PREFER,
      ...extra,
    };
  }

  async #getResponse(url: URL, signal: AbortSignal): Promise<Response> {
    if (!url.toString().startsWith(MAILBOX_PREFIX)) throw new OutlookError("not a mailbox URL");
    const response = await getWithRetry(async () =>
      this.#fetch(url, { headers: await this.#headers(), signal }),
    );
    if (response.status === 404) throw new OutlookNotFoundError(`${url.pathname} was not found`);
    if (!response.ok) throw new OutlookError(`Graph answered ${response.status}`);
    return response;
  }

  async #get<T>(url: URL, schema: z.ZodType<T>, signal: AbortSignal): Promise<T> {
    const response = await this.#getResponse(url, signal);
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) throw new OutlookError(`Graph's answer to ${url.pathname} didn't parse`);
    return parsed.data;
  }

  async #write(
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    body: { json: unknown } | { mime: string } | null,
    signal: AbortSignal,
  ): Promise<unknown> {
    const contentType =
      body === null
        ? {}
        : "json" in body
          ? { "content-type": "application/json" }
          : { "content-type": "text/plain" };
    const response = await this.#fetch(new URL(path, MAILBOX_PREFIX), {
      method,
      headers: await this.#headers(contentType),
      ...(body === null ? {} : { body: "json" in body ? JSON.stringify(body.json) : body.mime }),
      signal,
    });
    await throwIfWriteFailed(response, "Graph", OutlookWriteRefused);
    return response.status === 202 || response.status === 204
      ? null
      : await response.json().catch(() => null);
  }

  /** `GET /me/messages` with `$search` (KQL), or the next page from a link Graph gave. */
  async listMessages(
    input: { search: string; top: number } | { nextLink: string },
    signal: AbortSignal,
  ): Promise<{ messages: OutlookMessage[]; nextLink: string | undefined }> {
    let url: URL;
    if ("nextLink" in input) {
      url = new URL(input.nextLink);
    } else {
      url = new URL("messages", MAILBOX_PREFIX);
      url.searchParams.set("$top", String(input.top));
      if (input.search !== "")
        url.searchParams.set("$search", `"${input.search.replaceAll('"', "")}"`);
    }
    const page = await this.#get(url, MessageListSchema, signal);
    return { messages: page.value, nextLink: page["@odata.nextLink"] };
  }

  getMessage(id: string, signal: AbortSignal): Promise<OutlookMessage> {
    return this.#get(
      new URL(`messages/${encodeURIComponent(id)}`, MAILBOX_PREFIX),
      OutlookMessageSchema,
      signal,
    );
  }

  /** `GET /me/messages/{id}/$value`: the message's exact MIME bytes. */
  async getMime(id: string, signal: AbortSignal): Promise<Buffer> {
    const response = await this.#getResponse(
      new URL(`messages/${encodeURIComponent(id)}/$value`, MAILBOX_PREFIX),
      signal,
    );
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * The messages of a conversation, oldest first, from every folder, or
   * only from `folder` (a well-known name such as `sentitems`). Graph
   * doesn't document `$filter` on `conversationId`; if it refuses, the read
   * fails and the caller denies.
   */
  async listConversation(
    conversationId: string,
    folder: string | null,
    signal: AbortSignal,
  ): Promise<OutlookMessage[]> {
    const url = new URL(
      folder === null ? "messages" : `mailFolders/${encodeURIComponent(folder)}/messages`,
      MAILBOX_PREFIX,
    );
    url.searchParams.set("$filter", `conversationId eq ${literal(conversationId)}`);
    url.searchParams.set("$top", "100");
    const messages: OutlookMessage[] = [];
    let next: URL | null = url;
    for (let page = 0; next !== null && page < 10; page++) {
      const list: z.output<typeof MessageListSchema> = await this.#get(
        next,
        MessageListSchema,
        signal,
      );
      messages.push(...list.value);
      next = list["@odata.nextLink"] === undefined ? null : new URL(list["@odata.nextLink"]);
    }
    if (next !== null) throw new OutlookError("the conversation is too long to read in full");
    return messages.sort((a, b) =>
      (a.receivedDateTime ?? "").localeCompare(b.receivedDateTime ?? ""),
    );
  }

  /** One folder, by id or well-known name. */
  getFolder(idOrName: string, signal: AbortSignal): Promise<OutlookFolder> {
    return this.#get(
      new URL(`mailFolders/${encodeURIComponent(idOrName)}`, MAILBOX_PREFIX),
      FolderSchema,
      signal,
    );
  }

  /** Every folder, walking child folders, hidden ones included. */
  async listFolders(signal: AbortSignal): Promise<OutlookFolder[]> {
    const folders: OutlookFolder[] = [];
    const queue: string[] = ["mailFolders?includeHiddenFolders=true&$top=100"];
    while (queue.length > 0) {
      let next: URL | null = new URL(queue.shift() as string, MAILBOX_PREFIX);
      while (next !== null) {
        const page: z.output<typeof FolderListSchema> = await this.#get(
          next,
          FolderListSchema,
          signal,
        );
        for (const folder of page.value) {
          folders.push(folder);
          if (folders.length > MAX_FOLDERS) throw new OutlookError("too many folders to list");
          if (folder.childFolderCount > 0) {
            queue.push(
              `mailFolders/${encodeURIComponent(folder.id)}/childFolders?includeHiddenFolders=true&$top=100`,
            );
          }
        }
        next = page["@odata.nextLink"] === undefined ? null : new URL(page["@odata.nextLink"]);
      }
    }
    return folders;
  }

  async listRules(signal: AbortSignal): Promise<OutlookRule[]> {
    return (
      await this.#get(
        new URL("mailFolders/inbox/messageRules", MAILBOX_PREFIX),
        RuleListSchema,
        signal,
      )
    ).value;
  }

  /** `POST /me/sendMail` with base64 MIME: Exchange takes the recipients from its headers. */
  async sendMime(mimeBase64: string, signal: AbortSignal): Promise<void> {
    await this.#write("POST", "sendMail", { mime: mimeBase64 }, signal);
  }

  /** `POST /me/messages` with base64 MIME: a new draft. */
  async createDraftMime(mimeBase64: string, signal: AbortSignal): Promise<{ id: string }> {
    const body = await this.#write("POST", "messages", { mime: mimeBase64 }, signal);
    const parsed = z.object({ id: z.string() }).safeParse(body);
    if (!parsed.success) throw new Error("Graph created a draft but its answer didn't parse");
    return parsed.data;
  }

  /** `PATCH /me/messages/{id}`: fields that change while a message is a draft, or categories. */
  async patchMessage(
    id: string,
    fields: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<void> {
    await this.#write("PATCH", `messages/${encodeURIComponent(id)}`, { json: fields }, signal);
  }

  /** `DELETE /me/messages/{id}`: into Deleted Items, as the mailFolder docs describe deleting. */
  async deleteMessage(id: string, signal: AbortSignal): Promise<void> {
    await this.#write("DELETE", `messages/${encodeURIComponent(id)}`, null, signal);
  }

  /** `POST /me/messages/{id}/move`. With immutable ids the id stays the same. */
  async move(id: string, destination: string, signal: AbortSignal): Promise<void> {
    await this.#write(
      "POST",
      `messages/${encodeURIComponent(id)}/move`,
      { json: { destinationId: destination } },
      signal,
    );
  }

  /** `GET /me/calendars`. */
  async listCalendars(signal: AbortSignal) {
    return (await this.#get(new URL("calendars", MAILBOX_PREFIX), CalendarListSchema, signal))
      .value;
  }

  /** `GET /me/calendarView` (or one calendar's): occurrences between two instants. */
  async calendarView(
    input:
      | { calendarId: string | null; start: string; end: string; top: number }
      | { nextLink: string },
    signal: AbortSignal,
  ) {
    let url: URL;
    if ("nextLink" in input) {
      url = new URL(input.nextLink);
    } else {
      url = new URL(
        input.calendarId === null
          ? "calendarView"
          : `calendars/${encodeURIComponent(input.calendarId)}/calendarView`,
        MAILBOX_PREFIX,
      );
      url.searchParams.set("startDateTime", input.start);
      url.searchParams.set("endDateTime", input.end);
      url.searchParams.set("$top", String(input.top));
    }
    const page = await this.#get(url, GraphEventListSchema, signal);
    return { events: page.value, nextLink: page["@odata.nextLink"] };
  }

  getEvent(id: string, signal: AbortSignal): Promise<GraphEvent> {
    return this.#get(
      new URL(`events/${encodeURIComponent(id)}`, MAILBOX_PREFIX),
      GraphEventSchema,
      signal,
    );
  }

  /** `POST /me/events` (or one calendar's): Graph sends the attendees invitations. */
  async createEvent(
    calendarId: string | null,
    event: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    const path =
      calendarId === null ? "events" : `calendars/${encodeURIComponent(calendarId)}/events`;
    return GraphEventSchema.parse(await this.#write("POST", path, { json: event }, signal));
  }

  /** `PATCH /me/events/{id}`: Graph sends the attendees updates. */
  async patchEvent(id: string, patch: Record<string, unknown>, signal: AbortSignal) {
    return GraphEventSchema.parse(
      await this.#write("PATCH", `events/${encodeURIComponent(id)}`, { json: patch }, signal),
    );
  }

  /** `DELETE /me/events/{id}`: for the organizer, Graph sends the attendees a cancellation. */
  async deleteEvent(id: string, signal: AbortSignal): Promise<void> {
    await this.#write("DELETE", `events/${encodeURIComponent(id)}`, null, signal);
  }

  /** `POST /me/mailFolders/inbox/messageRules`. */
  async createRule(rule: Record<string, unknown>, signal: AbortSignal): Promise<{ id: string }> {
    const body = await this.#write(
      "POST",
      "mailFolders/inbox/messageRules",
      { json: rule },
      signal,
    );
    const parsed = z.object({ id: z.string() }).safeParse(body);
    if (!parsed.success) throw new Error("Graph created a rule but its answer didn't parse");
    return parsed.data;
  }
}
