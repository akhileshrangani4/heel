import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { UpstreamPool } from "../../src/definitions/mcp/upstream.ts";
import { definitionRegistry } from "../../src/definitions/registry.ts";
import { addAgent } from "../../src/gateway/agents.ts";
import { createPipeline } from "../../src/gateway/pipeline/pipeline.ts";
import { approverIds, SqliteApprovalStore } from "../../src/store/approvals.ts";
import { findAccount } from "../../src/store/directory.ts";
import { newId } from "../../src/store/ids.ts";
import { SqlitePauseStore } from "../../src/store/pauses.ts";
import { users } from "../../src/store/schema.ts";
import {
  accountApproverIds,
  accountsUsableBy,
  mayUseAccount,
  SharingError,
  setApprovers,
  shareAccount,
  unshareAccount,
} from "../../src/store/sharing.ts";
import { KEY_BYTES } from "../../src/vault/crypto.ts";
import { Vault } from "../../src/vault/vault.ts";
import { captureLogger } from "../helpers/log.ts";
import { compileRules } from "../helpers/pipeline.ts";
import { addAccount, testStore } from "../helpers/store.ts";

/** Account sharing and approvers (D13b; spec: Teams). */

function setUp() {
  const t = testStore();
  const now = new Date();
  const person = (name: string, groups: string[] = [], role: "admin" | "member" = "member") => {
    const id = newId("user");
    t.db.insert(users).values({ id, orgId: t.orgId, name, role, groups, createdAt: now }).run();
    return id;
  };
  const bea = person("bea", ["support"]);
  const cal = person("cal", ["engineering"]);
  const ada = person("ada", [], "admin");
  addAccount(t, "github", "github");
  const account = findAccount(t.db, t.orgId, "github");
  if (account === null) throw new Error("no account");
  return { t, now, bea, cal, ada, account };
}

describe("who may use an account", () => {
  it("is its owner, and whoever it is shared with, by name or group", () => {
    const { t, now, bea, cal, account } = setUp();
    expect(mayUseAccount(t.db, account, t.ownerId)).toBe(true);
    expect(mayUseAccount(t.db, account, bea)).toBe(false);
    shareAccount(t.db, t.orgId, "github", { kind: "user", name: "bea" }, now);
    shareAccount(t.db, t.orgId, "github", { kind: "group", name: "engineering" }, now);
    expect(mayUseAccount(t.db, account, bea)).toBe(true);
    expect(mayUseAccount(t.db, account, cal)).toBe(true);
    expect(accountsUsableBy(t.db, t.orgId, cal).map((a) => a.alias)).toEqual(["github"]);
    unshareAccount(t.db, t.orgId, "github", { kind: "user", name: "bea" });
    expect(mayUseAccount(t.db, account, bea)).toBe(false);
  });

  it("isn't a disabled user, whatever the account is shared with", () => {
    const { t, now, cal, account } = setUp();
    shareAccount(t.db, t.orgId, "github", { kind: "group", name: "engineering" }, now);
    t.db.update(users).set({ disabledAt: now }).where(eq(users.id, cal)).run();
    expect(mayUseAccount(t.db, account, cal)).toBe(false);
  });

  it("refuses a user that doesn't exist", () => {
    const { t, now } = setUp();
    expect(() =>
      shareAccount(t.db, t.orgId, "github", { kind: "user", name: "nobody" }, now),
    ).toThrow(SharingError);
  });
});

describe("who decides an account's asks", () => {
  it("is the owner until the account names approvers", () => {
    const { t, now, bea, cal } = setUp();
    expect(accountApproverIds(t.db, t.orgId, "github", undefined)).toEqual([t.ownerId]);
    setApprovers(t.db, t.orgId, "github", null, [{ kind: "user", name: "bea" }], now);
    expect(accountApproverIds(t.db, t.orgId, "github", undefined)).toEqual([bea]);
    setApprovers(
      t.db,
      t.orgId,
      "github",
      "acme/web",
      [{ kind: "group", name: "engineering" }],
      now,
    );
    expect(accountApproverIds(t.db, t.orgId, "github", "Acme/Web")).toEqual([cal]);
    expect(accountApproverIds(t.db, t.orgId, "github", "acme/other")).toEqual([bea]);
    setApprovers(t.db, t.orgId, "github", null, [], now);
    expect(accountApproverIds(t.db, t.orgId, "github", "acme/other")).toEqual([t.ownerId]);
  });

  it("isn't an admin who isn't an approver; an org ask goes to admins", () => {
    const { t, ada } = setUp();
    const row = { orgId: t.orgId, account: "github", origin: "owner" as const };
    expect(approverIds(t.db, row)).not.toContain(ada);
    expect(approverIds(t.db, { ...row, origin: "org" as const })).toContain(ada);
  });

  it("follows the call's repo", () => {
    const { t, now, cal } = setUp();
    setApprovers(t.db, t.orgId, "github", "acme/web", [{ kind: "user", name: "cal" }], now);
    const row = { orgId: t.orgId, account: "github", origin: "owner" as const };
    expect(approverIds(t.db, { ...row, call: { repo: "acme/web" } })).toEqual([cal]);
    expect(approverIds(t.db, { ...row, call: {} })).toEqual([t.ownerId]);
  });

  it("names per-repo approvers only on GitHub accounts", () => {
    const { t, now } = setUp();
    addAccount(t, "mail", "gmail");
    expect(() =>
      setApprovers(t.db, t.orgId, "mail", "acme/web", [{ kind: "user", name: "bea" }], now),
    ).toThrow(/only for GitHub/);
  });
});

describe("an agent using a shared account", () => {
  it("reaches it only while its owner may", async () => {
    const { t, now, bea } = setUp();
    const { logger } = captureLogger();
    const vault = Vault.open(t.db, { bytes: randomBytes(KEY_BYTES), source: "test" });
    const pipeline = createPipeline({
      db: t.db,
      rules: { set: compileRules({ owner: "rules:\n  - match: {}\n    then: allow\n" }) },
      definitions: definitionRegistry({
        upstream: new UpstreamPool({ vault: null, log: logger }),
        gmail: null,
        github: { vault, fetch: async () => Response.json([]) },
      }),
      pauses: new SqlitePauseStore(),
      approvals: new SqliteApprovalStore(),
      log: logger,
      alerts: { raise: () => {} },
      watch: false,
    });
    const { agentId } = addAgent(t.db, { orgId: t.orgId, ownerId: bea, name: "beabot" }, now);
    const agent = { orgId: t.orgId, agentId, agentName: "beabot", ownerId: bea, tokenId: "tok_1" };
    const call = () =>
      pipeline.run({
        agent,
        surface: "mcp",
        account: "github",
        tool: "list_issues",
        args: { repo: "acme/web" },
      });
    expect(await call()).toMatchObject({ status: "denied", reason: "account_unavailable" });
    shareAccount(t.db, t.orgId, "github", { kind: "group", name: "support" }, now);
    // bea has no rules file, so the default deny decides: but the account is now hers to use.
    expect(await call()).toMatchObject({ status: "denied", reason: "no_rule_matched" });
  });
});
