import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { asc } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { HeelConfigFileSchema, resolveConfig } from "../../src/config/schema.ts";
import type { RuleRef } from "../../src/core/call.ts";
import { addAgent } from "../../src/gateway/agents.ts";
import { createLogger } from "../../src/log.ts";
import { startHeel } from "../../src/serve.ts";
import type { HeelDb } from "../../src/store/db.ts";
import { newId } from "../../src/store/ids.ts";
import { approvals, countEvents, pauses, standingApprovals } from "../../src/store/schema.ts";
import { encodeMasterKey, MASTER_KEY_ENV } from "../../src/vault/key.ts";
import { reopen, type TestStore, testStore } from "../helpers/store.ts";

const SRC = join(import.meta.dirname, "..", "..", "src");
const HOUR = 60 * 60 * 1000;
const RULE: RuleRef = { name: "client-sends-ask", file: "rules/owner.yaml", line: 3 };

/** The decision state I-04 says must outlive a restart. */
function snapshot(db: HeelDb) {
  return {
    counts: db.select().from(countEvents).orderBy(asc(countEvents.id)).all(),
    approvals: db.select().from(approvals).orderBy(asc(approvals.id)).all(),
    standing: db.select().from(standingApprovals).orderBy(asc(standingApprovals.id)).all(),
    pauses: db.select().from(pauses).orderBy(asc(pauses.scope), asc(pauses.target)).all(),
  };
}

/**
 * Writes one of each kind of durable decision state: per-run and per-hour
 * count events, a pending approval, an approved one with a standing approval
 * granted from it, and agent and global pauses.
 */
function seedDecisionState(t: TestStore, now: Date): { agentId: string; pendingHash: string } {
  const { agentId } = addAgent(
    t.db,
    { orgId: t.orgId, ownerId: t.ownerId, name: "inbox-bot" },
    now,
  );
  const offsetBy = (ms: number) => new Date(now.getTime() + ms);
  const removal = { account: "gmail-work", provider: "gmail", action: "email.remove" };

  t.db
    .insert(countEvents)
    .values([
      { orgId: t.orgId, agentId, runId: "r1", fields: removal, items: 12, at: offsetBy(-2 * HOUR) },
      { orgId: t.orgId, agentId, runId: "r1", fields: removal, items: 8, at: offsetBy(-HOUR) },
      // No run id: counts toward per-hour limits only (I-25, I-26).
      { orgId: t.orgId, agentId, runId: null, fields: removal, items: 1, at: now },
    ])
    .run();

  const pendingHash = "a".repeat(64);
  const approvedId = newId("approval");
  const send = {
    surface: "mcp",
    account: "gmail-work",
    tool: "send",
    args: { to: ["ceo@clientco.com"], subject: "Q3" },
  };
  t.db
    .insert(approvals)
    .values([
      {
        id: newId("approval"),
        orgId: t.orgId,
        agentId,
        ownerId: t.ownerId,
        runId: "r1",
        callHash: pendingHash,
        account: "gmail-work",
        tool: "send",
        call: send,
        origin: "owner",
        rule: RULE,
        ruleHash: "r".repeat(64),
        status: "pending",
        createdAt: now,
        expiresAt: offsetBy(24 * HOUR),
      },
      {
        id: approvedId,
        orgId: t.orgId,
        agentId,
        ownerId: t.ownerId,
        runId: null,
        callHash: "b".repeat(64),
        account: "gmail-work",
        tool: "send",
        call: { ...send, args: { to: ["bob@vendor.com"] } },
        origin: "owner",
        rule: RULE,
        ruleHash: "r".repeat(64),
        status: "approved",
        createdAt: offsetBy(-HOUR),
        expiresAt: offsetBy(HOUR),
        decidedAt: now,
        decidedBy: t.ownerId,
      },
    ])
    .run();

  t.db
    .insert(standingApprovals)
    .values({
      id: newId("standingApproval"),
      orgId: t.orgId,
      agentId,
      approvalId: approvedId,
      scope: "rule",
      callHash: null,
      rule: RULE,
      ruleHash: "r".repeat(64),
      createdBy: t.ownerId,
      createdAt: now,
      expiresAt: offsetBy(7 * 24 * HOUR),
    })
    .run();

  t.db
    .insert(pauses)
    .values([
      { orgId: t.orgId, scope: "agent", target: agentId, pausedBy: t.ownerId, pausedAt: now },
      { orgId: t.orgId, scope: "global", target: "", pausedBy: t.ownerId, pausedAt: now },
    ])
    .run();

  return { agentId, pendingHash };
}

