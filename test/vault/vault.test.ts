import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { accounts, credentials, vaultKeys } from "../../src/store/schema.ts";
import { KEY_BYTES } from "../../src/vault/crypto.ts";
import type { MasterKey } from "../../src/vault/key.ts";
import type { OAuthRefresher, OAuthTokens } from "../../src/vault/refresh.ts";
import { Vault, VaultError, type VaultErrorCode } from "../../src/vault/vault.ts";
import { addAccount, reopen, testStore } from "../helpers/store.ts";

function masterKey(): MasterKey {
  return { bytes: randomBytes(KEY_BYTES), source: "test" };
}

async function codeOf(run: () => unknown): Promise<VaultErrorCode> {
  try {
    await run();
  } catch (error) {
    if (error instanceof VaultError) return error.code;
    throw error;
  }
  throw new Error("expected a VaultError");
}

/** Every byte SQLite may have written: the main file plus its WAL. */
function databaseBytes(path: string): Buffer {
  const parts = [readFileSync(path)];
  if (existsSync(`${path}-wal`)) parts.push(readFileSync(`${path}-wal`));
  return Buffer.concat(parts);
}

const ACCESS = "ya29.a0-plaintext-access-token-7f3c";
const REFRESH = "1//0g-plaintext-refresh-token-91ab";

describe("Vault storage", () => {
  it("I-02: credentials are encrypted at rest", () => {
    const t = testStore();
    const key = masterKey();
    const vault = Vault.open(t.db, key);
    const accountId = addAccount(t, "gmail-work", "gmail");
    vault.put(accountId, { type: "oauth", accessToken: ACCESS, refreshToken: REFRESH });

    const row = t.db.select().from(credentials).where(eq(credentials.accountId, accountId)).get();
    expect(row).toBeDefined();
    expect(row?.ciphertext.includes(Buffer.from(ACCESS))).toBe(false);

    const bytes = databaseBytes(t.path);
    expect(bytes.includes(Buffer.from(ACCESS))).toBe(false);
    expect(bytes.includes(Buffer.from(REFRESH))).toBe(false);
    expect(bytes.includes(key.bytes)).toBe(false);

    const credential = vault.get(accountId);
    expect(credential.type).toBe("oauth");
    if (credential.type !== "oauth") return;
    expect(credential.accessToken.reveal()).toBe(ACCESS);
    expect(credential.refreshToken?.reveal()).toBe(REFRESH);
  });

  it("stores static credentials and replaces them in place", () => {
    const t = testStore();
    const vault = Vault.open(t.db, masterKey());
    const accountId = addAccount(t, "linear", "linear");
    vault.put(accountId, { type: "static", value: "lin_api_one" });
    vault.put(accountId, { type: "static", value: "lin_api_two" });
    const credential = vault.get(accountId);
    expect(credential.type === "static" && credential.value.reveal()).toBe("lin_api_two");
    expect(t.db.select().from(credentials).all()).toHaveLength(1);
  });

  it("survives a restart with the same key", () => {
    const t = testStore();
    const key = masterKey();
    const accountId = addAccount(t, "github", "github");
    Vault.open(t.db, key).put(accountId, { type: "static", value: "ghp_example" });

    const after = reopen(t);
    const credential = Vault.open(after.db, key).get(accountId);
    expect(credential.type === "static" && credential.value.reveal()).toBe("ghp_example");
  });

  it("refuses a different master key at open", async () => {
    const t = testStore();
    const accountId = addAccount(t, "github", "github");
    Vault.open(t.db, masterKey()).put(accountId, { type: "static", value: "ghp_example" });
    expect(await codeOf(() => Vault.open(t.db, masterKey()))).toBe("key_mismatch");
  });

  it("refuses to trust a key when credentials exist but the key check is gone", async () => {
    const t = testStore();
    const key = masterKey();
    const accountId = addAccount(t, "github", "github");
    Vault.open(t.db, key).put(accountId, { type: "static", value: "ghp_example" });
    t.db.delete(vaultKeys).run();
    expect(await codeOf(() => Vault.open(t.db, key))).toBe("key_mismatch");
  });

  it("refuses a ciphertext moved onto another account", async () => {
    const t = testStore();
    const vault = Vault.open(t.db, masterKey());
    const victim = addAccount(t, "gmail-work", "gmail");
    const other = addAccount(t, "gmail-personal", "gmail");
    vault.put(victim, { type: "static", value: "victim-secret" });
    vault.put(other, { type: "static", value: "other-secret" });

    const stolen = t.db.select().from(credentials).where(eq(credentials.accountId, victim)).get();
    if (!stolen) throw new Error("victim credential missing");
    t.db
      .update(credentials)
      .set({ ciphertext: stolen.ciphertext, wrappedKey: stolen.wrappedKey })
      .where(eq(credentials.accountId, other))
      .run();

    expect(await codeOf(() => vault.get(other))).toBe("unreadable");
  });

  it("reports a missing credential and a missing account", async () => {
    const t = testStore();
    const vault = Vault.open(t.db, masterKey());
    const accountId = addAccount(t, "notion", "notion");
    expect(await codeOf(() => vault.get(accountId))).toBe("no_credential");
    expect(await codeOf(() => vault.put("acc_missing", { type: "static", value: "x" }))).toBe(
      "no_credential",
    );
  });

  it("rejects an invalid payload without echoing it", () => {
    const t = testStore();
    const vault = Vault.open(t.db, masterKey());
    const accountId = addAccount(t, "notion", "notion");
    const payload = { type: "static", value: "secret_ntn_123", extra: "secret_ntn_456" };
    try {
      vault.put(accountId, payload as never);
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain("secret_ntn_");
    }
  });
});

