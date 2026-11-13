/**
 * Features for the `looks_like` linear classifier (spec: Hiding, `looks_like`
 * step 2): hashed word and character n-grams over the subject, the sender's
 * local part, the body prefix and the body's URLs.
 *
 * Tokens whose exact value means nothing (a code, a number, a long token) are
 * reduced to their shape, so the model learns "a six-digit number near
 * 'code'" rather than particular digits.
 */
import { isCodeToken, isTokenLike } from "./patterns.ts";
import type { PreparedMessage } from "./text.ts";

/** Bump on any change to extraction or hashing: weights from another version are refused. */
export const FEATURE_VERSION = 1;

// Caps bound the work per message whatever the input (spec: 200 ms budget).
const MAX_WORDS_PER_FIELD = 600;
const MAX_URLS = 16;
const CHAR_GRAM = 4;

const WORD = /[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu;

/** A feature vector after hashing: parallel bucket indices and signed values. */
export interface HashedFeatures {
  indices: Uint32Array;
  values: Float32Array;
}

/** The token as a feature: lower-cased words, shapes for codes, numbers and tokens. */
export function tokenShape(token: string): string {
  if (isTokenLike(token)) return "<tok>";
  if (/^\d+$/.test(token)) return `<d${Math.min(token.length, 12)}>`;
  if (/\d/.test(token)) return isCodeToken(token) ? "<code>" : "<mixed>";
  return token.toLowerCase();
}

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(WORD)) {
    tokens.push(tokenShape(match[0]));
    if (tokens.length >= MAX_WORDS_PER_FIELD) break;
  }
  return tokens;
}

function addWordGrams(into: Set<string>, tokens: readonly string[]): void {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    into.add(`w:${token}`);
    const next = tokens[i + 1];
    if (next !== undefined) into.add(`w:${token} ${next}`);
  }
}

function addCharGrams(into: Set<string>, token: string): void {
  // Shapes are already abstract; n-grams of "<d6>" would add nothing.
  if (token.startsWith("<") || token.length < 3) return;
  const padded = `^${token}$`;
  for (let i = 0; i + CHAR_GRAM <= padded.length; i += 1) {
    into.add(`c:${padded.slice(i, i + CHAR_GRAM)}`);
  }
}

/** The local part of the From address: `no-reply` in `Acme <no-reply@acme.io>`. */
export function senderLocalPart(from: string): string {
  const angle = /<([^<>]*)>/.exec(from);
  const address = (angle?.[1] ?? from).trim();
  const at = address.lastIndexOf("@");
  return at > 0 ? address.slice(0, at) : "";
}

function addUrlFeatures(into: Set<string>, raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // prepareMessage only collects http(s) URLs, but a malformed one adds no features.
    return;
  }
  // The host is left out on purpose: it names the sender's brand, not what the link does.
  const segments = [...url.pathname.split("/"), ...url.hash.slice(1).split(/[/?&=]/)];
  for (const segment of segments) {
    if (segment.length === 0) continue;
    if (isTokenLike(segment)) {
      into.add("u:<tok>");
      continue;
    }
    for (const token of tokenize(segment)) into.add(`u:${token}`);
  }
  for (const [name, value] of url.searchParams) {
    into.add(`q:${name.toLowerCase()}`);
    if (value.length > 0) into.add(`q:${name.toLowerCase()}=${tokenShape(value)}`);
  }
}

/** Every feature of a message, each once, in a deterministic order. */
export function extractFeatures(message: PreparedMessage): string[] {
  const features = new Set<string>();
  const subject = tokenize(message.subject);
  const body = tokenize(message.body);
  for (const token of subject) features.add(`s:${token}`);
  addWordGrams(features, subject);
  addWordGrams(features, body);
  for (const token of subject) addCharGrams(features, token);
  for (const token of body) addCharGrams(features, token);
  for (const token of tokenize(senderLocalPart(message.from))) features.add(`f:${token}`);
  const urls = message.urls.slice(0, MAX_URLS);
  features.add(`x:urls=${Math.min(urls.length, 4)}`);
  for (const url of urls) addUrlFeatures(features, url);
  return [...features];
}

/** FNV-1a over UTF-16 code units, then the murmur3 finalizer to spread the bits. */
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Signed feature hashing into `dims` buckets (a power of two). The top hash
 * bit picks the sign so colliding features tend to cancel rather than pile
 * up. Values are divided by the square root of the feature count so long
 * messages don't score higher just for being long.
 */
export function hashFeatures(features: readonly string[], dims: number): HashedFeatures {
  const buckets = new Map<number, number>();
  for (const feature of features) {
    const h = hash32(feature);
    const index = h & (dims - 1);
    const sign = h & 0x80000000 ? -1 : 1;
    buckets.set(index, (buckets.get(index) ?? 0) + sign);
  }
  const norm = features.length > 0 ? 1 / Math.sqrt(features.length) : 0;
  const indices = new Uint32Array(buckets.size);
  const values = new Float32Array(buckets.size);
  let i = 0;
  for (const [index, value] of buckets) {
    indices[i] = index;
    values[i] = value * norm;
    i += 1;
  }
  return { indices, values };
}
