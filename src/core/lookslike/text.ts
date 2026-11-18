/**
 * Turns a raw message into the text the detector reads: HTML stripped,
 * Unicode normalized, the body cut to its first 4 KB, and the body's URLs
 * listed (spec: Hiding, `looks_like` step 2).
 *
 * Every pass here is linear in the input. The HTML is attacker-controlled
 * mail, so the stripper is a hand-written scanner rather than regexes that
 * could backtrack on unclosed tags or comments.
 */
import type { LooksLikeMessage, Unreadable } from "./types.ts";

/** The classifier reads at most this much plain-text body (spec: first 4 KB). */
export const BODY_PREFIX_CHARS = 4096;
/** HTML beyond this is ignored, as body text beyond 4 KB is. */
export const HTML_INPUT_CAP = 256 * 1024;
const MAX_URLS = 64;
/** An HTML body with fewer letters than this, and at least one image, is image-only. */
const IMAGE_ONLY_MAX_LETTERS = 16;

export interface PreparedMessage {
  subject: string;
  from: string;
  /** Plain text, normalized, at most BODY_PREFIX_CHARS long. */
  body: string;
  /** Absolute http(s) URLs from the body: HTML hrefs first, then URLs in the text. */
  urls: string[];
  unreadable?: Unreadable;
}

export function prepareMessage(message: LooksLikeMessage): PreparedMessage {
  const subject = normalizeText(message.subject);
  const from = normalizeText(message.from);
  let text: string;
  let hrefs: string[] = [];
  let unreadable = message.unreadable;
  if (message.bodyFormat === "html") {
    const stripped = stripHtml(message.body.slice(0, HTML_INPUT_CAP));
    text = stripped.text;
    hrefs = stripped.hrefs;
    if (stripped.images > 0 && countLetters(text) < IMAGE_ONLY_MAX_LETTERS) {
      unreadable ??= "image_only";
    }
  } else {
    text = message.body;
  }
  const normalized = normalizeText(text);
  if (normalized.includes("-----BEGIN PGP MESSAGE-----")) unreadable ??= "encrypted";
  const urls = dedupe([...hrefs, ...textUrls(normalized)]).slice(0, MAX_URLS);
  const prepared: PreparedMessage = {
    subject,
    from,
    body: normalized.slice(0, BODY_PREFIX_CHARS),
    urls,
  };
  if (unreadable !== undefined) prepared.unreadable = unreadable;
  return prepared;
}

/** Soft hyphens, zero-width characters, bidi controls, variation selectors. */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu;
const SINGLE_QUOTES = /[\u2018\u2019\u201a\u201b\u02bc\u2032]/g;
const DOUBLE_QUOTES = /[\u201c\u201d\u201e\u201f\u2033]/g;
const DASHES = /[\u2010-\u2015\u2212]/g;
const INLINE_SPACE = /[ \t\f\v\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+/g;

/**
 * NFKC (so full-width and styled letters read as plain ASCII), invisible
 * characters removed (they are used to split keywords), quotes and dashes
 * folded, whitespace collapsed within lines. Newlines survive: the WICG
 * one-time-code format is line-based.
 */
export function normalizeText(input: string): string {
  return input
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, "-")
    .replace(/\r\n?/g, "\n")
    .replace(INLINE_SPACE, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Tags that end a line of text when rendered. */
const BLOCK_TAGS = new Set([
  "address",
  "article",
  "blockquote",
  "br",
  "div",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tr",
  "ul",
]);
/** Elements whose content is never rendered as text. */
const RAW_TEXT_TAGS = new Set(["script", "style"]);
const TAG_NAME = /^\/?([a-z][a-z0-9]*)/;
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

export interface StrippedHtml {
  text: string;
  hrefs: string[];
  images: number;
}

/**
 * One left-to-right pass. Each `indexOf` starts past the previous match, and
 * a missing terminator ends the scan, so the cost is linear in the input.
 * Hidden elements (preheaders, `display:none`) keep their text: the agent
 * could read it in the raw HTML.
 */
export function stripHtml(html: string): StrippedHtml {
  const lower = asciiLower(html);
  const out: string[] = [];
  const hrefs: string[] = [];
  let images = 0;
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));
    if (lower.startsWith("<!--", lt)) {
      const end = lower.indexOf("-->", lt + 4);
      out.push(" ");
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) {
      // No later '>' exists, so no later tag can close: the rest is text.
      out.push(html.slice(lt));
      break;
    }
    const tag = lower.slice(lt + 1, gt);
    const name = TAG_NAME.exec(tag)?.[1];
    const closing = tag.startsWith("/");
    if (name !== undefined && RAW_TEXT_TAGS.has(name) && !closing) {
      const close = lower.indexOf(`</${name}`, gt + 1);
      const closeEnd = close === -1 ? -1 : lower.indexOf(">", close);
      out.push(" ");
      i = closeEnd === -1 ? html.length : closeEnd + 1;
      continue;
    }
    if (name === "a" && !closing) {
      const href = HREF.exec(html.slice(lt, gt + 1));
      const value = href?.[1] ?? href?.[2] ?? href?.[3];
      if (value !== undefined) hrefs.push(decodeEntities(value).trim());
    } else if (name === "img") {
      images += 1;
    }
    out.push(name !== undefined && BLOCK_TAGS.has(name) ? "\n" : " ");
    i = gt + 1;
  }
  return { text: decodeEntities(out.join("")), hrefs: hrefs.filter(isHttpUrl), images };
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  zwnj: "",
  zwj: "",
  shy: "",
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  ndash: "-",
  mdash: "-",
  hellip: "...",
  copy: "(c)",
  reg: "(r)",
  trade: "(tm)",
  middot: "·",
  bull: "·",
};

const ENTITY = /&(#[0-9]{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,7});/gi;

export function decodeEntities(input: string): string {
  return input.replace(ENTITY, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      // Lone surrogates and out-of-range values would make an invalid string.
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

const TEXT_URL = /\bhttps?:\/\/[^\s<>"'(){}[\]]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/** URLs written out in plain text, without trailing sentence punctuation. */
export function textUrls(text: string): string[] {
  return Array.from(text.matchAll(TEXT_URL), (m) => m[0].replace(TRAILING_PUNCTUATION, ""));
}

/**
 * Lower-cases A-Z only. Unlike `toLowerCase`, it never changes the string's
 * length (`İ` lower-cases to two code units), so indices found in the result
 * are valid in the original.
 */
export function asciiLower(input: string): string {
  return input.replace(/[A-Z]+/g, (run) => run.toLowerCase());
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function countLetters(text: string): number {
  let letters = 0;
  for (const ch of text) if (/\p{L}/u.test(ch)) letters += 1;
  return letters;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}
