import MailComposer from "nodemailer/lib/mail-composer";
import { isPlainAddress, normalizeAddress, splitAddressList } from "../../core/rules/address.ts";

/**
 * Outgoing mail as RFC 5322 bytes, and the headers of mail heel didn't
 * write (a draft). Gmail sends to exactly the To, Cc and Bcc headers of the
 * raw message (research §2.1), so these functions decide where mail goes.
 *
 * Three parsers read every address: heel's, nodemailer's and Gmail's. To
 * keep them from disagreeing:
 * - heel sends only to plain addresses (a dot-atom local part, no quotes);
 * - addresses reach nodemailer as objects, never as text to parse;
 * - after composing, heel reads To, Cc and Bcc back out of the bytes and
 *   refuses to send unless they are exactly the lists it checked;
 * - a draft's headers are read strictly: anything a lenient parser could
 *   read two ways is refused.
 *
 * Agent text only ever reaches nodemailer as plain string fields. Nothing
 * here passes `path` or `href`, which would read a file or a URL.
 */

/** A message heel composes. Addresses are plain addr-specs heel already checked. */
export interface Outgoing {
  from: string;
  to: readonly string[];
  cc: readonly string[];
  bcc: readonly string[];
  subject: string;
  text: string;
  html?: string | undefined;
  /** Threading headers, for replies and forwards (RFC 5322 §3.6.4). */
  inReplyTo?: string | undefined;
  references?: readonly string[] | undefined;
  /** A forwarded message, attached whole as message/rfc822. */
  forwarded?: Buffer | undefined;
}

/** The composed bytes put a recipient somewhere heel didn't check: nothing is sent. */
export class ComposeMismatchError extends Error {
  override readonly name = "ComposeMismatchError";
}

const mailboxes = (list: readonly string[]) => list.map((address) => ({ name: "", address }));

/**
 * The raw message, base64url-encoded as `messages.send` takes it. Throws
 * `ComposeMismatchError` if the bytes don't carry exactly the given From,
 * To, Cc and Bcc.
 */
export async function composeRaw(message: Outgoing): Promise<string> {
  const node = new MailComposer({
    from: { name: "", address: message.from },
    to: mailboxes(message.to),
    cc: mailboxes(message.cc),
    bcc: mailboxes(message.bcc),
    subject: message.subject,
    text: message.text,
    ...(message.html === undefined ? {} : { html: message.html }),
    ...(message.inReplyTo === undefined ? {} : { inReplyTo: message.inReplyTo }),
    ...(message.references === undefined ? {} : { references: [...message.references] }),
    ...(message.forwarded === undefined
      ? {}
      : {
          attachments: [
            {
              content: withoutBcc(message.forwarded),
              contentType: "message/rfc822",
              filename: "forwarded.eml",
            },
          ],
        }),
  }).compile();
  // Gmail reads Bcc from the header and strips it before delivery.
  node.keepBcc = true;
  const bytes = await node.build();
  verifyEnvelope(bytes, message);
  return bytes.toString("base64url");
}

function verifyEnvelope(bytes: Buffer, message: Outgoing): void {
  const headers = rawHeaders(bytes);
  if (headers === null) throw new ComposeMismatchError("the composed message has no headers");
  const same = (name: string, expected: readonly string[]) => {
    const values = headers.get(name) ?? [];
    if (values.length > 1) return false;
    const read = values.length === 0 ? [] : strictAddressList(values[0] ?? "");
    return read !== null && read.join(",") === expected.join(",");
  };
  if (!same("from", [message.from]) || !same("to", message.to) || !same("cc", message.cc)) {
    throw new ComposeMismatchError("the composed message's addresses differ from the checked ones");
  }
  if (!same("bcc", message.bcc)) {
    throw new ComposeMismatchError("the composed message's Bcc differs from the checked one");
  }
}

/**
 * A forwarded original without its Bcc or Resent-Bcc headers: forwarding
 * must not reveal who was blind-copied. With no blank line ending the
 * headers, the whole message is treated as headers, so nothing slips by.
 */
export function withoutBcc(raw: Buffer): Buffer {
  const text = raw.toString("latin1");
  const match = /\r\n\r\n|\n\n|\r\r/.exec(text);
  const end = match === null ? text.length : match.index;
  const kept: string[] = [];
  let skipping = false;
  for (const line of text.slice(0, end).split(/\r\n|\n|\r/)) {
    if (/^[ \t]/.test(line)) {
      if (!skipping) kept.push(line);
      continue;
    }
    skipping = /^(?:resent-)?bcc\s*:/i.test(line);
    if (!skipping) kept.push(line);
  }
  return Buffer.from(`${kept.join("\r\n")}${text.slice(end)}`, "latin1");
}

