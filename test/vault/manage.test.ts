import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { newId } from "../../src/store/ids.ts";
import { agents, approvals, credentials, grants } from "../../src/store/schema.ts";
import { ConnectError } from "../../src/vault/connect.ts";
import { KEY_BYTES } from "../../src/vault/crypto.ts";
import { removeAccount, setAccountCredential } from "../../src/vault/manage.ts";
import { Vault } from "../../src/vault/vault.ts";
import { addAccount, testStore } from "../helpers/store.ts";

/** `heel account remove` and `heel account set <alias> --credential-stdin` (T7). */

function setUp() {
  const t = testStore();
  const vault = Vault.open(t.db, { bytes: randomBytes(KEY_BYTES), source: "test" });
  const agentId = newId("agent");
  t.db
    .insert(agents)
    .values({ id: agentId, orgId: t.orgId, ownerId: t.ownerId, name: "bot", createdAt: new Date() })
    .run();
  return { t, vault, agentId };
}

function pendingApproval(t: ReturnType<typeof setUp>["t"], agentId: string, account: string) {
  const id = newId("approval");
  t.db
    .insert(approvals)
    .values({
      id,
      orgId: t.orgId,
      agentId,
      ownerId: t.ownerId,
      callHash: randomBytes(16).toString("hex"),
      account,
      tool: "send",
      call: { account, tool: "send", args: {} } as never,
      origin: "owner",
      rule: { name: null, file: "rules/owner.yaml", line: 2 },
      ruleHash: "h",
      status: "pending",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    .run();
  return id;
}

function grant(t: ReturnType<typeof setUp>["t"], agentId: string, match: string) {
  const id = newId("grant");
  t.db
    .insert(grants)
    .values({
      id,
      orgId: t.orgId,
      agentId,
      task: "t",
      match,
      createdBy: t.ownerId,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    .run();
  return id;
}

describe("removeAccount", () => {
  it("deletes the account and its credential, and ends what would carry over to a new one", () => {
    const { t, vault, agentId } = setUp();
    const id = addAccount(t, "tickets", "http");
    addAccount(t, "other", "http");
    vault.put(id, { type: "static", value: "test-token-aaaa" });
    const pending = pendingApproval(t, agentId, "tickets");
    const elsewhere = pendingApproval(t, agentId, "other");
    const named = grant(t, agentId, "{ account: tickets, action: tickets.close }");
    const listed = grant(t, agentId, "{ account: [other, tickets] }");
    const unrelated = grant(t, agentId, "{ account: other }");

    const removed = removeAccount(t.db, t.orgId, "tickets", new Date());

    expect(removed).toMatchObject({ alias: "tickets", expiredApprovals: 1, revokedGrants: 2 });
    expect(t.db.select().from(credentials).where(eq(credentials.accountId, id)).all()).toEqual([]);
    const status = (approvalId: string) =>
      t.db.select().from(approvals).where(eq(approvals.id, approvalId)).get()?.status;
    expect(status(pending)).toBe("expired");
    expect(status(elsewhere)).toBe("pending");
    const revoked = (grantId: string) =>
      t.db.select().from(grants).where(eq(grants.id, grantId)).get()?.revokedAt !== null;
    expect([revoked(named), revoked(listed), revoked(unrelated)]).toEqual([true, true, false]);
    // The alias is free again.
    expect(() => removeAccount(t.db, t.orgId, "tickets", new Date())).toThrow(ConnectError);
    addAccount(t, "tickets", "http");
  });
});

describe("setAccountCredential", () => {
  it("replaces a static key and keeps the account active", () => {
    const { t, vault } = setUp();
    const id = addAccount(t, "tickets", "http");
    vault.put(id, { type: "static", value: "test-token-aaaa" });
    setAccountCredential(t.db, vault, t.orgId, "tickets", {
      type: "static",
      value: "test-token-bbbb",
    });
    const stored = vault.get(id);
    expect(stored.type === "static" && stored.value.reveal()).toBe("test-token-bbbb");
  });

  it("refuses an account that signs in with OAuth, and an unknown alias", () => {
    const { t, vault } = setUp();
    const id = addAccount(t, "gmail-work", "gmail");
    vault.put(id, {
      type: "oauth",
      accessToken: "test-access-aaaa",
      refreshToken: "test-refresh-aaaa",
    });
    expect(() =>
      setAccountCredential(t.db, vault, t.orgId, "gmail-work", { type: "static", value: "x" }),
    ).toThrow(/sign in again from the Connections page/);
    expect(() =>
      setAccountCredential(t.db, vault, t.orgId, "nope", { type: "static", value: "x" }),
    ).toThrow(/no account named "nope"/);
  });
});
