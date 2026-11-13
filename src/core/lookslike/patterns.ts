/**
 * Recall-first patterns for `looks_like` (spec: Hiding, `looks_like` step 1).
 * A hit hides the message, so these lean towards hiding: the cost of a false
 * positive is a hidden ordinary message, the cost of a miss is a leaked
 * account takeover.
 *
 * The keyword sets follow the research survey (MCP research §6): the code
 * keywords of MessAuto (MIT) and the auth words of parse-otp-message, reset
 * and magic-link phrasing, a code token near a keyword, URL heuristics, and
 * WICG origin-bound one-time-code lines. otphelper (AGPL-3.0) informed the
 * idea of excluding currency amounts only; none of its code is used.
 */
import { asciiLower, type PreparedMessage } from "./text.ts";
import type { LooksLikeCategory } from "./types.ts";

export type PatternHits = Partial<Record<LooksLikeCategory, string>>;

interface PatternInput {
  /** Subject and body, original case. */
  text: string;
  /** `text` with A-Z lower-cased; same length, so indices are shared. */
  lower: string;
  urls: readonly string[];
}

interface PatternDef {
  id: string;
  category: LooksLikeCategory;
  test: (input: PatternInput) => boolean;
}

/**
 * The first pattern that hits, per category. Patterns are checked in the
 * order of PATTERNS; the id says which one fired, for audit and metrics. It
 * never carries message content.
 */
