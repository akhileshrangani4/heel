import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KEY_BYTES } from "../../src/vault/crypto.ts";
import {
  createMasterKeyFile,
  decodeMasterKey,
  encodeMasterKey,
  loadMasterKey,
  MASTER_KEY_ENV,
  MasterKeyError,
} from "../../src/vault/key.ts";
import { tempDir } from "../helpers/store.ts";

function problemOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof MasterKeyError) return error.problem;
    throw error;
  }
  throw new Error("expected a MasterKeyError");
}

describe("decodeMasterKey", () => {
  it("accepts 32 bytes in base64 or base64url, ignoring surrounding whitespace", () => {
    const bytes = randomBytes(KEY_BYTES);
    expect(decodeMasterKey(` ${bytes.toString("base64")}\n`)?.equals(bytes)).toBe(true);
    expect(decodeMasterKey(bytes.toString("base64url"))?.equals(bytes)).toBe(true);
  });

  it("rejects other lengths and non-base64 text", () => {
    expect(decodeMasterKey(randomBytes(16).toString("base64"))).toBeNull();
    expect(decodeMasterKey("not a key!")).toBeNull();
    expect(decodeMasterKey("")).toBeNull();
  });
});

describe("loadMasterKey", () => {
  it("prefers HEEL_MASTER_KEY over the key file", () => {
    const bytes = randomBytes(KEY_BYTES);
    const key = loadMasterKey({ [MASTER_KEY_ENV]: encodeMasterKey(bytes) }, "/nonexistent");
    expect(key.source).toBe("env");
    expect(key.bytes.equals(bytes)).toBe(true);
  });

  it("reports a malformed env key without echoing it", () => {
    const bad = "c2VjcmV0LWJ1dC10b28tc2hvcnQ=";
    try {
      loadMasterKey({ [MASTER_KEY_ENV]: bad }, "/nonexistent");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MasterKeyError);
      expect((error as MasterKeyError).problem).toBe("malformed");
      expect(String(error)).not.toContain(bad);
    }
  });

  it("reports a missing key when neither env nor file exists", () => {
    const dir = tempDir();
    expect(problemOf(() => loadMasterKey({}, join(dir, "master.key")))).toBe("missing");
  });

  it("loads a 0600 key file owned by the current user", () => {
    const file = join(tempDir(), "master.key");
    createMasterKeyFile(file);
    const key = loadMasterKey({}, file);
    expect(key.source).toBe(file);
    expect(key.bytes.length).toBe(KEY_BYTES);
  });

  it("refuses a key file other users can read", () => {
    const file = join(tempDir(), "master.key");
    createMasterKeyFile(file);
    chmodSync(file, 0o640);
    expect(problemOf(() => loadMasterKey({}, file))).toBe("insecure_permissions");
  });

  it("refuses a key file that does not hold a 32-byte key", () => {
    const file = join(tempDir(), "master.key");
    writeFileSync(file, "too short\n", { mode: 0o600 });
    expect(problemOf(() => loadMasterKey({}, file))).toBe("malformed");
  });

  it("refuses a key path that is a directory", () => {
    expect(problemOf(() => loadMasterKey({}, tempDir()))).toBe("insecure_permissions");
  });
});

describe("createMasterKeyFile", () => {
  it("writes mode 0600 and never overwrites an existing key", () => {
    const file = join(tempDir(), "master.key");
    createMasterKeyFile(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const before = readFileSync(file, "utf8");
    expect(() => createMasterKeyFile(file)).toThrow(/EEXIST/);
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});
