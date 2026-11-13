import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/log.ts";
import { KEY_BYTES } from "../../src/vault/crypto.ts";
import { Secret } from "../../src/vault/secret.ts";
import { Vault, VaultError } from "../../src/vault/vault.ts";
import { addAccount, testStore } from "../helpers/store.ts";

const ACCESS = "ya29.a0-never-log-me-access";
const REFRESH = "1//0g-never-log-me-refresh";

function captureLogger() {
  let output = "";
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      output += chunk.toString("utf8");
      done();
    },
  });
  return { logger: createLogger("trace", sink), output: () => output };
}

describe("credentials are never logged", () => {
  it("I-02: a Secret prints as a placeholder everywhere", () => {
    const secret = new Secret(ACCESS);
    expect(String(secret)).not.toContain(ACCESS);
    expect(`${secret}`).not.toContain(ACCESS);
    expect(JSON.stringify({ secret })).not.toContain(ACCESS);
    expect(inspect({ nested: { secret } }, { depth: 10 })).not.toContain(ACCESS);
    expect(secret.reveal()).toBe(ACCESS);
  });

  it("I-02: logging a decrypted credential writes no credential value", () => {
    const t = testStore();
    const vault = Vault.open(t.db, { bytes: randomBytes(KEY_BYTES), source: "test" });
    const accountId = addAccount(t, "gmail-work", "gmail");
    vault.put(accountId, { type: "oauth", accessToken: ACCESS, refreshToken: REFRESH });

    const { logger, output } = captureLogger();
    const credential = vault.get(accountId);
    logger.info({ credential }, "loaded credential");
    logger.debug({ account: { credential } }, "nested");
    logger.trace(credential, "as merge object");

    expect(output()).toContain("loaded credential");
    expect(output()).not.toContain(ACCESS);
    expect(output()).not.toContain(REFRESH);
  });

  it("I-02: raw secret-named fields are redacted by the logger", () => {
    const { logger, output } = captureLogger();
    logger.info(
      {
        headers: { authorization: `Bearer ${ACCESS}`, cookie: `sid=${ACCESS}` },
        oauth: { access_token: ACCESS, refresh_token: REFRESH },
        token: ACCESS,
      },
      "upstream request",
    );
    expect(output()).toContain("upstream request");
    expect(output()).not.toContain(ACCESS);
    expect(output()).not.toContain(REFRESH);
  });

  it("I-02: vault errors name the account, never the value", () => {
    const t = testStore();
    const key = { bytes: randomBytes(KEY_BYTES), source: "test" };
    const vault = Vault.open(t.db, key);
    const accountId = addAccount(t, "gmail-work", "gmail");
    vault.put(accountId, { type: "static", value: ACCESS });

    const { logger, output } = captureLogger();
    try {
      Vault.open(t.db, { bytes: randomBytes(KEY_BYTES), source: "test" });
    } catch (error) {
      expect(error).toBeInstanceOf(VaultError);
      logger.error({ err: error }, "vault open failed");
    }
    expect(output()).toContain("key_mismatch");
    expect(output()).not.toContain(ACCESS);
    expect(output()).not.toContain(key.bytes.toString("base64"));
  });
});