export function matchLooksLikePatterns(message: PreparedMessage): PatternHits {
  const text = maskDates(`${message.subject}\n${message.body}`);
  const input: PatternInput = { text, lower: asciiLower(text), urls: message.urls };
  const hits: PatternHits = {};
  for (const pattern of PATTERNS) {
    if (hits[pattern.category] !== undefined) continue;
    if (pattern.test(input)) hits[pattern.category] = pattern.id;
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Phrases

const RESET_PHRASES: readonly RegExp[] = [
  /\breset (?:your |the |a |my )?(?:account )?password\b/,
  /\bpassword[- ]?(?:reset|recovery|change request)\b/,
  /\b(?:forgot|forgotten|lost) (?:your |my |the )?password\b/,
  /\b(?:choose|create|set|pick|enter|set up) (?:up )?a new password\b/,
  /\breset (?:your |the )?(?:credentials|login|account)\b/,
  /\b(?:recover|restore|regain) (?:access to )?(?:your |the )?account\b/,
  /\baccount recovery\b/,
];

/** "a link/button ... change/update password", within one sentence. */
const PASSWORD_LINK_PHRASES: readonly RegExp[] = [
  /\b(?:link|button|url)\b[^.\n]{0,60}\b(?:change|reset|update|recover|choose)\b[^.\n]{0,20}\bpassword\b/,
  /\b(?:change|reset|update|recover|choose)\b[^.\n]{0,20}\bpassword\b[^.\n]{0,60}\b(?:link|button|url|click)\b/,
];

const SIGN_IN_LINK_PHRASES: readonly RegExp[] = [
  /\bmagic[- ]?link\b/,
  /\bone[- ]time (?:link|sign[- ]?in|login)\b/,
  /\bsecure(?:ly)? (?:sign|log)[- ]?in\b/,
  /\b(?:sign|log)[- ]?in\b[^.\n]{0,60}\b(?:link|button|url)\b/,
  /\b(?:link|button|url)\b[^.\n]{0,60}\b(?:sign|log)[- ]?in\b/,
];

const VERIFY_PHRASES: readonly RegExp[] = [
  /\b(?:verify|confirm|activate)\b[^.\n]{0,30}\b(?:e-?mail|email address|account|identity)\b/,
  /\b(?:e-?mail|email address|identity) (?:verification|confirmation)\b/,
];

function anyPhrase(phrases: readonly RegExp[]): (input: PatternInput) => boolean {
  return (input) => phrases.some((re) => re.test(input.lower));
}

// ---------------------------------------------------------------------------
// Dates

const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";
const YEAR = "(?:19|20)\\d{2}";
const DATE_EXPRESSIONS = new RegExp(
  [
    // Nov 13, 2026 · November 13th 2026
    `\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+${YEAR}\\b`,
    // 13 Nov 2026 · 13th November, 2026
    `\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH},?\\s+${YEAR}\\b`,
    // © 2026 · (c) 2019-2026 · Copyright 2026
    `(?:©|\\(c\\)|\\bcopyright)\\s*${YEAR}(?:\\s*[-–]\\s*${YEAR})?\\b`,
    // 2026-11-13
    `\\b${YEAR}-[01]\\d-[0-3]\\d\\b`,
  ].join("|"),
  "gi",
);

/**
 * Blanks out dates, so the year in "on Nov 13, 2026" or "© 2026" is not read
 * as a 4-digit code next to a keyword. Only years inside a date expression
 * are masked: a bare "Your code is 2019" still counts. Same length as the
 * input, so indices into the text and its lower-cased copy stay aligned.
 */
export function maskDates(text: string): string {
  return text.replace(DATE_EXPRESSIONS, (date) => " ".repeat(date.length));
}

// ---------------------------------------------------------------------------
// Codes near keywords

/** Keywords that name a code used to sign in or prove identity. */
const LOGIN_CODE_KEYWORD =
  /\b(?:(?:verification|verify|security|sign[- ]?in|log[- ]?in|login|one[- ]time|single[- ]use|authentication|auth|confirmation|access|activation|registration|2fa|two[- ]factor|two[- ]step|mfa|multi[- ]factor|magic|temporary|otp)\s+(?:pass)?(?:code|pin)s?|one[- ]time\s+pass(?:word|code)|otp|passcode|totp)\b/g;
/** Keywords that name a code used to reset a password or recover an account. */
const RESET_CODE_KEYWORD = /\b(?:password[- ]reset|reset|recovery|password)\s+(?:code|pin)s?\b/g;
/** Bare "code" or "pin": a hit only when the message also has an auth word. */
const WEAK_CODE_KEYWORD = /\b(?:code|pin)\b/g;
/** Auth words (parse-otp-message), minus "account", which ordinary mail uses constantly. */
const AUTH_CONTEXT =
  /\b(?:sign[- ]?in|log[- ]?in|login|verif[a-z]*|authenticat[a-z]*|password|passcode|identity|security|2fa|two[- ](?:factor|step)|otp|one[- ]time)\b/;

const WINDOW_AFTER = 100;
const WINDOW_BEFORE = 50;

function codeNearKeyword(keyword: RegExp, needsContext: boolean): (input: PatternInput) => boolean {
  return (input) => {
    if (needsContext && !AUTH_CONTEXT.test(input.lower)) return false;
    for (const m of input.lower.matchAll(keyword)) {
      const start = m.index;
      const end = start + m[0].length;
      if (hasCodeToken(input.text.slice(end, end + WINDOW_AFTER))) return true;
      if (hasCodeToken(input.text.slice(Math.max(0, start - WINDOW_BEFORE), start))) return true;
    }
    return false;
  };
}

const EDGE_OPEN = /^["'([*:#<]+/;
const EDGE_CLOSE = /[)"'\]*:.,;!?>]+$/;

/**
 * Whether a span holds something shaped like a one-time code. Tokens are
 * split on whitespace and trimmed of quotes and brackets; currency ($12.50)
 * and decimals keep their symbols and so never look like codes.
 */
export function hasCodeToken(span: string): boolean {
  const tokens = span
    .split(/\s+/)
    .map((t) => t.replace(EDGE_OPEN, "").replace(EDGE_CLOSE, ""))
    .filter((t) => t.length > 0);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    if (isCodeToken(token)) return true;
    // "123 456": two digit groups written with a space.
    const next = tokens[i + 1];
    if (next !== undefined && /^\d{3,4}$/.test(token) && /^\d{3,4}$/.test(next)) return true;
  }
  return false;
}

/** MessAuto's shape (4-8 characters, letters or digits, at least one digit), widened. */
export function isCodeToken(token: string): boolean {
  if (/^\d{4,10}$/.test(token)) return true;
  // Digit groups: 123-456, 12-34-56.
  if (/^\d{2,5}(?:-\d{2,5}){1,3}$/.test(token)) {
    const digits = token.replace(/-/g, "").length;
    return digits >= 4 && digits <= 12;
  }
  // Mixed letters and digits: A1B2C3, x7k2p9.
  if (/^[A-Za-z0-9]{4,12}$/.test(token) && /\d/.test(token) && /[A-Za-z]/.test(token)) return true;
  // Upper-case letter codes, alone or grouped: QWERTZ, ABCD-EFGH, X7K-29P.
  if (/^[A-Z]{6,10}$/.test(token)) return true;
  return /^[A-Z0-9]{3,5}(?:-[A-Z0-9]{3,5}){1,3}$/.test(token) && /[A-Z]/.test(token);
}

// ---------------------------------------------------------------------------
// URLs

const URL_RESET = /(?:reset|passw(?:or)?d|recover|forgot)/;
const URL_MAGIC = /(?:magic|otp|one-?time|onetime)/;
const URL_AUTH = /(?:verif|confirm|activat|sign-?in|log-?in|login|auth|callback|session|token)/;
const TOKEN_PARAMS = new Set([
  "token",
  "code",
  "key",
  "secret",
  "otp",
  "ticket",
  "nonce",
  "hash",
  "t",
  "k",
]);

interface ParsedUrl {
  /** Lower-cased path and query, without scheme and host. */
  pathAndQuery: string;
  /**
   * Lower-cased path, fragment and query values, without parameter names: a
   * `?token=` name says nothing about what the link is for.
   */
  pathAndValues: string;
  /** Path segments and query values, original case, for the token-like test. */
  parts: string[];
  params: string[];
  /** An unsubscribe or mail-preferences link: never a credential. */
  optOut: boolean;
}

const OPT_OUT = /(?:unsubscribe|opt-?out|email-?preferences|manage-?preferences|list-?manage)/;

function parseUrl(raw: string): ParsedUrl | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Not a URL after all: no URL heuristic applies. Text patterns still run.
    return undefined;
  }
  const parts = url.pathname.split("/").filter((p) => p.length > 0);
  const params: string[] = [];
  const values: string[] = [];
  for (const [name, value] of url.searchParams) {
    params.push(name.toLowerCase());
    parts.push(value);
    values.push(value);
  }
  // SPA routes carry the path and token in the fragment: /#/auth/confirm-password-reset/<token>.
  if (url.hash.length > 1) parts.push(...url.hash.slice(1).split(/[/?&=]/));
  return {
    pathAndQuery: `${url.pathname}${url.search}${url.hash}`.toLowerCase(),
    pathAndValues: [url.pathname, url.hash, ...values].join(" ").toLowerCase(),
    parts,
    params,
    optOut: OPT_OUT.test(url.pathname.toLowerCase()),
  };
}

