import { domainToASCII } from "node:url";

/**
 * Address and domain normalization (spec: Rules, "Address and domain
 * normalization"). Applied to rule operands when a file loads and to call
 * values before any check, so both sides compare in one form:
 *
 * - only the addr-spec is kept, lower-cased; `user+tag@x.com` stays as written;
 * - domains go through IDNA to punycode;
 * - anything that doesn't parse returns null, and the caller denies.
 */

// RFC 5322 atext, plus non-ASCII letters and digits for RFC 6532 local parts.
const ATOM = "[\\p{L}\\p{N}!#$%&'*+/=?^_`{|}~-]+";
const DOT_ATOM = new RegExp(`^${ATOM}(?:\\.${ATOM})*$`, "u");
const QUOTED_LOCAL = /^"(?:[^"\\\r\n]|\\.)*"$/u;
const ASCII_DOMAIN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/;
const ANGLE_ADDR = /<([^<>]*)>\s*$/u;

/** The domain in punycode, lower-cased; null when it isn't a valid hostname. */
export function normalizeDomain(text: string): string | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "" || trimmed.endsWith(".")) return null;
  const ascii = domainToASCII(trimmed);
  return ascii !== "" && ASCII_DOMAIN.test(ascii) ? ascii : null;
}

/** One mailbox (`Name <a@x.com>` or `a@x.com`) as a lower-cased addr-spec, or null. */
export function normalizeAddress(text: string): string | null {
  const angle = ANGLE_ADDR.exec(text);
  const spec = (angle?.[1] ?? text).trim();
  const at = spec.lastIndexOf("@");
  if (at <= 0 || at === spec.length - 1) return null;
  const local = spec.slice(0, at);
  if (!DOT_ATOM.test(local) && !QUOTED_LOCAL.test(local)) return null;
  const domain = normalizeDomain(spec.slice(at + 1));
  return domain === null ? null : `${local.toLowerCase()}@${domain}`;
}

/**
 * A header-style list (`a@x.com, "Doe, J" <j@y.com>`) as addr-specs. Null
 * when any part doesn't parse or the list is empty: a list heel can't read
 * in full can't be checked in full.
 */
export function parseAddressList(text: string): string[] | null {
  const parts = splitAddressList(text).filter((part) => part.trim() !== "");
  if (parts.length === 0) return null;
  const addresses: string[] = [];
  for (const part of parts) {
    const address = normalizeAddress(part);
    if (address === null) return null;
    addresses.push(address);
  }
  return addresses;
}

/** Splits on commas outside quoted strings and angle brackets. */
function splitAddressList(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angle = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (quoted && ch === "\\") {
      current += ch + text.charAt(i + 1);
      i += 1;
      continue;
    }
    if (ch === '"' && !angle) quoted = !quoted;
    else if (ch === "<" && !quoted) angle = true;
    else if (ch === ">" && !quoted) angle = false;
    else if (ch === "," && !quoted && !angle) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** The domain part of a normalized address. */
export function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1);
}

/**
 * A domain written in a rule: `company.com` matches exactly that domain;
 * `*.company.com` matches its subdomains only.
 */
export interface DomainPattern {
  domain: string;
  subdomains: boolean;
}

export function parseDomainPattern(text: string): DomainPattern | null {
  const subdomains = text.startsWith("*.");
  const domain = normalizeDomain(subdomains ? text.slice(2) : text);
  return domain === null ? null : { domain, subdomains };
}

export function domainMatches(domain: string, pattern: DomainPattern): boolean {
  return pattern.subdomains ? domain.endsWith(`.${pattern.domain}`) : domain === pattern.domain;
}
