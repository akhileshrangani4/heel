/**
 * Replaces every occurrence of a credential value in a byte stream with
 * `[redacted by heel]` (spec: CLI runner, "Output scrub"). Output arrives in
 * chunks, and a credential can straddle two of them, so the scrubber holds
 * back the last `longest - 1` bytes until it knows no secret starts there.
 */
export const REDACTED = Buffer.from("[redacted by heel]", "utf8");

export interface Scrubber {
  /** Scrubbed bytes that are safe to release now. */
  push(chunk: Uint8Array): Buffer;
  /** Everything still held back; call once, at end of stream. */
  end(): Buffer;
}

export function createScrubber(secrets: readonly string[]): Scrubber {
  const needles = [...new Set(secrets)]
    .filter((secret) => secret !== "")
    .map((secret) => Buffer.from(secret, "utf8"))
    // Longest first, so a secret that contains another is replaced whole.
    .sort((a, b) => b.length - a.length);
  const holdBack = Math.max(0, ...needles.map((needle) => needle.length - 1));
  let pending = Buffer.alloc(0);

  return {
    push(chunk) {
      const data = Buffer.concat([pending, chunk]);
      const { out, rest } = replaceAll(data, needles);
      // `rest` holds no whole secret, but its tail may be the start of one.
      const safe = Math.max(0, rest.length - holdBack);
      pending = Buffer.from(rest.subarray(safe));
      out.push(rest.subarray(0, safe));
      return Buffer.concat(out);
    },
    end() {
      const tail = pending;
      pending = Buffer.alloc(0);
      return tail;
    },
  };
}

/** Scrubs a complete value in one go. */
export function scrubAll(data: Uint8Array, secrets: readonly string[]): Buffer {
  const scrubber = createScrubber(secrets);
  return Buffer.concat([scrubber.push(data), scrubber.end()]);
}

/** Replaced pieces in `out`, plus the unreplaced remainder after the last match. */
function replaceAll(data: Buffer, needles: readonly Buffer[]): { out: Buffer[]; rest: Buffer } {
  const out: Buffer[] = [];
  let from = 0;
  for (;;) {
    let at = -1;
    let length = 0;
    for (const needle of needles) {
      const index = data.indexOf(needle, from);
      // Earliest match wins; at the same offset the longer one (seen first) is kept.
      if (index !== -1 && (at === -1 || index < at)) {
        at = index;
        length = needle.length;
      }
    }
    if (at === -1) return { out, rest: data.subarray(from) };
    out.push(data.subarray(from, at), REDACTED);
    from = at + length;
  }
}
