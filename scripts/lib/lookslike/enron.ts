/**
 * Ordinary mail for the `looks_like` corpus: messages from the CMU Enron
 * maildir release (2015-05-07). The text never enters the repo; the
 * manifest pins the archive by SHA-256 and lists the sampled paths with a
 * hash of each message's content, and the scripts rebuild the sample from a
 * verified local copy.
 */
import { sha256, unitHash } from "./hashing.ts";

export interface EnronMessage {
  /** Archive path, e.g. `maildir/allen-p/inbox/12.` */
  path: string;
  /** Mailbox owner, the second path segment. */
  user: string;
  subject: string;
  from: string;
  body: string;
}

/** Splits RFC 822 headers from the body and unfolds continuation lines. */
function splitHeaders(text: string): { headers: Map<string, string>; body: string } {
  const normalized = text.replace(/\r\n?/g, "\n");
  const split = normalized.indexOf("\n\n");
  const head = split === -1 ? normalized : normalized.slice(0, split);
  const body = split === -1 ? "" : normalized.slice(split + 2);
  const headers = new Map<string, string>();
  let last: string | undefined;
  for (const line of head.split("\n")) {
    if (/^[ \t]/.test(line) && last !== undefined) {
      headers.set(last, `${headers.get(last) ?? ""} ${line.trim()}`);
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    last = line.slice(0, colon).trim().toLowerCase();
    // First occurrence wins, as mail clients display it.
    if (!headers.has(last)) headers.set(last, line.slice(colon + 1).trim());
  }
  return { headers, body };
}

export function decodeQuotedPrintable(input: string): string {
  return input
    .replace(/=\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
}

/**
 * Parses one maildir file. Enron files are 7-bit or Latin-1 text with a
 * single text/plain body; quoted-printable bodies are decoded.
 */
export function parseEnronMessage(path: string, data: Buffer): EnronMessage {
  const user = path.split("/")[1] ?? "";
  const { headers, body } = splitHeaders(data.toString("latin1"));
  const encoding = (headers.get("content-transfer-encoding") ?? "").toLowerCase();
  const xFrom = headers.get("x-from") ?? "";
  const address = headers.get("from") ?? "";
  const from = xFrom.length > 0 && !xFrom.includes("<") ? `${xFrom} <${address}>` : address;
  return {
    path,
    user,
    subject: headers.get("subject") ?? "",
    from,
    body: encoding === "quoted-printable" ? decodeQuotedPrintable(body) : body,
  };
}

/**
 * Identity of a message's content, for deduplication and for verifying a
 * rebuilt sample: the same mail filed in several folders (inbox,
 * all_documents, discussion_threads) or mailboxes hashes the same.
 */
export function contentHash(message: Pick<EnronMessage, "subject" | "from" | "body">): string {
  const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
  return sha256(
    `${collapse(message.from)}\n${collapse(message.subject)}\n${collapse(message.body)}`,
  );
}

export interface IndexedMessage {
  path: string;
  user: string;
  contentHash: string;
}

export interface OrdinarySelection {
  seed: string;
  /** Share of mailbox owners whose mail goes to the held-out split. */
  heldOutUserShare: number;
  trainCount: number;
  heldOutCount: number;
}

export interface OrdinarySample {
  train: IndexedMessage[];
  heldOut: IndexedMessage[];
}

/**
 * Deterministic sample:
 * 1. one copy per content hash (the lexicographically first path), so the
 *    same text can never land in both splits;
 * 2. mailbox owners are split by `unitHash`, so held-out mail comes from
 *    different mailboxes than training mail (a correspondent can still
 *    appear in both, since one person writes to many mailboxes);
 * 3. within each split, messages are ranked by `unitHash` of their content
 *    and the first N taken.
 */
export function selectOrdinarySample(
  index: readonly IndexedMessage[],
  selection: OrdinarySelection,
): OrdinarySample {
  const firstCopy = new Map<string, IndexedMessage>();
  for (const message of index) {
    const seen = firstCopy.get(message.contentHash);
    if (seen === undefined || message.path < seen.path) firstCopy.set(message.contentHash, message);
  }
  const train: Array<{ rank: number; message: IndexedMessage }> = [];
  const heldOut: Array<{ rank: number; message: IndexedMessage }> = [];
  for (const message of firstCopy.values()) {
    const held = unitHash(selection.seed, `user:${message.user}`) < selection.heldOutUserShare;
    const rank = unitHash(selection.seed, `msg:${message.contentHash}`);
    (held ? heldOut : train).push({ rank, message });
  }
  const take = (items: typeof train, count: number) =>
    items
      .sort((a, b) => a.rank - b.rank || (a.message.path < b.message.path ? -1 : 1))
      .slice(0, count)
      .map((item) => item.message)
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    train: take(train, selection.trainCount),
    heldOut: take(heldOut, selection.heldOutCount),
  };
}

/** Whether an archive path is a message file (maildir/<user>/<folder...>/<n>.). */
export function isMessagePath(path: string): boolean {
  return path.startsWith("maildir/") && path.split("/").length >= 4 && !path.endsWith("/");
}
