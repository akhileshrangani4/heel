import { randomBytes } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, writeSync } from "node:fs";
import { hasErrnoCode } from "../util/errno.ts";
import { KEY_BYTES } from "./crypto.ts";

/** Environment variable that carries the base64 master key; it beats the key file. */
export const MASTER_KEY_ENV = "HEEL_MASTER_KEY";

export type MasterKeyProblem = "missing" | "malformed" | "insecure_permissions";

/**
 * The master key could not be loaded. heel then keeps the agent plane down
 * (spec: Fail-closed behavior). The message names the source, never the key.
 */
export class MasterKeyError extends Error {
  readonly problem: MasterKeyProblem;

  constructor(problem: MasterKeyProblem, message: string) {
    super(message);
    this.name = "MasterKeyError";
    this.problem = problem;
  }
}

export interface MasterKey {
  /** 32 bytes for AES-256. */
  bytes: Buffer;
  /** Where it came from, for logs: "env" or the file path. */
  source: string;
}

/** Pure: decodes a base64 or base64url key; null unless it is exactly 32 bytes. */
export function decodeMasterKey(text: string): Buffer | null {
  const trimmed = text.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) return null;
  const bytes = Buffer.from(trimmed, "base64");
  return bytes.length === KEY_BYTES ? bytes : null;
}

export function encodeMasterKey(bytes: Buffer): string {
  return bytes.toString("base64");
}

/**
 * Loads the master key from `HEEL_MASTER_KEY`, else from `keyFile`. The file
 * must belong to the user heel runs as and be unreadable by anyone else.
 */
export function loadMasterKey(
  env: Readonly<Record<string, string | undefined>>,
  keyFile: string,
): MasterKey {
  const fromEnv = env[MASTER_KEY_ENV];
  if (fromEnv !== undefined && fromEnv !== "") {
    const bytes = decodeMasterKey(fromEnv);
    if (!bytes) {
      throw new MasterKeyError(
        "malformed",
        `${MASTER_KEY_ENV} must be ${KEY_BYTES} bytes, base64-encoded`,
      );
    }
    return { bytes, source: "env" };
  }

  let fd: number;
  try {
    fd = openSync(keyFile, "r");
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      throw new MasterKeyError(
        "missing",
        `no master key: set ${MASTER_KEY_ENV} or create ${keyFile} with \`heel vault init\``,
      );
    }
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new MasterKeyError("insecure_permissions", `${keyFile} is not a regular file`);
    }
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) {
      throw new MasterKeyError(
        "insecure_permissions",
        `${keyFile} must be owned by the user heel runs as (uid ${uid})`,
      );
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new MasterKeyError(
        "insecure_permissions",
        `${keyFile} is readable by other users; chmod 600 it`,
      );
    }
    const bytes = decodeMasterKey(readFileSync(fd, "utf8"));
    if (!bytes) {
      throw new MasterKeyError(
        "malformed",
        `${keyFile} must hold a ${KEY_BYTES}-byte key, base64-encoded`,
      );
    }
    return { bytes, source: keyFile };
  } finally {
    closeSync(fd);
  }
}

/**
 * Creates a new random key file, mode 0600. Refuses to overwrite: replacing
 * the key would make every stored credential undecryptable.
 */
export function createMasterKeyFile(keyFile: string): void {
  const fd = openSync(keyFile, "wx", 0o600);
  try {
    writeSync(fd, `${encodeMasterKey(randomBytes(KEY_BYTES))}\n`);
  } finally {
    closeSync(fd);
  }
}
