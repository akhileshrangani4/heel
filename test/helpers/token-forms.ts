/**
 * The forms a credential could be smuggled out in, for tests that prove it
 * never reached somewhere: raw, base64 at each of the three byte alignments
 * (and their base64url twins), hex, URL-encoded, reversed, and every
 * 8-character piece of it.
 */
export function tokenForms(token: string): string[] {
  const forms = new Set<string>([
    token,
    Buffer.from(token).toString("hex"),
    encodeURIComponent(token),
    [...token].reverse().join(""),
  ]);
  for (let offset = 0; offset < 3; offset++) {
    const encoded = Buffer.from(`${"x".repeat(offset)}${token}`).toString("base64");
    // Characters that mix in the prefix or the padding depend on the neighbours; the middle doesn't.
    const stable = encoded.slice(offset === 0 ? 0 : 4, -4);
    forms.add(stable);
    forms.add(stable.replaceAll("+", "-").replaceAll("/", "_"));
  }
  for (let i = 0; i + 8 <= token.length; i++) forms.add(token.slice(i, i + 8));
  return [...forms];
}

/** The forms of `token` found in `haystack`; empty when it carries none. */
export function leakedForms(haystack: string | Uint8Array, token: string): string[] {
  const text = typeof haystack === "string" ? haystack : Buffer.from(haystack).toString("latin1");
  return tokenForms(token).filter((form) => text.includes(form));
}
