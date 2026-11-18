import { GRAPH_API_BASE } from "../../src/definitions/microsoft/oauth.ts";
import { headersOf } from "./fake-gmail.ts";

/**
 * A fake Microsoft Graph v1.0 mailbox behind `fetch`, shaped like the
 * answers heel reads (graph-research §2–§9). Folders have ids distinct from
 * their well-known names, as in Graph, and messages keep their ids when
 * moved (heel asks for immutable ids).
 */

export const GRAPH_TEST_TOKEN = "graph-test-access";
export const MAILBOX = "alice@company.com";

export interface FakeGraphMessage {
  id: string;
  conversationId: string;
  folder: string;
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  subject?: string;
  text?: string;
  categories?: string[];
  isDraft?: boolean;
  internetMessageId?: string;
  hasAttachments?: boolean;
  received?: string;
  /** Exact MIME for `$value`, in place of the generated one. */
  mime?: string;
}

/** A message heel sent through sendMail, decoded. */
export interface GraphSent {
  raw: string;
  headers: Record<string, string>;
}

const FOLDERS: Record<string, { id: string; name: string; parent: string; hidden?: boolean }> = {
  msgfolderroot: { id: "fld-root", name: "Top of Information Store", parent: "" },
  inbox: { id: "fld-inbox", name: "Inbox", parent: "fld-root" },
  sentitems: { id: "fld-sent", name: "Sent Items", parent: "fld-root" },
  deleteditems: { id: "fld-deleted", name: "Deleted Items", parent: "fld-root" },
  junkemail: { id: "fld-junk", name: "Junk Email", parent: "fld-root" },
  archive: { id: "fld-archive", name: "Archive", parent: "fld-root" },
  drafts: { id: "fld-drafts", name: "Drafts", parent: "fld-root" },
  outbox: { id: "fld-outbox", name: "Outbox", parent: "fld-root" },
  recoverableitemsdeletions: { id: "fld-recoverable", name: "Deletions", parent: "fld-root" },
  projects: { id: "fld-projects", name: "Projects", parent: "fld-root" },
  hr2026: { id: "fld-hr-2026", name: "2026", parent: "fld-hr" },
  hr: { id: "fld-hr", name: "HR", parent: "fld-root" },
  oldtrash: { id: "fld-old-trash", name: "Old", parent: "fld-deleted" },
  stash: { id: "fld-stash", name: "Stash", parent: "fld-root", hidden: true },
};

const recipient = (address: string) => ({ emailAddress: { name: address, address } });

export class FakeGraph {
  readonly messages = new Map<string, FakeGraphMessage>();
  readonly sent: GraphSent[] = [];
  readonly rules: { id: string; [key: string]: unknown }[] = [];
  readonly requests: string[] = [];
  sendBehavior: "ok" | "refuse" | "error500" = "ok";
  /** Runs after each `$value` read, e.g. to change a message before the send. */
  afterMimeRead: (() => void) | null = null;
  #nextId = 1;

  add(...messages: FakeGraphMessage[]): this {
    for (const m of messages) this.messages.set(m.id, { ...m });
    return this;
  }

  folderId(name: string): string {
    return (FOLDERS[name] as { id: string }).id;
  }

  mimeOf(m: FakeGraphMessage): string {
    if (m.mime !== undefined) return m.mime;
    const lines = [
      m.from === undefined ? null : `From: ${m.from}`,
      m.to === undefined ? null : `To: ${m.to.join(", ")}`,
      m.cc === undefined ? null : `Cc: ${m.cc.join(", ")}`,
      m.bcc === undefined ? null : `Bcc: ${m.bcc.join(", ")}`,
      `Subject: ${m.subject ?? ""}`,
    ].filter((l) => l !== null);
    return `${lines.join("\r\n")}\r\n\r\n${m.text ?? ""}`;
  }

