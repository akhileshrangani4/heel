import type { HideCandidate, Hiding } from "../../core/hide.ts";
import { isPlainAddress, normalizeAddress } from "../../core/rules/address.ts";
import {
  type OutlookClient,
  type OutlookMessage,
  OutlookNotFoundError,
  type Recipient,
} from "./client.ts";

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

/** Folders a move into takes mail out of view (`email.remove`). */
export const REMOVAL_FOLDERS = [
  "deleteditems",
  "junkemail",
  "archive",
  "recoverableitemsdeletions",
] as const;

/**
 * Folders heel never moves mail into: Sent Items decides which mail counts
 * as the mailbox's own (`all_in_thread`, replies), and Drafts and Outbox
 * hold mail that is about to be sent.
 */
export const PROTECTED_FOLDERS = ["sentitems", "drafts", "outbox"] as const;

/** What a move into a folder does. */
export type Destination =
  | { kind: "label"; id: string }
  | { kind: "removal"; id: string }
  | { kind: "refused" };

/**
 * A folder Graph says doesn't exist is null; any other failure (a 429, a 5xx,
 * the network) is rethrown, so the call is denied rather than judged on a
 * guess. Treating a failed Sent Items lookup as "no such folder" would let a
 * move into it pass as a label change.
 */
function notFoundIsNull(error: unknown): null {
  if (error instanceof OutlookNotFoundError) return null;
  throw error;
}

/** One step up a folder chain. */
interface FolderNode {
  id: string;
  name: string;
  parentId: string | null;
  hidden: boolean;
}

/** The per-call view of an Outlook mailbox: folders, read once each, and the hiding test. */
export class OutlookMailbox {
  readonly client: OutlookClient;
  /** The account's mailbox address, from its settings. */
  readonly address: string;
  readonly #folders = new Map<string, Promise<FolderNode | null>>();
  readonly #wellKnown = new Map<string, Promise<string | null>>();

  constructor(client: OutlookClient, address: string) {
    this.client = client;
    this.address = address;
  }

  /** One folder, by id or well-known name; null when heel can't read it. */
  #folder(idOrName: string, signal: AbortSignal): Promise<FolderNode | null> {
    let node = this.#folders.get(idOrName);
    if (node === undefined) {
      node = this.client.getFolder(idOrName, signal).then(
        (f) => ({
          id: f.id,
          name: f.displayName,
          parentId: f.parentFolderId ?? null,
          hidden: f.isHidden,
        }),
        notFoundIsNull,
      );
      this.#folders.set(idOrName, node);
    }
    return node;
  }

  /**
   * A folder and its ancestors, nearest first, up to the mailbox root. Null
   * when any step can't be read, or the chain is implausibly deep.
   */
  async folderChain(idOrName: string, signal: AbortSignal): Promise<FolderNode[] | null> {
    const root = await this.wellKnownId("msgfolderroot", signal);
    const chain: FolderNode[] = [];
    let next: string | null = idOrName;
    while (next !== null && next !== root && chain.length < 20) {
      const node: FolderNode | null = await this.#folder(next, signal);
      if (node === null) return null;
      chain.push(node);
      next = node.parentId;
    }
    return chain.length >= 20 ? null : chain;
  }

  /** A well-known folder's id (`sentitems`, `deleteditems`, …), or null when the mailbox has none. */
  wellKnownId(name: string, signal: AbortSignal): Promise<string | null> {
    let id = this.#wellKnown.get(name);
    if (id === undefined) {
      id = this.client.getFolder(name, signal).then((folder) => folder.id, notFoundIsNull);
      this.#wellKnown.set(name, id);
    }
    return id;
  }

  /**
   * What moving mail into a folder does, judged by the folder's resolved
   * chain, never by the name the agent wrote: a removal if it or any
   * ancestor is a removal folder, or it is hidden; refused if it or any
   * ancestor is Sent Items, Drafts or Outbox, or it can't be read.
   */
  async destination(idOrName: string, signal: AbortSignal): Promise<Destination> {
    const chain = await this.folderChain(idOrName, signal);
    if (chain === null || chain.length === 0) return { kind: "refused" };
    const ids = new Set(chain.map((f) => f.id));
    const any = async (names: readonly string[]) =>
      (await Promise.all(names.map((n) => this.wellKnownId(n, signal)))).some(
        (id) => id !== null && ids.has(id),
      );
    if (await any(PROTECTED_FOLDERS)) return { kind: "refused" };
    const target = chain[0] as FolderNode;
    if ((await any(REMOVAL_FOLDERS)) || chain.some((f) => f.hidden)) {
      return { kind: "removal", id: target.id };
    }
    return { kind: "label", id: target.id };
  }

  /**
   * Whether the mailbox sent this message: it sits in Sent Items and isn't a
   * draft. A From header matching the mailbox proves nothing, since anyone
   * can write it, and heel never moves mail into Sent Items.
   */
  async sentByMailbox(message: OutlookMessage, signal: AbortSignal): Promise<boolean> {
    if (message.isDraft) return false;
    const sent = await this.wellKnownId("sentitems", signal);
    return sent !== null && message.parentFolderId === sent;
  }

  /** A message's folder path names, nearest first; null when heel can't read it. */
  async folderNames(message: OutlookMessage, signal: AbortSignal): Promise<string[] | null> {
    const chain = await this.folderChain(message.parentFolderId, signal);
    return chain === null ? null : chain.map((f) => f.name);
  }

  /**
   * What hiding judges for one message: its categories and every folder on
   * its path are its labels. Null when heel can't judge it: a field hiding
   * needs is missing, or its folders can't be read.
   */
  async candidate(
    message: OutlookMessage,
    withBody: boolean,
    signal: AbortSignal,
  ): Promise<HideCandidate | null> {
    if (!message.complete) return null;
    const folders = await this.folderNames(message, signal);
    if (folders === null) return null;
    return {
      from: displayAddress(message.from),
      to: [
        ...recipientList(message.toRecipients),
        ...recipientList(message.ccRecipients),
        ...recipientList(message.bccRecipients),
      ],
      subject: message.subject,
      labels: [...message.categories, ...folders],
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
    return [...message.categories, ...((await this.folderNames(message, signal)) ?? [])];
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