/**
 * The top-level headers of a raw message, unfolded, keyed by lower-case
 * name; a repeated header keeps every value. Null when the header block
 * isn't plainly readable: no blank line ending it, a bare CR, or a line
 * that is neither a header nor a continuation. The caller denies.
 */
export function rawHeaders(raw: Buffer): Map<string, string[]> | null {
  const text = raw.toString("latin1");
  const crlf = text.indexOf("\r\n") !== -1;
  // One line-ending style throughout the headers and their terminator, so
  // heel and the provider end the header block in the same place.
  const terminator = crlf ? "\r\n\r\n" : "\n\n";
  const end = text.indexOf(terminator);
  if (end <= 0) return null;
  const block = text.slice(0, end);
  if (crlf ? /\r(?!\n)|(?<!\r)\n/.test(block) : /\r/.test(block)) return null;
  const headers = new Map<string, string[]>();
  let current: { name: string; value: string } | null = null;
  const flush = () => {
    if (current === null) return;
    const list = headers.get(current.name) ?? [];
    list.push(current.value.trim());
    headers.set(current.name, list);
  };
  for (const line of block.split(crlf ? "\r\n" : "\n")) {
    if (/^[ \t]/.test(line)) {
      if (current === null) return null;
      current.value += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0 || !/^[!-9;-~]+$/.test(line.slice(0, colon))) return null;
    flush();
    current = { name: line.slice(0, colon).toLowerCase(), value: line.slice(colon + 1) };
  }
  flush();
  return headers;
}

// One mailbox, read strictly: a bare address, or `Name <address>` /
// `"Name" <address>` whose name holds no `<`, `>` or `@`.
const BARE = /^([^\s<>"(),;:@]+@[^\s<>"(),;:@]+)$/;
const NAMED =
  /^(?:"(?:[^"\\<>@\r\n]|\\[^<>@\r\n])*"|[^"<>@,;:\r\n]*)\s*<([^\s<>"(),;:@]+@[^\s<>"(),;:@]+)>$/;

const ENCODED_WORD = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;

/**
 * Whether decoding an RFC 2047 encoded word in a display name could yield
 * address syntax (`<`, `>`, `@`, `,`, `;`, `:`, `"`), as a decoding parser
 * would read it. Undecodable words count as yes.
 */
function encodedWordHidesAddress(part: string): boolean {
  for (const [, , encoding, data] of part.matchAll(ENCODED_WORD)) {
    let decoded: string;
    try {
      decoded =
        encoding?.toLowerCase() === "b"
          ? Buffer.from(data ?? "", "base64").toString("latin1")
          : (data ?? "")
              .replaceAll("_", " ")
              .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) =>
                String.fromCharCode(Number.parseInt(hex, 16)),
              );
    } catch {
      return true;
    }
    if (/[<>@,;:"]/.test(decoded)) return true;
  }
  return false;
}

/**
 * An address header as plain addr-specs, or null when any part is not one
 * plain mailbox. Stricter than `parseAddressList` on purpose: it is used
 * where a header decides delivery, so anything ambiguous is refused.
 */
export function strictAddressList(value: string): string[] | null {
  const parts = splitAddressList(value)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  const addresses: string[] = [];
  for (const part of parts) {
    if (encodedWordHidesAddress(part)) return null;
    const spec = BARE.exec(part)?.[1] ?? NAMED.exec(part)?.[1];
    const address = spec === undefined ? null : normalizeAddress(spec);
    if (address === null || !isPlainAddress(address)) return null;
    addresses.push(address);
  }
  return addresses;
}

/** Headers that change who receives or appears to send a message; a draft with any is refused. */
export const DELIVERY_HEADERS_REFUSED =
  /^(resent-.*|sender|return-path|apparently-to|envelope-to|x-original-to|delivered-to)$/;

/**
 * Who a draft sends to and from, read strictly from its own headers. Null
 * when anything could be read two ways: a header heel can't parse plainly,
 * a repeated From, To, Cc or Bcc, or a header that changes delivery.
 */
export function draftEnvelope(raw: Buffer) {
  const headers = rawHeaders(raw);
  if (headers === null) return null;
  if ([...headers.keys()].some((name) => DELIVERY_HEADERS_REFUSED.test(name))) return null;
  const single = (name: string): string[] | null => {
    const values = headers.get(name) ?? [];
    if (values.length > 1) return null;
    // Bytes outside ASCII would be read as latin1 here and as UTF-8 elsewhere.
    if (values.some((value) => [...value].some((c) => c.charCodeAt(0) > 0x7f))) return null;
    return values.length === 0 ? [] : strictAddressList(values[0] ?? "");
  };
  const from = single("from");
  const to = single("to");
  const cc = single("cc");
  const bcc = single("bcc");
  if (from === null || from.length !== 1 || to === null || cc === null || bcc === null) return null;
  const subject = (headers.get("subject") ?? []).join(" ");
  return { from: from[0] as string, to, cc, bcc, subject };
}
