/**
 * What a request does, in plain words, for the approval page (spec: The
 * approval page). Pure: everything comes from the stored call heel will run,
 * never from what the agent said about it, so the sentence can't be talked
 * into saying something the call doesn't do.
 *
 * Folding a list never hides an outlier: recipients are grouped by domain,
 * every domain is named, and the full addresses stay on the page (I-57).
 */

/** The rendered email view shown for `email.send`. */
export interface EmailPreview {
  from: string;
  to: readonly string[];
  cc: readonly string[];
  bcc: readonly string[];
  subject: string;
  /** Shown as text. An HTML body is shown as its source, never rendered. */
  body: string;
  bodyFormat: "text" | "html";
  /** Listed by name, type and size, never inlined (Q-N4). */
  attachments: readonly { name: string; type: string; size: number }[];
  /** A forward's original message, as heel read it, when the call forwards one. */
  forwarded?: { text: string; attachments: readonly string[] } | undefined;
}

/** A pull request merge, as the GitHub definition normalizes it. */
export interface MergePreview {
  repo: string;
  number: number;
  /** The base branch the merge lands on, when heel looked it up. */
  base: string | null;
  method: string | null;
  /** The head commit the merge is pinned to. */
  sha: string | null;
}

/** Recipients that share a domain, in the order they first appear. */
export interface DomainGroup {
  domain: string;
  addresses: readonly string[];
  /** Not the sender's own organization (see `homeDomain`). */
  outside: boolean;
}

/** Mail providers whose domain says nothing about who someone works for. */
const PUBLIC_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "fastmail.com",
  "hey.com",
  "zoho.com",
  "gmx.com",
  "yandex.com",
]);

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 0 ? "" : address.slice(at + 1).toLowerCase();
}

/**
 * The sender's organization domain, or null when the sender uses a public
 * mail provider: then heel can't tell colleagues from outsiders and marks
 * nobody as outside.
 */
export function homeDomain(from: string): string | null {
  const domain = domainOf(from);
  return domain === "" || PUBLIC_MAIL_DOMAINS.has(domain) ? null : domain;
}

