import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM sealing. A sealed value is `format || iv || ciphertext || tag`;
 * the associated data is not stored, so the caller must supply the same
 * context to open it. Binding context (row id, account id, key version) is
 * what stops a ciphertext from being moved to another row.
 */

export const KEY_BYTES = 32;
const FORMAT_V1 = 0x01;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Opening failed: wrong key, wrong context, or tampered bytes. Carries no detail by design. */
export class SealError extends Error {
  constructor() {
    super("sealed value could not be opened");
    this.name = "SealError";
  }
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) throw new RangeError(`expected a ${KEY_BYTES}-byte key`);
}

export function seal(key: Buffer, plaintext: Buffer, context: string): Buffer {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(context, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([FORMAT_V1]), iv, body, cipher.getAuthTag()]);
}

export function open(key: Buffer, sealed: Buffer, context: string): Buffer {
  assertKey(key);
  if (sealed.length < 1 + IV_BYTES + TAG_BYTES || sealed[0] !== FORMAT_V1) throw new SealError();
  const iv = sealed.subarray(1, 1 + IV_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const body = sealed.subarray(1 + IV_BYTES, sealed.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    // GCM reports every failure the same way ("unable to authenticate");
    // a uniform error keeps callers from leaking which part was wrong.
    throw new SealError();
  }
}
