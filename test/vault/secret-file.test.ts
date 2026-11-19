import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSecret, SecretFileError } from "../../src/vault/secret-file.ts";
import { tempDir } from "../helpers/store.ts";

/** Secrets named in heel.yaml (an OAuth client's, say) fail with a message, never a stack. */
describe("loadSecret", () => {
  const ENV = "HEEL_TEST_SECRET";

  it("prefers the environment, and drops one trailing newline from the file", () => {
    const file = join(tempDir(), "secret");
    writeFileSync(file, "from-file\n", { mode: 0o600 });
    expect(loadSecret({ [ENV]: "from-env" }, ENV, file).reveal()).toBe("from-env");
    expect(loadSecret({}, ENV, file).reveal()).toBe("from-file");
  });

  it("names the variable and the file when neither is there", () => {
    const file = join(tempDir(), "missing");
    expect(() => loadSecret({}, ENV, file)).toThrow(
      new SecretFileError("missing", `no secret: set ${ENV} or create ${file}`),
    );
  });

  it("says who must own a file heel can't open, instead of throwing EACCES", () => {
    // Root can open any file, so there is nothing to refuse.
    if (process.getuid?.() === 0) return;
    const file = join(tempDir(), "unreadable");
    writeFileSync(file, "test-secret\n", { mode: 0o600 });
    chmodSync(file, 0o000);
    let error: unknown;
    try {
      loadSecret({}, ENV, file);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SecretFileError);
    expect((error as SecretFileError).problem).toBe("insecure_permissions");
    expect((error as Error).message).toContain("can't be read by the user heel runs as");
  });

  it("refuses a file other users can read", () => {
    const file = join(tempDir(), "shared");
    writeFileSync(file, "test-secret\n", { mode: 0o644 });
    chmodSync(file, 0o644);
    expect(() => loadSecret({}, ENV, file)).toThrow("chmod 600 it");
  });
});