/** Long and mixed, like a signed token or random id: not a word or a slug. */
export function isTokenLike(part: string): boolean {
  return (
    part.length >= 16 &&
    /\d/.test(part) &&
    /[A-Za-z]/.test(part) &&
    !/^[a-z]+(?:-[a-z]+)+$/.test(part)
  );
}

function urlTest(
  pick: (url: ParsedUrl, input: PatternInput) => boolean,
): (input: PatternInput) => boolean {
  return (input) =>
    input.urls.some((raw) => {
      const url = parseUrl(raw);
      return url !== undefined && !url.optOut && pick(url, input);
    });
}

const urlReset = urlTest((url) => URL_RESET.test(url.pathAndQuery));
const urlMagic = urlTest((url) => URL_MAGIC.test(url.pathAndQuery));
/** A sign-in or verify path is common; one carrying a token is a credential. */
const urlAuthWithToken = urlTest(
  (url) => URL_AUTH.test(url.pathAndValues) && url.parts.some(isTokenLike),
);
/**
 * `?token=` alone is every unsubscribe and tracking link, so a token
 * parameter counts only next to auth wording.
 */
const urlTokenParamWithContext = urlTest(
  (url, input) =>
    url.params.some((p) => TOKEN_PARAMS.has(p)) &&
    url.parts.some(isTokenLike) &&
    AUTH_CONTEXT.test(input.lower),
);

// ---------------------------------------------------------------------------
// WICG origin-bound one-time codes: a line "@example.com #123456".

const WICG_LINE = /(?:^|\n)[ \t]*@(?:[a-z0-9-]+\.)+[a-z]{2,}[ \t]+#[a-z0-9-]{4,}/;

// ---------------------------------------------------------------------------

/** Order matters only for which id is reported; any hit hides. */
export const PATTERNS: readonly PatternDef[] = [
  { id: "reset_phrase", category: "password_reset", test: anyPhrase(RESET_PHRASES) },
  {
    id: "reset_code",
    category: "password_reset",
    test: codeNearKeyword(RESET_CODE_KEYWORD, false),
  },
  {
    id: "password_link_phrase",
    category: "password_reset",
    test: anyPhrase(PASSWORD_LINK_PHRASES),
  },
  { id: "reset_url", category: "password_reset", test: urlReset },
  { id: "wicg_otc", category: "login_code", test: (input) => WICG_LINE.test(input.lower) },
  { id: "login_code", category: "login_code", test: codeNearKeyword(LOGIN_CODE_KEYWORD, false) },
  {
    id: "code_with_auth_context",
    category: "login_code",
    test: codeNearKeyword(WEAK_CODE_KEYWORD, true),
  },
  {
    id: "sign_in_link_phrase",
    category: "login_code",
    test: (input) => input.urls.length > 0 && anyPhrase(SIGN_IN_LINK_PHRASES)(input),
  },
  {
    id: "verify_phrase",
    category: "login_code",
    test: (input) =>
      (input.urls.length > 0 || hasCodeToken(input.text)) && anyPhrase(VERIFY_PHRASES)(input),
  },
  { id: "magic_url", category: "login_code", test: urlMagic },
  { id: "auth_url_with_token", category: "login_code", test: urlAuthWithToken },
  { id: "token_param_with_auth_context", category: "login_code", test: urlTokenParamWithContext },
];
