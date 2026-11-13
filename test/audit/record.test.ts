import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { asc } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  AUDIT_KINDS,
  type AuditEvent,
  type AuditKind,
  toAuditRecord,
} from "../../src/core/audit.ts";
import type { Call, RuleRef } from "../../src/core/call.ts";
import { appendAudit } from "../../src/store/audit.ts";
import { auditLog } from "../../src/store/schema.ts";
import { reopen, type TestStore, testStore } from "../helpers/store.ts";

const RULE: RuleRef = { name: "client-sends-ask", file: "rules/owner.yaml", line: 14 };

function sendCall(t: TestStore, overrides: Partial<Call> = {}): Call {
  return {
    orgId: t.orgId,
    agentId: "agt_inboxbot",
    ownerId: t.ownerId,
    runId: "run-42",
    surface: "mcp",
    account: "gmail-work",
    provider: "gmail",
    tool: "send",
    args: {
      from: "me@company.com",
      to: ["bob@vendor.com"],
      subject: "Q3",
      body: "Numbers attached.",
    },
    action: "email.send",
    kind: "write",
    recipients: ["bob@vendor.com"],
    items: 1,
    ...overrides,
  };
}

/** One event per audit kind, each carrying the fields that kind requires. */
function oneOfEachKind(t: TestStore): AuditEvent[] {
  const call = sendCall(t);
  const callHash = "a".repeat(64);
  return [
    { kind: "allow", call, callHash, rule: RULE },
    { kind: "deny", call, callHash, rule: null, reason: "no rule matched" },
    { kind: "ask", call, callHash, rule: RULE, approvalId: "apr_1" },
    { kind: "paused", call, callHash, pauseScope: "agent" },
    { kind: "expired", call, callHash, approvalId: "apr_1" },
    { kind: "approved", call, callHash, approvalId: "apr_1", approverId: t.ownerId },
    { kind: "approval_denied", call, callHash, approvalId: "apr_2", approverId: t.ownerId },
    { kind: "executed", call, callHash, approvalId: "apr_1", rule: RULE },
  ];
}

