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
  labels = [...SYSTEM_LABELS];
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
    if (path === "users/me/labels") return Response.json({ labels: this.labels });
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
      return found === undefined
        ? Response.json({ error: { code: 404 } }, { status: 404 })
        : Response.json(this.#serve(found, format));
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
