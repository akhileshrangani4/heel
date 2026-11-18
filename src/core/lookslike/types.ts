/**
 * Types for the `looks_like` detector (spec: Hiding, `looks_like`). D10a ships
 * the detector on its own; D10b evaluates it inside `hide` entries.
 *
 * Categories are named for what the message lets its reader do:
 * - `password_reset`: reset a password or recover an account, by link or by code.
 * - `login_code`: sign in or prove identity once: one-time and 2FA codes,
 *   magic sign-in links, and email-verification codes or links.
 */
export const LOOKS_LIKE_CATEGORIES = ["password_reset", "login_code"] as const;
export type LooksLikeCategory = (typeof LOOKS_LIKE_CATEGORIES)[number];

/**
 * `match` and `uncertain` both mean "hide" to a caller; `no_match` is the only
 * verdict that lets a message through. `uncertain` is kept distinct so the hide
 * path can count fail-closed outcomes (spec: Fail-closed, I-44).
 */
export type LooksLikeVerdict = "match" | "no_match" | "uncertain";

/** Why a message body could not be read. Any of these hides the message. */
export type Unreadable = "encrypted" | "image_only" | "unparseable";

/** One email as the hide path sees it, before any content leaves heel. */
export interface LooksLikeMessage {
  subject: string;
  /** The From header as received: `Name <addr>` or a bare address. */
  from: string;
  /** The body heel extracted: the text/plain part, or the text/html part when there is none. */
  body: string;
  bodyFormat: "text" | "html";
  /**
   * Set by the caller when MIME parsing found no readable body: S/MIME or PGP
   * MIME, or a part that would not decode. The detector itself also flags
   * inline PGP and image-only HTML.
   */
  unreadable?: Unreadable;
}

export type LooksLikeReason =
  | { kind: "pattern"; pattern: string }
  | { kind: "classifier"; score: number }
  | { kind: "unreadable"; detail: Unreadable }
  | { kind: "model_unavailable" }
  | { kind: "timeout"; elapsedMs: number }
  | { kind: "error"; error: string };

export interface LooksLikeCategoryResult {
  verdict: LooksLikeVerdict;
  reason: LooksLikeReason;
}

export interface LooksLikeResult {
  /**
   * The verdict across the requested categories: `match` if any category
   * matched, else `uncertain` if any was uncertain, else `no_match`.
   */
  verdict: LooksLikeVerdict;
  /** One entry per requested category. */
  categories: Partial<Record<LooksLikeCategory, LooksLikeCategoryResult>>;
}

/** Combines per-category verdicts: any match wins, then any uncertainty. */
export function combineVerdicts(verdicts: readonly LooksLikeVerdict[]): LooksLikeVerdict {
  if (verdicts.includes("match")) return "match";
  if (verdicts.includes("uncertain")) return "uncertain";
  // An empty request hides nothing: there was no category to look for.
  return "no_match";
}