  #serve(m: FakeGraphMessage) {
    return {
      id: m.id,
      conversationId: m.conversationId,
      subject: m.subject ?? null,
      bodyPreview: (m.text ?? "").slice(0, 255),
      body: { contentType: "text", content: m.text ?? "" },
      from: m.from === undefined ? null : recipient(m.from),
      toRecipients: (m.to ?? []).map(recipient),
      ccRecipients: (m.cc ?? []).map(recipient),
      bccRecipients: (m.bcc ?? []).map(recipient),
      replyTo: (m.replyTo ?? []).map(recipient),
      internetMessageId: m.internetMessageId ?? null,
      parentFolderId: this.#folderIdOf(m.folder),
      categories: m.categories ?? [],
      isDraft: m.isDraft ?? false,
      hasAttachments: m.hasAttachments ?? false,
      receivedDateTime: m.received ?? "2026-11-17T09:00:00Z",
    };
  }

  #folderIdOf(nameOrId: string): string {
    return FOLDERS[nameOrId]?.id ?? nameOrId;
  }

  #folder(nameOrId: string) {
    return Object.values(FOLDERS).find((f) => f.id === nameOrId) ?? FOLDERS[nameOrId.toLowerCase()];
  }

  /** Graph's answer to a `$select`: only the named fields, as a test of what heel does without the rest. */
  selectOnly: string[] | null = null;

  readonly fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input.toString());
    const method = init?.method ?? "GET";
    const path = url.toString().startsWith(GRAPH_API_BASE)
      ? url.pathname.replace(new URL(GRAPH_API_BASE).pathname, "")
      : null;
    this.requests.push(`${method} ${path}`);
    if (path === null) return Response.json({ error: "not graph" }, { status: 404 });
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== `Bearer ${GRAPH_TEST_TOKEN}`) return Response.json({}, { status: 401 });
    const notFound = () => Response.json({ error: { code: "ErrorItemNotFound" } }, { status: 404 });

    if (method === "POST" && path === "me/sendMail") {
      if (this.sendBehavior === "refuse") return Response.json({ error: {} }, { status: 400 });
      if (this.sendBehavior === "error500") return Response.json({ error: {} }, { status: 500 });
      const raw = Buffer.from(String(init?.body), "base64").toString("utf8");
      this.sent.push({ raw, headers: headersOf(raw) });
      return new Response(null, { status: 202 });
    }
    if (method === "POST" && path === "me/messages") {
      const raw = Buffer.from(String(init?.body), "base64").toString("utf8");
      const h = headersOf(raw);
      const id = `draft-${this.#nextId++}`;
      const split = (v: string | undefined) => (v === undefined ? [] : v.split(/,\s*/));
      this.add({
        id,
        conversationId: `conv-${id}`,
        folder: "drafts",
        isDraft: true,
        mime: raw,
        ...(h["from"] === undefined ? {} : { from: h["from"] }),
        to: split(h["to"]),
        cc: split(h["cc"]),
        bcc: split(h["bcc"]),
        subject: h["subject"] ?? "",
        text: raw
          .split(/\r?\n\r?\n/)
          .slice(1)
          .join("\n\n"),
      });
      return Response.json({ id }, { status: 201 });
    }
    if (method === "POST" && path === "me/mailFolders/inbox/messageRules") {
      const rule = { id: `rule-${this.#nextId++}`, ...(JSON.parse(String(init?.body)) as object) };
      this.rules.push(rule);
      return Response.json(rule, { status: 201 });
    }
    const moveMatch = /^me\/messages\/([^/]+)\/move$/.exec(path);
    if (method === "POST" && moveMatch?.[1] !== undefined) {
      const m = this.messages.get(decodeURIComponent(moveMatch[1]));
      if (m === undefined) return notFound();
      const { destinationId } = JSON.parse(String(init?.body)) as { destinationId: string };
      const folder = this.#folder(destinationId);
      if (folder === undefined) return notFound();
      m.folder = folder.id;
      return Response.json(this.#serve(m), { status: 201 });
    }
    const one = /^me\/messages\/([^/]+)$/.exec(path)?.[1];
    if (one !== undefined) {
      const m = this.messages.get(decodeURIComponent(one));
      if (m === undefined) return notFound();
      if (method === "DELETE") {
        m.folder = "deleteditems";
        return new Response(null, { status: 204 });
      }
      if (method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (Array.isArray(body["categories"])) m.categories = body["categories"] as string[];
        if (typeof body["subject"] === "string") m.subject = body["subject"];
        const addresses = (key: string) =>
          (body[key] as { emailAddress: { address: string } }[] | undefined)?.map(
            (r) => r.emailAddress.address,
          );
        m.to = addresses("toRecipients") ?? m.to ?? [];
        m.cc = addresses("ccRecipients") ?? m.cc ?? [];
        m.bcc = addresses("bccRecipients") ?? m.bcc ?? [];
        delete m.mime;
        return Response.json(this.#serve(m));
      }
      return Response.json(this.#serve(m));
    }
    const value = /^me\/messages\/([^/]+)\/\$value$/.exec(path)?.[1];
    if (value !== undefined) {
      const m = this.messages.get(decodeURIComponent(value));
      if (m === undefined) return notFound();
      const response = new Response(this.mimeOf(m), {
        headers: { "content-type": "message/rfc822" },
      });
      this.afterMimeRead?.();
      return response;
    }
    const filter = url.searchParams.get("$filter");
    const inFolder = /^me\/mailFolders\/([^/]+)\/messages$/.exec(path)?.[1];
    if (path === "me/messages" || inFolder !== undefined) {
      let list = [...this.messages.values()];
      if (inFolder !== undefined) {
        const folderId = this.#folderIdOf(decodeURIComponent(inFolder));
        list = list.filter((m) => this.#folderIdOf(m.folder) === folderId);
      }
      const conversation = filter === null ? null : /^conversationId eq '(.*)'$/.exec(filter)?.[1];
      if (conversation !== undefined && conversation !== null) {
        list = list.filter((m) => m.conversationId === conversation.replaceAll("''", "'"));
      }
      const top = Number(url.searchParams.get("$top") ?? "10");
      const select = this.selectOnly;
      const shape = (m: FakeGraphMessage) => {
        const full = this.#serve(m) as Record<string, unknown>;
        return select === null ? full : Object.fromEntries(select.map((k) => [k, full[k]]));
      };
      return Response.json({
        value: list.slice(0, top).map(shape),
        ...(list.length > top && {
          "@odata.nextLink": `${GRAPH_API_BASE}me/messages?$skiptoken=2`,
        }),
      });
    }
    if (path === "me/mailFolders/inbox/messageRules") return Response.json({ value: this.rules });
    if (path === "me/mailFolders") {
      return Response.json({
        value: Object.values(FOLDERS).map((f) => ({
          id: f.id,
          displayName: f.name,
          childFolderCount: 0,
        })),
      });
    }
    const folder = /^me\/mailFolders\/([^/]+)$/.exec(path)?.[1];
    if (folder !== undefined) {
      const found = this.#folder(decodeURIComponent(folder));
      return found === undefined
        ? notFound()
        : Response.json({
            id: found.id,
            displayName: found.name,
            parentFolderId: found.parent === "" ? null : found.parent,
            childFolderCount: 0,
            isHidden: found.hidden ?? false,
          });
    }
    return notFound();
  };
}
