import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { KEY_BYTES, open, SealError, seal } from "../../src/vault/crypto.ts";

const key = randomBytes(KEY_BYTES);
const plaintext = Buffer.from("ya29.sample-access-token", "utf8");

describe("seal and open", () => {
  it("round-trips with the same key and context", () => {
    const sealed = seal(key, plaintext, "ctx-a");
    expect(open(key, sealed, "ctx-a").equals(plaintext)).toBe(true);
  });

  it("never stores the plaintext and uses a fresh IV each time", () => {
    const first = seal(key, plaintext, "ctx-a");
    const second = seal(key, plaintext, "ctx-a");
    expect(first.includes(plaintext)).toBe(false);
    expect(first.equals(second)).toBe(false);
  });

  it("refuses a different context, so ciphertext cannot move between rows", () => {
    const sealed = seal(key, plaintext, "ctx-a");
    expect(() => open(key, sealed, "ctx-b")).toThrow(SealError);
  });

  it("refuses a different key", () => {
    const sealed = seal(key, plaintext, "ctx-a");
    expect(() => open(randomBytes(KEY_BYTES), sealed, "ctx-a")).toThrow(SealError);
  });

  it("refuses tampered bytes anywhere in the envelope", () => {
    const sealed = seal(key, plaintext, "ctx-a");
    for (const index of [0, 5, 20, sealed.length - 1]) {
      const tampered = Buffer.from(sealed);
      tampered[index] = (tampered[index] ?? 0) ^ 0x01;
      expect(() => open(key, tampered, "ctx-a")).toThrow(SealError);
    }
  });

  it("refuses a truncated envelope", () => {
    expect(() => open(key, Buffer.from([0x01, 0x02]), "ctx-a")).toThrow(SealError);
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() => seal(randomBytes(16), plaintext, "ctx-a")).toThrow(RangeError);
  });
});