describe("store restart", () => {
  it("I-04: counters, pending and standing approvals and pause state survive a restart", () => {
    const t = testStore();
    seedDecisionState(t, new Date("2026-11-13T12:00:00Z"));
    const before = snapshot(t.db);
    expect(before.counts).toHaveLength(3);
    expect(before.approvals.map((row) => row.status).sort()).toEqual(["approved", "pending"]);
    expect(before.standing).toHaveLength(1);
    expect(before.pauses).toHaveLength(2);

    const restarted = reopen(t);

    // Same rows, same values, same types (Dates and JSON come back as written).
    expect(snapshot(restarted.db)).toEqual(before);
  });

  it("I-04: a committed write survives a crash with no clean close", () => {
    const t = testStore();
    const { agentId } = addAgent(
      t.db,
      { orgId: t.orgId, ownerId: t.ownerId, name: "inbox-bot" },
      new Date(),
    );
    t.store.close();

    // A separate process commits through the real store, then is SIGKILLed:
    // no close(), no WAL checkpoint, no exit handlers.
    const script = `
      import { writeSync } from "node:fs";
      import { openStore } from ${JSON.stringify(pathToFileURL(join(SRC, "store", "db.ts")).href)};
      import { approvals, countEvents, pauses } from ${JSON.stringify(pathToFileURL(join(SRC, "store", "schema.ts")).href)};
      const seed = JSON.parse(process.env.HEEL_TEST_SEED);
      const now = new Date(seed.now);
      const store = openStore(seed.path);
      store.db.transaction((tx) => {
        tx.insert(countEvents).values({ orgId: seed.orgId, agentId: seed.agentId, runId: "r1",
          fields: { action: "email.remove" }, items: 20, at: now }).run();
        tx.insert(approvals).values({ id: "apr_crash", orgId: seed.orgId, agentId: seed.agentId,
          ownerId: seed.ownerId, runId: "r1", callHash: "c".repeat(64), account: "gmail-work",
          tool: "send", call: {}, origin: "owner", rule: { name: null, file: "rules.yaml", line: 1 },
          ruleHash: "r".repeat(64), status: "pending", createdAt: now,
          expiresAt: new Date(now.getTime() + 86400000) }).run();
        tx.insert(pauses).values({ orgId: seed.orgId, scope: "agent", target: seed.agentId,
          pausedBy: seed.ownerId, pausedAt: now }).run();
      });
      writeSync(1, "committed\\n");
      process.kill(process.pid, "SIGKILL");
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: {
        PATH: process.env["PATH"],
        HEEL_TEST_SEED: JSON.stringify({
          path: t.path,
          orgId: t.orgId,
          ownerId: t.ownerId,
          agentId,
          now: Date.now(),
        }),
      },
      encoding: "utf8",
    });
    expect(child.stderr).toBe("");
    expect(child.stdout).toBe("committed\n");
    expect(child.signal).toBe("SIGKILL");

    const restarted = reopen(t);
    const after = snapshot(restarted.db);
    expect(after.counts).toEqual([expect.objectContaining({ agentId, runId: "r1", items: 20 })]);
    expect(after.approvals).toEqual([
      expect.objectContaining({ id: "apr_crash", status: "pending" }),
    ]);
    expect(after.pauses).toEqual([expect.objectContaining({ scope: "agent", target: agentId })]);
  });

  it("I-04: booting heel serve over an existing install keeps its decision state", async () => {
    const t = testStore();
    seedDecisionState(t, new Date("2026-11-13T12:00:00Z"));
    const before = snapshot(t.db);
    t.store.close();

    const config = resolveConfig(
      HeelConfigFileSchema.parse({
        database: t.path,
        admin_socket: "run/admin.sock",
        listen: { agent: "127.0.0.1:0", human: "127.0.0.1:0" },
      }),
      t.dir,
      null,
    );
    const env = { [MASTER_KEY_ENV]: encodeMasterKey(randomBytes(32)) };
    const heel = await startHeel({ config, env, log: createLogger("silent"), version: "test" });
    expect(heel.planes.agent.state).toBe("listening");
    await heel.close();

    expect(snapshot(reopen(t).db)).toEqual(before);
  });

  it("I-04: after a restart a re-sent pending call still joins its request instead of duplicating it", () => {
    const t = testStore();
    const now = new Date("2026-11-13T12:00:00Z");
    const { agentId, pendingHash } = seedDecisionState(t, now);
    const restarted = reopen(t);

    const duplicatePending = () =>
      restarted.db
        .insert(approvals)
        .values({
          id: newId("approval"),
          orgId: t.orgId,
          agentId,
          ownerId: t.ownerId,
          runId: "r2",
          callHash: pendingHash,
          account: "gmail-work",
          tool: "send",
          call: {},
          origin: "owner",
          rule: RULE,
          ruleHash: "r".repeat(64),
          status: "pending",
          createdAt: now,
          expiresAt: new Date(now.getTime() + 24 * HOUR),
        })
        .run();
    expect(duplicatePending).toThrow(/UNIQUE constraint failed/);
  });
});
