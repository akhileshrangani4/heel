import type { HideCandidate, Hiding } from "../../core/hide.ts";
import { isPlainAddress, normalizeAddress } from "../../core/rules/address.ts";
import type { OutlookClient, OutlookMessage, Recipient } from "./client.ts";

/**
 * Turning a Graph message into what hiding judges and what the agent reads,
 * and the per-call mailbox the Outlook tools share.
 *
 * Fail-closed choices, as for Gmail:
 * - An address heel can't read reaches hiding as written, so any entry that
 *   checks it can't decide, and the message hides.
 * - `labels` are the message's categories plus its folder's name. A folder
 *   heel can't name makes the candidate null: the caller hides it.
 * - A message with attachments and no body text is `unreadable` (S/MIME and
 *   image-only mail look like this), which a `looks_like` entry hides.
 */

/** `Name <address>` as written, or the bare address. */
export function displayAddress(recipient: Recipient | null | undefined): string | null {
  const address = recipient?.emailAddress.address;
  if (address === null || address === undefined || address === "") return null;
  const name = recipient?.emailAddress.name;
  return name !== null && name !== undefined && name !== "" && name !== address
    ? `${name} <${address}>`
    : address;
}

/** Recipients as list elements: normalized where they read plainly, as written otherwise. */
function recipientList(recipients: readonly Recipient[]): string[] {
  return recipients.flatMap((r) => {
    const address = r.emailAddress.address;
    if (address === null || address === undefined || address === "") return [];
    return [normalizeAddress(address) ?? address];
  });
}

/**
 * Recipients that decide where a reply goes: plain addresses only. Null
 * when any isn't one, so the caller refuses rather than guess.
 */
export function plainRecipients(recipients: readonly Recipient[]): string[] | null {
  const out: string[] = [];
  for (const r of recipients) {
    const address = normalizeAddress(r.emailAddress.address ?? "");
    if (address === null || !isPlainAddress(address)) return null;
    out.push(address);
  }
  return out;
}

export interface OutlookBody {
  body: string;
  bodyFormat: "text" | "html";
  unreadable?: "unparseable";
}

/** The readable body; Graph is asked for text, but may answer HTML. */
export function messageBody(message: OutlookMessage): OutlookBody {
  const content = message.body?.content ?? "";
  if (content.trim() === "" && message.hasAttachments) {
    return { body: "", bodyFormat: "text", unreadable: "unparseable" };
  }
  return {
    body: content,
    bodyFormat: message.body?.contentType.toLowerCase() === "html" ? "html" : "text",
  };
}

/** Folder names by id, read once per call and only when asked. */
export class OutlookMailbox {
  readonly client: OutlookClient;
  /** The account's mailbox address, from its settings. */
  readonly address: string;
  readonly #folders = new Map<string, Promise<string | null>>();
  readonly #wellKnown = new Map<string, Promise<string>>();

  constructor(client: OutlookClient, address: string) {
    this.client = client;
    this.address = address;
  }

  /** A folder's display name, or null when heel can't read it. */
  folderName(id: string, signal: AbortSignal): Promise<string | null> {
    let name = this.#folders.get(id);
    if (name === undefined) {
      name = this.client.getFolder(id, signal).then(
        (folder) => folder.displayName,
        () => null,
      );
      this.#folders.set(id, name);
    }
    return name;
  }

  /** A well-known folder's id (`sentitems`, `deleteditems`, …), read once per call. */
  wellKnownId(name: string, signal: AbortSignal): Promise<string> {
    let id = this.#wellKnown.get(name);
    if (id === undefined) {
      id = this.client.getFolder(name, signal).then((folder) => folder.id);
      this.#wellKnown.set(name, id);
    }
    return id;
  }

  /**
   * Whether the mailbox sent this message: it sits in Sent Items and isn't a
   * draft. A From header matching the mailbox proves nothing, since anyone
   * can write it.
   */
  async sentByMailbox(message: OutlookMessage, signal: AbortSignal): Promise<boolean> {
    if (message.isDraft) return false;
    return message.parentFolderId === (await this.wellKnownId("sentitems", signal));
  }

  /** What hiding judges for one message; null when heel can't name its folder. */
  async candidate(
    message: OutlookMessage,
    withBody: boolean,
    signal: AbortSignal,
  ): Promise<HideCandidate | null> {
    const folder = await this.folderName(message.parentFolderId, signal);
    if (folder === null) return null;
    return {
      from: displayAddress(message.from),
      to: [
        ...recipientList(message.toRecipients),
        ...recipientList(message.ccRecipients),
        ...recipientList(message.bccRecipients),
      ],
      subject: message.subject,
      labels: [...message.categories, folder],
      ...(withBody ? { body: messageBody(message) } : {}),
    };
  }

  /** Whether a message is hidden. A message heel can't judge is. */
  async isHidden(message: OutlookMessage, hiding: Hiding, signal: AbortSignal): Promise<boolean> {
    if (hiding.entries.length === 0) return false;
    const candidate = await this.candidate(message, hiding.needsBody, signal);
    return candidate === null || hiding.isHidden(candidate);
  }

  /** Reads a message a call is aimed at, and whether it's hidden (I-42). */
  async target(id: string, hiding: Hiding, signal: AbortSignal) {
    const message = await this.client.getMessage(id, signal);
    return { message, hidden: await this.isHidden(message, hiding, signal) };
  }

  async labels(message: OutlookMessage, signal: AbortSignal): Promise<string[]> {
    const folder = await this.folderName(message.parentFolderId, signal);
    return folder === null ? [...message.categories] : [...message.categories, folder];
  }
}

/** A message in a search result, built field by field. */
export interface MessageSummary {
  id: string;
  conversation_id: string;
  from: string | null;
  to: string[];
  cc: string[];
  subject: string | null;
  date: string | null;
  labels: string[];
  preview: string;
  is_draft: boolean;
}

const shown = (recipients: readonly Recipient[]) =>
  recipients.map(displayAddress).filter((a): a is string => a !== null);

export function messageSummary(message: OutlookMessage, labels: string[]): MessageSummary {
  return {
    id: message.id,
    conversation_id: message.conversationId,
    from: displayAddress(message.from),
    to: shown(message.toRecipients),
    cc: shown(message.ccRecipients),
    subject: message.subject,
    date: message.receivedDateTime ?? null,
    labels,
    preview: message.bodyPreview,
    is_draft: message.isDraft,
  };
}

export interface MessageDetail extends Omit<MessageSummary, "preview"> {
  bcc: string[];
  reply_to: string[];
  body: string;
  body_format: "text" | "html";
  body_unreadable?: "unparseable";
  has_attachments: boolean;
}

export function messageDetail(message: OutlookMessage, labels: string[]): MessageDetail {
  const { preview: _preview, ...summary } = messageSummary(message, labels);
  const body = messageBody(message);
  return {
    ...summary,
    bcc: shown(message.bccRecipients),
    reply_to: shown(message.replyTo),
    body: body.body,
    body_format: body.bodyFormat,
    ...(body.unreadable === undefined ? {} : { body_unreadable: body.unreadable }),
    has_attachments: message.hasAttachments,
  };
}
