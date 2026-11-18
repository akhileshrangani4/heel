import { GMAIL_API_BASE } from "../../src/definitions/google/oauth.ts";

/**
 * A fake Gmail mailbox behind `fetch`, shaped like the Gmail API v1 answers
 * heel reads (research §2.1). Messages are written as plain fields and
 * served as Gmail would serve them: `metadata` carries headers and labels
 * only, `full` adds the MIME tree with base64url bodies.
 */

export const GMAIL_TEST_TOKEN = "gmail-test-access";

export interface FakeMessage {
  id: string;
  threadId: string;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  labelIds?: string[];
  /** A text/plain body. */
  text?: string;
  /** A text/html body, as the only part when `text` is absent. */
  html?: string;
  /** A raw payload in place of the generated one (encrypted, image-only, …). */
  payload?: Record<string, unknown>;
  replyTo?: string;
  messageId?: string;
  references?: string;
}

/** A message heel sent, decoded from the raw bytes it posted. */
export interface SentMessage {
  threadId: string | undefined;
  /** The exact bytes, as RFC 5322 text. */
  raw: string;
  /** Unfolded top-level headers, lower-case names. */
  headers: Record<string, string>;
}

export interface FakeDraft {
  id: string;
  threadId: string;
  /** RFC 5322 text. */
  raw: string;
}

