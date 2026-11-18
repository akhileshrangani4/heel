import { createHash, timingSafeEqual } from "node:crypto";
import { isLoopbackUrl } from "../config/schema.ts";

/**
 * The checks an OAuth exchange has to pass (A2: MCP authorization for cloud
 * connectors). Pure. heel is the authorization server for its own agent
 * plane, and every client is public, so PKCE with S256 is required on every
 * code (OAuth 2.1).
 */

/** How long each credential lasts. */
export const CODE_TTL_MS = 60_000;
export const ACCESS_TOKEN_TTL_MS = 60 * 60_000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;

/** RFC 7636: 43 to 128 unreserved characters. */
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
/** A base64url SHA-256: 43 characters, no padding. */
const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

export function isCodeChallenge(value: string): boolean {
  return S256_CHALLENGE.test(value);
}

/** Whether `verifier` is the one `challenge` was made from (S256), compared in constant time. */
export function verifierMatches(verifier: string, challenge: string): boolean {
  if (!VERIFIER.test(verifier) || !isCodeChallenge(challenge)) return false;
  const computed = Buffer.from(createHash("sha256").update(verifier, "ascii").digest("base64url"));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

/**
 * Why a redirect URI can't be registered, or null. https only, or http on
 * loopback for desktop clients; no fragments, since the code goes in the
 * query.
 */
export function redirectUriProblem(text: string): string | null {
  if (!URL.canParse(text)) return "not a URL";
  const url = new URL(text);
  if (url.hash !== "") return "has a fragment";
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && isLoopbackUrl(url)) return null;
  return "must be https (http only on localhost)";
}

/** An agent name for a client, from the name it gives itself: "Claude" → "claude". */
export function agentNameFor(clientName: string): string {
  const base = clientName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .slice(0, 48);
  return base === "" ? "connector" : base;
}

/** `redirect_uri?code=…&state=…`, or the error form when the person declined. */
export function redirectWith(redirectUri: string, params: Record<string, string>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}
