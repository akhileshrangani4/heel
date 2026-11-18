import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { compileRulesText } from "../../src/config/rules.ts";
import { UpstreamPool } from "../../src/definitions/mcp/upstream.ts";
import { definitionRegistry } from "../../src/definitions/registry.ts";
import { addAgent } from "../../src/gateway/agents.ts";
import { createPipeline } from "../../src/gateway/pipeline/pipeline.ts";
import { approverIds, decideApproval, SqliteApprovalStore } from "../../src/store/approvals.ts";
import { findAccount } from "../../src/store/directory.ts";
import { createGrant } from "../../src/store/grants.ts";
import { newId } from "../../src/store/ids.ts";
import { setMode } from "../../src/store/modes.ts";
import { enqueueApprovalNotifications } from "../../src/store/notifications.ts";
import { SqlitePauseStore } from "../../src/store/pauses.ts";
import { approvals, notificationDeliveries, users } from "../../src/store/schema.ts";
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
    t.db
      .insert(users)
      .values({ id, orgId: t.orgId, name, role, groups, groupsSyncedAt: now, createdAt: now })
      .run();
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
    const row = { orgId: t.orgId, account: "github", origin: "owner" as const, call: {} };
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

describe("sharing, against the review's attacks", () => {
  const BEA_ASKS = "rules:\n  - match: { action: github.issue.create }\n    then: ask\n";

  function shared(options: { beaRules?: string } = {}) {
    const base = setUp();
    const { t, now, bea } = base;
    const { logger } = captureLogger();
    const vault = Vault.open(t.db, { bytes: randomBytes(KEY_BYTES), source: "test" });
    const accountId = findAccount(t.db, t.orgId, "github")?.id ?? "";
    vault.put(accountId, { type: "static", value: "gh-test-token" });
    addAccount(t, "github2", "github");
    vault.put(findAccount(t.db, t.orgId, "github2")?.id ?? "", {
      type: "static",
      value: "gh-test-token",
    });
    const sent: string[] = [];
    const store = new SqliteApprovalStore();
    const pauses = new SqlitePauseStore();
    const rules = {
      org: null,
      owners: new Map([
        [
          "bea",
          compileRulesText(
            options.beaRules ?? BEA_ASKS,
            "/heel/rules/bea.yaml",
            "rules/bea.yaml",
            "owner",
          ).file,
        ],
      ]),
    };
    const pipeline = createPipeline({
      db: t.db,
      rules: { set: rules },
      definitions: definitionRegistry({
        upstream: new UpstreamPool({ vault: null, log: logger }),
        gmail: null,
        github: {
          vault,
          fetch: async (input) => {
            sent.push(new URL(input.toString()).pathname);
            return Response.json({ number: 1, title: "t", state: "open" }, { status: 201 });
          },
        },
      }),
      pauses,
      approvals: store,
      log: logger,
      alerts: { raise: () => {} },
      watch: false,
    });
    const { agentId } = addAgent(t.db, { orgId: t.orgId, ownerId: bea, name: "beabot" }, now);
    const agent = { orgId: t.orgId, agentId, agentName: "beabot", ownerId: bea, tokenId: "tok_1" };
    for (const alias of ["github", "github2"]) {
      shareAccount(t.db, t.orgId, alias, { kind: "user", name: "bea" }, now);
    }
    const issue = (account: string, repo: string) =>
      pipeline.run({
        agent,
        surface: "mcp",
        account,
        tool: "create_issue",
        args: { repo, title: "t" },
      });
    return { ...base, store, pauses, issue, sent, agentId };
  }

  it("scopes a standing approval to the account and repo its approver decides", async () => {
    const h = shared();
    setApprovers(h.t.db, h.t.orgId, "github", "acme/web", [{ kind: "user", name: "cal" }], h.now);
    const first = await h.issue("github", "acme/web");
    if (first.status !== "pending") throw new Error("expected an ask");
    const row = h.t.db.select().from(approvals).where(eq(approvals.id, first.approvalId)).get();
    const decided = decideApproval(h.t.db, h.store, h.pauses, {
      approver: { orgId: h.t.orgId, userId: h.cal, role: "member" },
      approvalId: first.approvalId,
      callHash: row?.callHash ?? "",
      intent: "approve",
      standing: { scope: "rule", duration: "1h" },
      now: h.now,
    });
    expect(decided).toMatchObject({ ok: true });
    expect((await h.issue("github", "acme/web")).status).toBe("allowed");
    // Another repo on the same account, and the same repo on another account, still ask.
    expect((await h.issue("github", "acme/payments")).status).toBe("pending");
    expect((await h.issue("github2", "acme/web")).status).toBe("pending");
  });

  it("notifies the approvers of the call's repo", async () => {
    const h = shared();
    h.t.db.update(users).set({ email: "cal@example.com" }).where(eq(users.id, h.cal)).run();
    setApprovers(h.t.db, h.t.orgId, "github", "acme/web", [{ kind: "user", name: "cal" }], h.now);
    const ask = await h.issue("github", "acme/web");
    if (ask.status !== "pending") throw new Error("expected an ask");
    enqueueApprovalNotifications(h.t.db, {
      orgId: h.t.orgId,
      approvalId: ask.approvalId,
      channels: new Set(["email"]),
      now: h.now,
    });
    const to = h.t.db
      .select()
      .from(notificationDeliveries)
      .all()
      .map((d) => d.userId);
    expect(to).toEqual([h.cal]);
  });

  it("applies the account owner's rollout mode too, strictest wins", async () => {
    const h = shared({ beaRules: "rules: []\n" });
    setMode(h.t.db, { orgId: h.t.orgId, ownerId: h.bea, mode: "record", by: h.ada, at: h.now });
    // bea is in record mode, but the account's owner enforces: the default deny holds.
    expect(await h.issue("github", "acme/web")).toMatchObject({ status: "denied" });
    expect(h.sent).toEqual([]);
  });

  it("lets a grant answer an ask on a shared account only when its signer approves it", async () => {
    const h = shared();
    const grant = (by: string) =>
      createGrant(h.t.db, {
        orgId: h.t.orgId,
        agentId: h.agentId,
        task: "file issues",
        match: "{ action: github.issue.create }",
        by,
        now: h.now,
        expiresAt: new Date(h.now.getTime() + 3_600_000),
      });
    grant(h.bea);
    expect((await h.issue("github", "acme/web")).status).toBe("pending");
    setApprovers(h.t.db, h.t.orgId, "github", null, [{ kind: "user", name: "cal" }], h.now);
    grant(h.cal);
    expect((await h.issue("github", "acme/web")).status).toBe("allowed");
  });

  it("stops counting groups a day after they were read", () => {
    const { t, now, cal, account } = setUp();
    shareAccount(t.db, t.orgId, "github", { kind: "group", name: "engineering" }, now);
    t.db.update(users).set({ groupsSyncedAt: now }).where(eq(users.id, cal)).run();
    expect(mayUseAccount(t.db, account, cal, now)).toBe(true);
    expect(mayUseAccount(t.db, account, cal, new Date(now.getTime() + 13 * 3_600_000))).toBe(false);
  });

  it("closes a disabled owner's account to everyone", () => {
    const { t, now, bea, account } = setUp();
    shareAccount(t.db, t.orgId, "github", { kind: "user", name: "bea" }, now);
    t.db.update(users).set({ disabledAt: now }).where(eq(users.id, t.ownerId)).run();
    expect(mayUseAccount(t.db, account, bea)).toBe(false);
  });
});