describe("Vault OAuth refresh", () => {
  const T0 = new Date("2026-11-13T12:00:00Z");

  function setup(refresher: OAuthRefresher | undefined) {
    const t = testStore();
    const onReconnectRequired = vi.fn<(accountId: string) => void>();
    const vault = Vault.open(t.db, masterKey(), {
      refreshers: (provider) => (provider === "gmail" ? refresher : undefined),
      now: () => T0,
      onReconnectRequired,
    });
    const accountId = addAccount(t, "gmail-work", "gmail");
    return { t, vault, accountId, onReconnectRequired };
  }

  it("returns the stored token while it is fresh, without refreshing", async () => {
    const refresher = vi.fn<OAuthRefresher>();
    const { vault, accountId } = setup(refresher);
    vault.put(accountId, {
      type: "oauth",
      accessToken: ACCESS,
      refreshToken: REFRESH,
      expiresAt: T0.getTime() + 3_600_000,
    });
    expect((await vault.accessToken(accountId)).reveal()).toBe(ACCESS);
    expect(refresher).not.toHaveBeenCalled();
  });

  it("refreshes once for concurrent callers and persists a rotated refresh token first", async () => {
    let release: (tokens: OAuthTokens) => void = () => {};
    const refresher = vi.fn<OAuthRefresher>(
      () =>
        new Promise<OAuthTokens>((resolve) => {
          release = resolve;
        }),
    );
    const { vault, accountId } = setup(refresher);
    vault.put(accountId, {
      type: "oauth",
      accessToken: ACCESS,
      refreshToken: REFRESH,
      expiresAt: T0.getTime() + 30_000, // inside the 60 s refresh skew
    });

    const first = vault.accessToken(accountId);
    const second = vault.accessToken(accountId);
    await vi.waitFor(() => expect(refresher).toHaveBeenCalledTimes(1));
    expect(refresher.mock.calls[0]?.[0].refreshToken.reveal()).toBe(REFRESH);
    release({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: T0.getTime() + 3_600_000,
    });

    expect((await first).reveal()).toBe("new-access");
    expect((await second).reveal()).toBe("new-access");
    expect(refresher).toHaveBeenCalledTimes(1);
    const stored = vault.get(accountId);
    expect(stored.type === "oauth" && stored.refreshToken?.reveal()).toBe("new-refresh");
    expect(stored.type === "oauth" && stored.expiresAt?.getTime()).toBe(T0.getTime() + 3_600_000);
  });

  it("keeps the old refresh token when the provider does not rotate it", async () => {
    const refresher = vi.fn<OAuthRefresher>(async () => ({ accessToken: "new-access" }));
    const { vault, accountId } = setup(refresher);
    vault.put(accountId, { type: "oauth", accessToken: ACCESS, refreshToken: REFRESH });
    expect((await vault.accessToken(accountId, { force: true })).reveal()).toBe("new-access");
    const stored = vault.get(accountId);
    expect(stored.type === "oauth" && stored.refreshToken?.reveal()).toBe(REFRESH);
  });

  it("marks the account reconnect_required when refresh fails, and stays closed", async () => {
    const refresher = vi.fn<OAuthRefresher>(async () => {
      throw new Error("invalid_grant");
    });
    const { t, vault, accountId, onReconnectRequired } = setup(refresher);
    vault.put(accountId, {
      type: "oauth",
      accessToken: ACCESS,
      refreshToken: REFRESH,
      expiresAt: T0.getTime() - 1,
    });

    expect(await codeOf(() => vault.accessToken(accountId))).toBe("reconnect_required");
    expect(onReconnectRequired).toHaveBeenCalledWith(accountId);
    const account = t.db.select().from(accounts).where(eq(accounts.id, accountId)).get();
    expect(account?.status).toBe("reconnect_required");

    // Later calls fail without retrying the dead grant.
    expect(await codeOf(() => vault.accessToken(accountId))).toBe("reconnect_required");
    expect(refresher).toHaveBeenCalledTimes(1);

    // Reconnecting stores a fresh credential and reopens the account.
    vault.put(accountId, { type: "oauth", accessToken: "reconnected", refreshToken: REFRESH });
    expect((await vault.accessToken(accountId)).reveal()).toBe("reconnected");
  });

  it("marks reconnect_required when there is no refresher or no refresh token", async () => {
    const { vault, accountId } = setup(undefined);
    vault.put(accountId, { type: "oauth", accessToken: ACCESS, expiresAt: T0.getTime() - 1 });
    expect(await codeOf(() => vault.accessToken(accountId))).toBe("reconnect_required");
  });

  it("treats an invalid refresh response as a failed refresh", async () => {
    const refresher = vi.fn<OAuthRefresher>(async () => ({ accessToken: "" }));
    const { vault, accountId } = setup(refresher);
    vault.put(accountId, { type: "oauth", accessToken: ACCESS, refreshToken: REFRESH });
    expect(await codeOf(() => vault.accessToken(accountId, { force: true }))).toBe(
      "reconnect_required",
    );
  });

  it("returns static credentials as they are", async () => {
    const { vault, t } = setup(undefined);
    const slack = addAccount(t, "slack", "slack");
    vault.put(slack, { type: "static", value: "xoxb-example" });
    expect((await vault.accessToken(slack)).reveal()).toBe("xoxb-example");
  });
});