/** Unfolded top-level headers of RFC 5322 text. */
export function headersOf(raw: string): Record<string, string> {
  const block = raw.split(/\r?\n\r?\n/)[0] ?? "";
  const headers: Record<string, string> = {};
  let last = "";
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      headers[last] = `${headers[last] ?? ""} ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    last = line.slice(0, colon).toLowerCase();
    headers[last] = line.slice(colon + 1).trim();
  }
  return headers;
}

export const SYSTEM_LABELS = [
  { id: "INBOX", name: "INBOX", type: "system" },
  { id: "SENT", name: "SENT", type: "system" },
  { id: "Label_1", name: "Family", type: "user" },
];

function encode(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

export class FakeGmail {
  readonly messages = new Map<string, FakeMessage>();
  readonly drafts = new Map<string, FakeDraft>();
  readonly sent: SentMessage[] = [];
  labels = [...SYSTEM_LABELS];
  sendAs = [
    { sendAsEmail: "alice@company.com", isPrimary: true },
    { sendAsEmail: "alice@alias.example", verificationStatus: "accepted" },
    { sendAsEmail: "pending@alias.example", verificationStatus: "pending" },
  ];
  /** How messages.send answers: ok, a refusal, or a dropped connection. */
  sendBehavior: "ok" | "refuse" | "drop" = "ok";
  /** False to make drafts.delete fail. */
  draftDeletes = true;
  /** Runs after each raw read of a message or draft, e.g. to change it before the send. */
  afterRawRead: (() => void) | null = null;
  #nextId = 100;
  /** Every request, as `METHOD path?format=…`. */
  readonly requests: string[] = [];

  add(...messages: FakeMessage[]): this {
    for (const message of messages) this.messages.set(message.id, message);
    return this;
  }

  #headers(m: FakeMessage) {
    const headers = [
      ["From", m.from],
      ["To", m.to],
      ["Cc", m.cc],
      ["Bcc", m.bcc],
      ["Subject", m.subject],
      ["Date", "Tue, 17 Nov 2026 09:00:00 +0000"],
      ["Reply-To", m.replyTo],
      ["Message-ID", m.messageId],
      ["References", m.references],
    ] as const;
    return headers
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => ({ name, value: value as string }));
  }

  #serve(m: FakeMessage, format: string) {
    const headers = this.#headers(m);
    const base = {
      id: m.id,
      threadId: m.threadId,
      labelIds: m.labelIds ?? ["INBOX"],
      snippet: (m.text ?? "").slice(0, 40),
    };
    if (format !== "full")
      return { ...base, payload: { mimeType: "multipart/alternative", headers } };
    if (m.payload !== undefined) return { ...base, payload: { ...m.payload, headers } };
    const parts = [];
    if (m.text !== undefined) {
      parts.push({ mimeType: "text/plain", body: { size: m.text.length, data: encode(m.text) } });
    }
    if (m.html !== undefined) {
      parts.push({ mimeType: "text/html", body: { size: m.html.length, data: encode(m.html) } });
    }
    return { ...base, payload: { mimeType: "multipart/alternative", headers, parts } };
  }

  /** The message as RFC 5322 text, for format=raw. */
  rawOf(m: FakeMessage): string {
    const lines = this.#headers(m).map((h) => `${h.name}: ${h.value}`);
    return `${lines.join("\r\n")}\r\n\r\n${m.text ?? m.html ?? ""}`;
  }

  #json(init: RequestInit | undefined): Record<string, unknown> {
    return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  }

  #write(method: string, path: string, init: RequestInit | undefined): Response | null {
    if (method === "POST" && path === "users/me/messages/send") {
      if (this.sendBehavior === "refuse") {
        return Response.json(
          { error: { code: 400, message: "Invalid To header" } },
          { status: 400 },
        );
      }
      if (this.sendBehavior === "drop") throw new TypeError("fetch failed");
      const body = this.#json(init);
      const raw = Buffer.from(String(body["raw"]), "base64url").toString("utf8");
      const threadId = body["threadId"] as string | undefined;
      this.sent.push({ threadId, raw, headers: headersOf(raw) });
      const id = `sent-${this.#nextId++}`;
      return Response.json({ id, threadId: threadId ?? id, labelIds: ["SENT"] });
    }
    if (method === "POST" && path === "users/me/drafts") {
      const message = this.#json(init)["message"] as { raw: string; threadId?: string };
      const id = `draft-${this.#nextId++}`;
      const raw = Buffer.from(message.raw, "base64url").toString("utf8");
      this.drafts.set(id, { id, threadId: message.threadId ?? `thread-${id}`, raw });
      return Response.json({ id, message: { id: `msg-${id}`, threadId: `thread-${id}` } });
    }
    const draft = /^users\/me\/drafts\/([^/]+)$/.exec(path)?.[1];
    if (draft !== undefined && method === "PUT") {
      const message = this.#json(init)["message"] as { raw: string };
      const existing = this.drafts.get(draft);
      if (existing === undefined) return Response.json({ error: { code: 404 } }, { status: 404 });
      existing.raw = Buffer.from(message.raw, "base64url").toString("utf8");
      return Response.json({
        id: draft,
        message: { id: `msg-${draft}`, threadId: existing.threadId },
      });
    }
    if (draft !== undefined && method === "DELETE") {
      if (!this.draftDeletes) return Response.json({ error: { code: 500 } }, { status: 500 });
      this.drafts.delete(draft);
      return new Response(null, { status: 204 });
    }
    return null;
  }

  readonly fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input.toString());
    const auth = new Headers(init?.headers).get("authorization");
    const path = url.toString().startsWith(GMAIL_API_BASE)
      ? url.pathname.replace(new URL(GMAIL_API_BASE).pathname, "")
      : null;
    const format = url.searchParams.get("format") ?? "";
    this.requests.push(`${init?.method ?? "GET"} ${path}${format ? `?format=${format}` : ""}`);
    if (path === null) return Response.json({ error: "not found" }, { status: 404 });
    if (auth !== `Bearer ${GMAIL_TEST_TOKEN}`) {
      return Response.json({ error: { code: 401 } }, { status: 401 });
    }
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      return (
        this.#write(method, path, init) ?? Response.json({ error: "not found" }, { status: 404 })
      );
    }
    if (path === "users/me/labels") return Response.json({ labels: this.labels });
    if (path === "users/me/settings/sendAs") return Response.json({ sendAs: this.sendAs });
    const draftRead = /^users\/me\/drafts\/([^/]+)$/.exec(path)?.[1];
    if (draftRead !== undefined) {
      const draft = this.drafts.get(draftRead);
      if (draft === undefined) return Response.json({ error: { code: 404 } }, { status: 404 });
      const response = Response.json({
        id: draft.id,
        message: {
          id: `msg-${draft.id}`,
          threadId: draft.threadId,
          raw: Buffer.from(draft.raw, "utf8").toString("base64url"),
        },
      });
      this.afterRawRead?.();
      return response;
    }
    if (path === "users/me/messages") {
      const max = Number(url.searchParams.get("maxResults") ?? "100");
      const all = [...this.messages.values()].reverse();
      return Response.json({
        messages: all.slice(0, max).map((m) => ({ id: m.id, threadId: m.threadId })),
        ...(all.length > max && { nextPageToken: "page-2" }),
        resultSizeEstimate: all.length,
      });
    }
    const message = /^users\/me\/messages\/([^/]+)$/.exec(path);
    if (message?.[1] !== undefined) {
      const found = this.messages.get(decodeURIComponent(message[1]));
      if (found === undefined) return Response.json({ error: { code: 404 } }, { status: 404 });
      if (format === "raw") {
        const response = Response.json({
          id: found.id,
          threadId: found.threadId,
          raw: Buffer.from(this.rawOf(found), "utf8").toString("base64url"),
        });
        this.afterRawRead?.();
        return response;
      }
      return Response.json(this.#serve(found, format));
    }
    const thread = /^users\/me\/threads\/([^/]+)$/.exec(path);
    if (thread?.[1] !== undefined) {
      const id = decodeURIComponent(thread[1]);
      const messages = [...this.messages.values()].filter((m) => m.threadId === id);
      return messages.length === 0
        ? Response.json({ error: { code: 404 } }, { status: 404 })
        : Response.json({ id, messages: messages.map((m) => this.#serve(m, format)) });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  };
}
