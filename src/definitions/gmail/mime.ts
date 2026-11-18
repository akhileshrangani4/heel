import MailComposer from "nodemailer/lib/mail-composer";

/**
 * Outgoing mail as RFC 5322 bytes, and the headers of mail heel didn't write
 * (a draft). Gmail sends to exactly the To, Cc and Bcc headers of the raw
 * message (research §2.1), so these two functions are what heel checks and
 * what Gmail acts on.
 *
 * Agent text only ever reaches nodemailer as plain string fields. Nothing
 * here passes `path` or `href`, which would read a file or a URL.
 */

/** A message heel composes. Addresses are bare addr-specs heel already checked. */
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

/** The raw message, base64url-encoded as `messages.send` takes it. */
export async function composeRaw(message: Outgoing): Promise<string> {
  const node = new MailComposer({
    from: message.from,
    to: [...message.to],
    cc: [...message.cc],
    bcc: [...message.bcc],
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
              content: message.forwarded,
              contentType: "message/rfc822",
              filename: "forwarded.eml",
            },
          ],
        }),
  }).compile();
  // Gmail reads Bcc from the header and strips it before delivery.
  node.keepBcc = true;
  return (await node.build()).toString("base64url");
}

/**
 * The top-level headers of a raw message, unfolded, keyed by lower-case
 * name; a repeated header keeps every value. Null when there is no header
 * block, so the caller denies instead of guessing.
 */
export function rawHeaders(raw: Buffer): Map<string, string[]> | null {
  const text = raw.toString("latin1");
  const end = text.search(/\r?\n\r?\n/);
  if (end <= 0) return null;
  const lines = text.slice(0, end).split(/\r?\n/);
  const headers = new Map<string, string[]>();
  let current: { name: string; value: string } | null = null;
  const flush = () => {
    if (current === null) return;
    const list = headers.get(current.name) ?? [];
    list.push(current.value.trim());
    headers.set(current.name, list);
  };
  for (const line of lines) {
    if (/^[ \t]/.test(line)) {
      if (current === null) return null;
      current.value += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) return null;
    flush();
    current = { name: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1) };
  }
  flush();
  return headers;
}
