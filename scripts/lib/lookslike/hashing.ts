/** Hashing shared by the corpus scripts: content identity and seeded, stable splits. */
import { createHash } from "node:crypto";

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** A stable value in [0, 1) for `key` under `seed`. */
export function unitHash(seed: string, key: string): number {
  return Number.parseInt(sha256(`${seed}\u0000${key}`).slice(0, 12), 16) / 2 ** 48;
}
