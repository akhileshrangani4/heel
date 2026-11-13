import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createScrubber, REDACTED, scrubAll } from "../../src/runner/scrub.ts";

const TOKEN = "ghp_scrubTestCredential0123456789";

function scrubChunks(chunks: readonly string[], secrets: readonly string[]): string {
  const scrubber = createScrubber(secrets);
  const out = chunks.map((chunk) => scrubber.push(Buffer.from(chunk, "utf8")));
  out.push(scrubber.end());
  return Buffer.concat(out).toString("utf8");
}

/** Splits `text` at the given cut points (taken modulo its length). */
function split(text: string, cuts: readonly number[]): string[] {
  const points = [...new Set(cuts.map((cut) => cut % (text.length + 1)))].sort((a, b) => a - b);
  const pieces: string[] = [];
  let from = 0;
  for (const point of points) {
    pieces.push(text.slice(from, point));
    from = point;
  }
  pieces.push(text.slice(from));
  return pieces;
}

describe("scrubAll", () => {
  it("replaces every occurrence of a credential", () => {
    expect(scrubAll(Buffer.from(`a ${TOKEN} b ${TOKEN}`), [TOKEN]).toString()).toBe(
      `a ${REDACTED} b ${REDACTED}`,
    );
  });

  it("replaces a secret that contains another one whole", () => {
    expect(scrubAll(Buffer.from("key=abcdef"), ["abc", "abcdef"]).toString()).toBe(
      `key=${REDACTED}`,
    );
  });

  it("ignores empty secrets and passes output through when there are none", () => {
    expect(scrubAll(Buffer.from("plain output"), [""]).toString()).toBe("plain output");
    expect(scrubAll(Buffer.from("plain output"), []).toString()).toBe("plain output");
  });
});

describe("createScrubber", () => {
  it("catches a credential split across chunks", () => {
    expect(scrubChunks([`token: ${TOKEN.slice(0, 10)}`, TOKEN.slice(10), "\n"], [TOKEN])).toBe(
      `token: ${REDACTED}\n`,
    );
  });

  it("releases output that can't start a credential straight away", () => {
    const scrubber = createScrubber([TOKEN]);
    const released = scrubber.push(Buffer.from(`${"x".repeat(100)}`));
    expect(released.length).toBe(100 - (TOKEN.length - 1));
    expect(Buffer.concat([released, scrubber.end()]).toString()).toBe("x".repeat(100));
  });

  it("I-34: however output is chunked, no credential gets through and nothing else changes", () => {
    const secrets = [TOKEN, "kube-secret-value"];
    const text = fc.oneof(
      fc.string({ maxLength: 20 }),
      fc.constantFrom(...secrets),
      fc.constantFrom(TOKEN.slice(0, 12), TOKEN.slice(5)),
    );
    fc.assert(
      fc.property(
        fc.array(text, { maxLength: 12 }),
        fc.array(fc.nat(), { maxLength: 10 }),
        (parts, cuts) => {
          const output = parts.join("");
          const scrubbed = scrubChunks(split(output, cuts), secrets);
          expect(scrubbed).toBe(scrubAll(Buffer.from(output), secrets).toString());
          for (const secret of secrets) expect(scrubbed).not.toContain(secret);
        },
      ),
    );
  });
});