/** A raw INSERT that bypasses the typed writer, as any other code path would. */
function rawInsert(t: TestStore, columns: Record<string, string | number | null>): void {
  const base: Record<string, string | number | null> = {
    org_id: t.orgId,
    at: Date.now(),
    agent_id: "agt_inboxbot",
    owner_id: t.ownerId,
    surface: "mcp",
    account: "gmail-work",
    provider: "gmail",
    tool: "send",
    args: "{}",
    call_hash: "b".repeat(64),
  };
  const row = { ...base, ...columns };
  const names = Object.keys(row);
  t.store.sqlite
    .prepare(
      `INSERT INTO audit_log (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
    )
    .run(...Object.values(row));
}

describe("audit log", () => {
  it("I-73: every decision kind writes a complete audit row", () => {
    const t = testStore();
    const events = oneOfEachKind(t);
    // A new kind without a case here fails this test rather than going unaudited.
    expect(new Set(events.map((event) => event.kind))).toEqual(new Set<AuditKind>(AUDIT_KINDS));

    const at = new Date("2026-11-13T12:00:00.000Z");
    const ids = events.map((event) => appendAudit(t.db, event, at));
    const rows = t.db.select().from(auditLog).orderBy(asc(auditLog.id)).all();

    expect(rows.map((row) => row.id)).toEqual(ids);
    for (const [index, row] of rows.entries()) {
      const event = events[index] as AuditEvent;
      const { id: _id, ...stored } = row;
      expect(stored).toEqual(toAuditRecord(event, at));
      // The fields I-73 names: agent, run id, arguments, and who decided.
      expect(row).toMatchObject({
        agentId: "agt_inboxbot",
        runId: "run-42",
        args: event.call.args,
      });
      expect(row.rule ?? row.approvalId ?? row.pauseScope ?? row.reason).not.toBeNull();
    }
    expect(rows.find((row) => row.kind === "approved")?.approverId).toBe(t.ownerId);
    expect(rows.find((row) => row.kind === "approval_denied")?.approverId).toBe(t.ownerId);
  });

  it("records a missing run id, absent arguments and a standing approval", () => {
    const t = testStore();
    const { runId: _runId, action: _action, ...rest } = sendCall(t);
    const call: Call = { ...rest, args: undefined };
    appendAudit(t.db, {
      kind: "allow",
      call,
      callHash: "c".repeat(64),
      rule: RULE,
      standingApprovalId: "sta_1",
    });
    const [row] = t.db.select().from(auditLog).all();
    expect(row).toMatchObject({
      runId: null,
      action: null,
      args: {},
      rule: RULE,
      standingApprovalId: "sta_1",
      approvalId: null,
      approverId: null,
    });
  });

  it("I-73: the table refuses a row missing what its kind requires", () => {
    const t = testStore();
    const incomplete: Record<string, string | number | null>[] = [
      { kind: "allow" },
      { kind: "deny" },
      { kind: "ask", rule: JSON.stringify(RULE) },
      { kind: "ask", approval_id: "apr_1" },
      { kind: "paused" },
      { kind: "expired" },
      { kind: "approved", approval_id: "apr_1" },
      { kind: "approval_denied", approver_id: t.ownerId },
      { kind: "executed" },
      { kind: "maybe", reason: "not a kind" },
      { kind: "paused", pause_scope: "planet" },
      { kind: "deny", reason: "no rule matched", args: "{not json" },
    ];
    for (const columns of incomplete) {
      expect(() => rawInsert(t, columns), JSON.stringify(columns)).toThrow(/CHECK constraint/);
    }
    // Control: the same path accepts a complete row.
    rawInsert(t, { kind: "deny", reason: "no rule matched" });
    expect(t.db.select().from(auditLog).all()).toHaveLength(1);
  });

  it("I-73: rows can't be updated or deleted", () => {
    const t = testStore();
    const id = appendAudit(t.db, {
      kind: "deny",
      call: sendCall(t),
      callHash: "d".repeat(64),
      rule: null,
      reason: "no rule matched",
    });
    const { sqlite } = t.store;
    expect(() =>
      sqlite.prepare("UPDATE audit_log SET kind = 'allow' WHERE id = ?").run(id),
    ).toThrow(/append-only/);
    expect(() => sqlite.prepare("DELETE FROM audit_log WHERE id = ?").run(id)).toThrow(
      /append-only/,
    );
    expect(() => sqlite.prepare("DELETE FROM audit_log").run()).toThrow(/append-only/);
    expect(t.db.select().from(auditLog).all()).toMatchObject([{ id, kind: "deny" }]);
  });

  it("commits with the decision's transaction, or not at all", () => {
    const t = testStore();
    const event: AuditEvent = {
      kind: "ask",
      call: sendCall(t),
      callHash: "e".repeat(64),
      rule: RULE,
      approvalId: "apr_1",
    };
    expect(() =>
      t.db.transaction((tx) => {
        appendAudit(tx, event);
        throw new Error("decision failed after the audit row was staged");
      }),
    ).toThrow(/decision failed/);
    expect(t.db.select().from(auditLog).all()).toEqual([]);

    t.db.transaction((tx) => {
      appendAudit(tx, event);
    });
    expect(t.db.select().from(auditLog).all()).toHaveLength(1);
  });

  it("keeps every row across a restart", () => {
    const t = testStore();
    for (const event of oneOfEachKind(t)) appendAudit(t.db, event);
    const before = t.db.select().from(auditLog).orderBy(asc(auditLog.id)).all();
    const after = reopen(t).db.select().from(auditLog).orderBy(asc(auditLog.id)).all();
    expect(after).toEqual(before);
    expect(after).toHaveLength(AUDIT_KINDS.length);
  });

  it("has no update or delete path in the source", () => {
    const src = join(import.meta.dirname, "../../src");
    const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((file) =>
      file.endsWith(".ts"),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(join(src, file), "utf8");
      expect(text, file).not.toMatch(/\.(update|delete)\(\s*auditLog\b/);
      expect(text, file).not.toMatch(/(UPDATE|DELETE\s+FROM)\s+[`"]?audit_log\b/i);
    }
  });
});
