import type { HideCandidate } from "../../core/hide.ts";
import type { LooksLikeMessage, Unreadable } from "../../core/lookslike/types.ts";
import { parseAddressList } from "../../core/rules/address.ts";
import type { GmailLabel, GmailMessage, GmailPart } from "./client.ts";

/**
 * Turning a Gmail message into what hiding judges and what the agent reads.
 * Pure.
 *
 * Fail-closed choices:
 * - A header that is present but doesn't parse reaches hiding as written,
 *   so any entry that checks it can't decide, and the message hides.
 * - A label id heel can't name makes the candidate `null`: heel can't judge
 *   the message, so callers hide it.
 * - An encrypted, image-only or undecodable body is `unreadable`, which a
 *   `looks_like` entry hides.
 */

/** The value of a top-level header, matched case-insensitively; null when absent. */
export function header(message: GmailMessage, name: string): string | null {
  const lower = name.toLowerCase();
  return message.payload.headers?.find((h) => h.name.toLowerCase() === lower)?.value ?? null;
}

/** An address header as list elements; one that doesn't parse stays whole so checks on it fail closed. */
function addresses(message: GmailMessage, name: string): string[] {
  const value = header(message, name);
  if (value === null || value.trim() === "") return [];
  return parseAddressList(value) ?? [value];
}

/** Label ids to names; null when any id is unknown. */
export function labelNames(
  message: GmailMessage,
  labels: ReadonlyMap<string, GmailLabel>,
): string[] | null {
  const names: string[] = [];
  for (const id of message.labelIds) {
    const label = labels.get(id);
    if (label === undefined) return null;
    names.push(label.name);
  }
  return names;
}

const ENCRYPTED_TYPES = new Set([
  "multipart/encrypted",
  "application/pkcs7-mime",
  "application/x-pkcs7-mime",
  "application/pgp-encrypted",
]);

function walk(part: GmailPart, visit: (part: GmailPart) => void): void {
  visit(part);
  for (const child of part.parts ?? []) walk(child, visit);
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** A base64url body part as text; null when it doesn't decode. */
function decode(data: string): string | null {
  try {
    return UTF8.decode(Buffer.from(data, "base64url"));
  } catch {
    return null;
  }
}

export type MessageBody = Pick<LooksLikeMessage, "body" | "bodyFormat" | "unreadable">;

/** The readable body of a `full` message: plain text first, else HTML. */
export function messageBody(message: GmailMessage): MessageBody {
  const unreadable = (reason: Unreadable): MessageBody => ({
    body: "",
    bodyFormat: "text",
    unreadable: reason,
  });
  const parts: GmailPart[] = [];
  walk(message.payload, (part) => parts.push(part));
  const types = parts.map((part) => part.mimeType.toLowerCase());
  const encrypted = types.some((type) => ENCRYPTED_TYPES.has(type));
  const images = types.some((type) => type.startsWith("image/"));
  // Inline parts only: a named part is an attachment, not the body.
  const inline = parts.filter((part) => part.filename === undefined || part.filename === "");
  const plain = inline.find((part) => part.mimeType.toLowerCase() === "text/plain") ?? null;
  const htmlPart = inline.find((part) => part.mimeType.toLowerCase() === "text/html") ?? null;
  if (encrypted) return unreadable("encrypted");
  const chosen: GmailPart | null = plain ?? htmlPart;
  if (chosen === null) {
    return images ? unreadable("image_only") : { body: "", bodyFormat: "text" };
  }
  const data = chosen.body?.data;
  // A body Gmail moved to an attachment, or bytes that aren't UTF-8.
  if (data === undefined)
    return chosen.body?.size ? unreadable("unparseable") : { body: "", bodyFormat: "text" };
  const text = decode(data);
  if (text === null) return unreadable("unparseable");
  return { body: text, bodyFormat: chosen === plain ? "text" : "html" };
}

/**
 * What hiding judges for one message. Pass `body` only when the message was
 * read in `full` and an entry uses `looks_like`. Null when heel can't name
 * its labels, which the caller treats as hidden.
 */
export function hideCandidate(
  message: GmailMessage,
  labels: ReadonlyMap<string, GmailLabel>,
  body: MessageBody | undefined,
): HideCandidate | null {
  const names = labelNames(message, labels);
  if (names === null) return null;
  return {
    from: header(message, "From"),
    to: [...addresses(message, "To"), ...addresses(message, "Cc"), ...addresses(message, "Bcc")],
    subject: header(message, "Subject"),
    labels: names,
    ...(body === undefined ? {} : { body }),
  };
}

/** A message in a search result. Built field by field, never by deleting from Gmail's answer. */
export interface MessageSummary {
  id: string;
  thread_id: string;
  from: string | null;
  to: string | null;
  cc: string | null;
  subject: string | null;
  date: string | null;
  labels: string[];
  snippet: string;
}

export function messageSummary(message: GmailMessage, labels: readonly string[]): MessageSummary {
  return {
    id: message.id,
    thread_id: message.threadId,
    from: header(message, "From"),
    to: header(message, "To"),
    cc: header(message, "Cc"),
    subject: header(message, "Subject"),
    date: header(message, "Date"),
    labels: [...labels],
    snippet: message.snippet,
  };
}

export interface Attachment {
  filename: string;
  mime_type: string;
  size: number;
}

/** A whole message, as `get_message` and `get_thread` return it. */
export interface MessageDetail extends Omit<MessageSummary, "snippet"> {
  bcc: string | null;
  body: string;
  body_format: "text" | "html";
  /** Set when heel couldn't read the body: encrypted, image-only or undecodable. */
  body_unreadable?: Unreadable;
  attachments: Attachment[];
}

export function messageDetail(message: GmailMessage, labels: readonly string[]): MessageDetail {
  const { snippet: _snippet, ...summary } = messageSummary(message, labels);
  const body = messageBody(message);
  const attachments: Attachment[] = [];
  walk(message.payload, (part) => {
    if (part.filename !== undefined && part.filename !== "") {
      attachments.push({
        filename: part.filename,
        mime_type: part.mimeType,
        size: part.body?.size ?? 0,
      });
    }
  });
  return {
    ...summary,
    bcc: header(message, "Bcc"),
    body: body.body,
    body_format: body.bodyFormat === "html" ? "html" : "text",
    ...(body.unreadable === undefined ? {} : { body_unreadable: body.unreadable }),
    attachments,
  };
}
