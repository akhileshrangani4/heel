import { draftEnvelope, rawHeaders } from "./mime.ts";

/**
 * A raw RFC 5322 message an agent sends over Gmail's REST path, read into
 * the fields heel's own `send` tool takes. heel then composes and
 * sends its own bytes from those fields, so what is checked is what is sent
 * (the same rule as every other send).
 *
 * Only plain mail is read: one `text/plain` or `text/html` part, or a
 * `multipart/alternative` of exactly those, in UTF-8 or US-ASCII, with a
 * 7bit, 8bit, quoted-printable or base64 transfer encoding. Attachments,
 * other charsets, nested multiparts, threading headers, Reply-To and
 * anything read two ways are refused (null). Headers other than the envelope, Subject and the
 * MIME ones are not carried over. Pure.
 */

export interface PlainMessage {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  html?: string;
}

const MAX_PARTS = 2;

function splitHead(raw: Buffer): { head: Buffer; body: Buffer } | null {
  const text = raw.toString("latin1");
  const crlf = text.indexOf("\r\n\r\n");
  const lf = text.indexOf("\n\n");
  const at = crlf !== -1 && (lf === -1 || crlf < lf) ? crlf : lf;
  if (at === -1) return null;
  const skip = at === crlf ? 4 : 2;
  return { head: raw.subarray(0, at + skip), body: raw.subarray(at + skip) };
}

/** `type/subtype; a=b; c="d"` into its parts; null when it doesn't read plainly. */
function contentType(
  value: string | undefined,
): { type: string; params: Map<string, string> } | null {
  if (value === undefined) return { type: "text/plain", params: new Map() };
  const [type, ...rest] = value.split(";");
  const params = new Map<string, string>();
  for (const part of rest) {
    const match = /^\s*([A-Za-z0-9_-]+)\s*=\s*(?:"([^"\\]*)"|([^\s";]+))\s*$/.exec(part);
    if (match === null) return null;
    const name = (match[1] as string).toLowerCase();
    if (params.has(name)) return null;
    params.set(name, match[2] ?? match[3] ?? "");
  }
  return { type: (type ?? "").trim().toLowerCase(), params };
}

function decodeText(body: Buffer, encoding: string | undefined, charset: string | undefined) {
  const cs = (charset ?? "us-ascii").toLowerCase();
  if (cs !== "utf-8" && cs !== "us-ascii" && cs !== "utf8") return null;
  const cte = (encoding ?? "7bit").trim().toLowerCase();
  let bytes: Buffer;
  if (cte === "7bit" || cte === "8bit") {
    bytes = body;
  } else if (cte === "base64") {
    const clean = body.toString("latin1").replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return null;
    bytes = Buffer.from(clean, "base64");
  } else if (cte === "quoted-printable") {
    const raw = body.toString("latin1");
    // Every `=` starts a soft line break or a two-digit escape; anything else reads two ways.
    if (/=(?![0-9A-Fa-f]{2}|\r?\n)/.test(raw)) return null;
    const text = raw
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
    bytes = Buffer.from(text, "latin1");
  } else {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** A Subject with RFC 2047 UTF-8 encoded words decoded; null for anything else non-ASCII. */
function subjectText(values: readonly string[] | undefined): string | null {
  if (values === undefined || values.length === 0) return "";
  if (values.length > 1) return null;
  const raw = values[0] as string;
  if ([...raw].some((c) => c.charCodeAt(0) > 0x7e)) return null;
  let failed = false;
  const decoded = raw.replace(
    /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=(\s+(?==\?))?/g,
    (_m, charset: string, enc: string, data: string) => {
      if (charset.toLowerCase() !== "utf-8") {
        failed = true;
        return "";
      }
      const bytes =
        enc.toLowerCase() === "b"
          ? Buffer.from(data, "base64")
          : Buffer.from(
              data
                .replaceAll("_", " ")
                .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) =>
                  String.fromCharCode(Number.parseInt(hex, 16)),
                ),
              "latin1",
            );
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        failed = true;
        return "";
      }
    },
  );
  // No control characters but tab: nothing that could start a new header once composed.
  if (failed || [...decoded].some((c) => c.charCodeAt(0) < 0x20 && c !== "\t")) return null;
  return decoded;
}

/** One leaf part's text, or null. */
function leaf(
  type: string,
  params: Map<string, string>,
  encoding: string | undefined,
  body: Buffer,
): { kind: "text" | "html"; text: string } | null {
  if (type !== "text/plain" && type !== "text/html") return null;
  const text = decodeText(body, encoding, params.get("charset"));
  return text === null ? null : { kind: type === "text/plain" ? "text" : "html", text };
}

export function readPlainMessage(raw: Buffer): PlainMessage | null {
  const envelope = draftEnvelope(raw);
  const headers = rawHeaders(raw);
  const split = splitHead(raw);
  if (envelope === null || headers === null || split === null) return null;
  const single = (name: string) => {
    const values = headers.get(name);
    return values !== undefined && values.length > 1 ? null : values?.[0];
  };
  if (headers.has("in-reply-to") || headers.has("references")) return null;
  // Reply-To decides where answers go and heel wouldn't carry it over; refused rather than dropped.
  if (headers.has("reply-to")) return null;
  const subject = subjectText(headers.get("subject"));
  const ct = single("content-type");
  const cte = single("content-transfer-encoding");
  if (subject === null || ct === null || cte === null) return null;
  const top = contentType(ct);
  if (top === null) return null;

  let parts: { kind: "text" | "html"; text: string }[];
  if (top.type === "multipart/alternative") {
    const boundary = top.params.get("boundary");
    if (boundary === undefined || boundary === "" || cte !== undefined) return null;
    const text = split.body.toString("latin1");
    const delimiter = new RegExp(
      `(?:^|\\r?\\n)--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(--)?[ \\t]*(?:\\r?\\n|$)`,
      "g",
    );
    const marks = [...text.matchAll(delimiter)];
    const close = marks.findIndex((m) => m[1] === "--");
    if (marks.length < 2 || close !== marks.length - 1) return null;
    parts = [];
    for (let i = 0; i < marks.length - 1; i++) {
      const start = (marks[i]?.index ?? 0) + (marks[i]?.[0].length ?? 0);
      const end = marks[i + 1]?.index ?? text.length;
      const partRaw = Buffer.from(text.slice(start, end), "latin1");
      const partHeaders = rawHeaders(partRaw);
      const partSplit = splitHead(partRaw);
      if (partHeaders === null || partSplit === null) return null;
      for (const name of partHeaders.keys()) {
        if (name !== "content-type" && name !== "content-transfer-encoding") return null;
      }
      const pct = contentType(partHeaders.get("content-type")?.[0]);
      if (pct === null || (partHeaders.get("content-type")?.length ?? 0) > 1) return null;
      const part = leaf(
        pct.type,
        pct.params,
        partHeaders.get("content-transfer-encoding")?.[0],
        partSplit.body,
      );
      if (part === null) return null;
      parts.push(part);
    }
    if (parts.length > MAX_PARTS) return null;
  } else {
    const part = leaf(top.type, top.params, cte, split.body);
    if (part === null) return null;
    parts = [part];
  }
  const texts = parts.filter((p) => p.kind === "text");
  const htmls = parts.filter((p) => p.kind === "html");
  if (texts.length > 1 || htmls.length > 1) return null;
  return {
    from: envelope.from,
    to: envelope.to,
    cc: envelope.cc,
    bcc: envelope.bcc,
    subject,
    body: texts[0]?.text ?? "",
    ...(htmls[0] === undefined ? {} : { html: htmls[0].text }),
  };
}