/** Recipients grouped by domain; every address appears exactly once, in order. */
export function groupByDomain(addresses: readonly string[], home: string | null): DomainGroup[] {
  const groups = new Map<string, string[]>();
  for (const address of addresses) {
    const domain = domainOf(address);
    const list = groups.get(domain);
    if (list === undefined) groups.set(domain, [address]);
    else if (!list.includes(address)) list.push(address);
  }
  return [...groups].map(([domain, list]) => ({
    domain,
    addresses: list,
    outside: home !== null && domain !== home,
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? value : null;
}

/**
 * The email view of a built-in mail send (Gmail or Outlook: send, reply,
 * reply-all, forward), read from the normalized arguments. Null for any
 * other shape, so the page falls back to the generic view instead of guessing.
 */
export function emailPreviewFrom(action: string | null, args: unknown): EmailPreview | null {
  if (action !== "email.send" || !isRecord(args)) return null;
  const to = strings(args["to"]);
  const cc = strings(args["cc"] ?? []);
  const bcc = strings(args["bcc"] ?? []);
  const { from, subject, body, html } = args;
  if (to === null || cc === null || bcc === null) return null;
  if (typeof from !== "string" || typeof subject !== "string" || typeof body !== "string") {
    return null;
  }
  const htmlOnly = body === "" && typeof html === "string" && html !== "";
  const forwardedText = args["forwarded_text"];
  return {
    from,
    to,
    cc,
    bcc,
    subject,
    body: htmlOnly ? html : body,
    bodyFormat: htmlOnly ? "html" : "text",
    attachments: [],
    forwarded:
      typeof forwardedText === "string"
        ? { text: forwardedText, attachments: strings(args["forwarded_attachments"]) ?? [] }
        : undefined,
  };
}

/**
 * The email view for the request page: a send, or a draft the call saves
 * (`email.draft` with a full message: create_draft, update_draft). A draft
 * reads as the email it holds; the page says it isn't sent. The list keeps
 * `emailPreviewFrom`, so its sentences don't change.
 */
export function mailPreviewFrom(action: string | null, args: unknown): EmailPreview | null {
  if (action === "email.draft") return emailPreviewFrom("email.send", args);
  return emailPreviewFrom(action, args);
}

/** The merge view of a GitHub merge, read from the normalized arguments. */
export function mergePreviewFrom(action: string | null, args: unknown): MergePreview | null {
  if ((action !== "github.merge" && action !== "github.workflow.merge") || !isRecord(args)) {
    return null;
  }
  const { repo, number, base, method, sha } = args;
  if (typeof repo !== "string" || typeof number !== "number") return null;
  return {
    repo,
    number,
    base: typeof base === "string" ? base : null,
    method: typeof method === "string" ? method : null,
    sha: typeof sha === "string" ? sha : null,
  };
}

/** What an action does, as a verb phrase: `send an email`, `merge a pull request`. */
export const ACTION_PHRASES: Readonly<Record<string, string>> = {
  "email.send": "send an email",
  "email.draft": "save an email draft",
  "email.remove": "delete email",
  "email.label": "label email",
  "email.filter": "change an email filter",
  "github.merge": "merge a pull request",
  "github.workflow.merge": "merge a pull request that changes a workflow",
  "github.push": "push to a GitHub repository",
  "github.workflow.push": "push a workflow change",
  "github.pr.create": "open a pull request",
  "github.pr.update": "update a pull request",
  "github.issue.create": "open a GitHub issue",
  "github.issue.update": "update a GitHub issue",
  "github.comment": "comment on GitHub",
  "github.api": "call the GitHub API",
  "calendar.event.create": "create a calendar event",
  "calendar.event.update": "change a calendar event",
  "calendar.event.delete": "delete a calendar event",
  "slack.post": "post in Slack",
  "slack.schedule": "schedule a Slack message",
  "slack.update": "edit a Slack message",
  "slack.delete": "delete a Slack message",
  "linear.issue.create": "create a Linear issue",
  "linear.issue.update": "update a Linear issue",
  "linear.issue.delete": "delete a Linear issue",
  "linear.comment": "comment in Linear",
  "notion.page.create": "create a Notion page",
  "notion.page.update": "change a Notion page",
  "notion.page.delete": "delete a Notion page",
  "stripe.payment.create": "create a Stripe payment",
  "stripe.refund": "refund a Stripe payment",
  "stripe.customer.update": "update a Stripe customer",
  "stripe.subscription.update": "change a Stripe subscription",
};

/** `create_issue` → `create issue`; `pr merge` stays as it is. */
export function toolPhrase(tool: string): string {
  return tool.replace(/[_-]+/g, " ").trim();
}

export function actionPhrase(action: string | null, tool: string): string {
  if (action !== null && ACTION_PHRASES[action] !== undefined) return ACTION_PHRASES[action];
  return `run ${toolPhrase(tool)}`;
}

/** `bob@vendor.com`, `bob@vendor.com and 1 other`, `40 people at vendor.com and 2 others`. */
export function recipientPhrase(email: EmailPreview): string {
  const everyone = [...new Set([...email.to, ...email.cc, ...email.bcc])];
  if (everyone.length === 0) return "nobody";
  if (everyone.length === 1) return everyone[0] ?? "";
  const groups = groupByDomain(everyone, homeDomain(email.from));
  const first = email.to[0] ?? everyone[0] ?? "";
  const others = everyone.length - 1;
  const rest = `${others} ${others === 1 ? "other" : "others"}`;
  if (groups.length === 1) return `${first} and ${rest} at ${groups[0]?.domain ?? ""}`;
  return `${first} and ${rest} at ${groups.length} domains`;
}

/**
 * The pieces of the headline, so the page can mark the action and where it
 * lands: `<agent> wants to <action> <preposition> <place><rest>`.
 */
export interface Headline {
  agent: string;
  action: string;
  preposition: "from" | "on";
  place: string;
  /** After the place: ` to bob@vendor.com and 40 others…`, ` into main`, or empty. */
  rest: string;
}

export function headline(input: {
  agent: string;
  action: string | null;
  tool: string;
  account: string;
  email: EmailPreview | null;
  merge: MergePreview | null;
  http?: HttpPreview | null;
}): Headline {
  const { agent, email, merge } = input;
  const http = input.http ?? null;
  if (email !== null) {
    return {
      agent,
      action: actionPhrase(input.action, input.tool),
      preposition: "from",
      place: input.account,
      rest: ` to ${recipientPhrase(email)}`,
    };
  }
  if (merge !== null) {
    return {
      agent,
      action: `merge pull request #${merge.number}`,
      preposition: "on",
      place: merge.repo,
      rest: merge.base === null ? "" : ` into ${merge.base}`,
    };
  }
  return {
    agent,
    action:
      http !== null && (input.action === null || ACTION_PHRASES[input.action] === undefined)
        ? `call ${http.method} ${http.path}${input.action === null ? "" : ` (${input.action})`}`
        : actionPhrase(input.action, input.tool),
    preposition: "on",
    place: input.account,
    rest: "",
  };
}

/** One argument as the readable view lists it. Full values; nothing is shortened. */
export interface ArgumentLine {
  name: string;
  value: string;
  /** Long or structured values are shown as a block rather than inline. */
  block: boolean;
  /** null, "", [] or {}: the page names these on one line instead of a row each. */
  empty?: true;
}

/**
 * Who or what a call reaches, then what it says, then everything else by
 * name. The definitions don't rank their fields yet; until they do, these
 * common names put the target and the content first for most tools.
 */
const TARGET_FIELDS = [
  "to",
  "recipient",
  "recipients",
  "channel",
  "repo",
  "number",
  "team",
  "customer",
  "payment_intent",
  "amount",
  "title",
  "subject",
  "name",
  "path",
  "url",
];
const CONTENT_FIELDS = ["text", "body", "message", "description", "content", "comment"];

function fieldRank(name: string): number {
  const target = TARGET_FIELDS.indexOf(name);
  if (target >= 0) return target;
  const content = CONTENT_FIELDS.indexOf(name);
  if (content >= 0) return 100 + content;
  return 200;
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return isRecord(value) && Object.keys(value).length === 0;
}

/**
 * Top-level arguments as name and value, for tools without a dedicated view:
 * the target first, then the content, then the rest by name. Empty values
 * are marked so the page can list them on one line. Full values; nothing is
 * shortened (I-57).
 */
export function argumentLines(args: unknown): ArgumentLine[] {
  if (!isRecord(args)) {
    return [{ name: "value", value: JSON.stringify(args, null, 2) ?? "null", block: true }];
  }
  return Object.keys(args)
    .sort((a, b) => fieldRank(a) - fieldRank(b) || (a < b ? -1 : a > b ? 1 : 0))
    .map((name): ArgumentLine => {
      const value = args[name];
      const line = lineFor(name, value);
      return isEmpty(value) ? { ...line, empty: true } : line;
    });
}

function lineFor(name: string, value: unknown): ArgumentLine {
  if (typeof value === "string") {
    return { name, value, block: value.length > 80 || value.includes("\n") };
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return { name, value: String(value), block: false };
  }
  const list = strings(value);
  if (list !== null && list.every((v) => v.length <= 80)) {
    return { name, value: list.length === 0 ? "none" : list.join(", "), block: false };
  }
  return { name, value: JSON.stringify(value, null, 2) ?? "", block: true };
}

/**
 * A value cut in the middle to fit a headline: `michael.ma…@gmail.com`. Only
 * for the one-line title; the full value is always in the content below it
 * and in the full arguments (I-57).
 */
export function middle(value: string, max = 32): string {
  if (value.length <= max) return value;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - (keep - head))}`;
}

/**
 * Display names for MCP clients people are likely to use (as they name
 * themselves in `initialize`); anything else shows as it named itself.
 */
const KNOWN: Readonly<Record<string, string>> = {
  "claude-code": "Claude Code",
  "claude-ai": "Claude",
  "codex-mcp-client": "Codex",
  codex: "Codex",
  cursor: "Cursor",
  "cursor-vscode": "Cursor",
  "Visual Studio Code": "VS Code",
  windsurf: "Windsurf",
  "gemini-cli-mcp-client": "Gemini CLI",
  zed: "Zed",
  t3code: "T3 Code",
};

export function clientLabel(name: string): string {
  return KNOWN[name] ?? name;
}

/** An HTTP proxy request, as the approver reads it (spec: HTTP proxy). */
export interface HttpPreview {
  method: string;
  path: string;
  query: Readonly<Record<string, string | string[]>>;
  /** The body as rules saw it: pretty JSON, form fields, UTF-8 text, or a note about bytes. */
  body:
    | { kind: "none" }
    | { kind: "json"; text: string }
    | { kind: "text"; text: string; contentType: string }
    | { kind: "bytes"; size: number; contentType: string };
}

/**
 * The readable view of an HTTP proxy call. The stored arguments carry the
 * body base64-encoded, exactly as it's sent; this decodes it so the approver
 * reads what will be written, not an opaque string.
 */
export function httpPreviewFrom(call: {
  surface: string;
  args: unknown;
  http?: { method: string; path: string; query: Record<string, string | string[]>; body?: unknown };
}): HttpPreview | null {
  if (call.surface !== "http" || call.http === undefined || !isRecord(call.args)) return null;
  const { method, path, query } = call.http;
  const raw = call.args["body"];
  const contentType =
    typeof call.args["contentType"] === "string" ? call.args["contentType"] : "unknown";
  let body: HttpPreview["body"] = { kind: "none" };
  if (call.http.body !== undefined) {
    body = { kind: "json", text: JSON.stringify(call.http.body, null, 2) ?? "" };
  } else if (typeof raw === "string") {
    const bytes = Buffer.from(raw, "base64");
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      body = { kind: "text", text, contentType };
    } catch {
      body = { kind: "bytes", size: bytes.length, contentType };
    }
  }
  return { method, path, query, body };
}
