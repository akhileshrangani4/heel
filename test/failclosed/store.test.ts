import { describe, expect, it } from "vitest";
import { oneRule, type PipelineHarness, pipelineHarness } from "../helpers/pipeline.ts";

/**
 * Fail-closed row "SQLite read or write fails, or the disk is full" (spec:
 * Fail-closed behavior): the call is denied, admins are alerted, and a call
 * never runs unless its count reservation and audit row committed first.
 * The store is made to fail for real: the connection turns read-only, or a
 * temporary trigger or a missing table makes SQLite refuse the statement.
 */

/** Never logged: error messages can carry a statement's bound parameters. */
const SECRET = "tok_live_never_in_logs_7Qx";
const SEND = { action: "email.send", recipients: ["bob@vendor.com"], body: SECRET };
const ALLOW_SENDS = oneRule("{ action: email.send }");

function sql(h: PipelineHarness, statement: string): void {
  h.t.store.sqlite.exec(statement);
}

describe("fail closed: the store", () => {
  it("denies a call while the database is read-only, alerts admins, and recovers after", async () => {
    const h = pipelineHarness({ owner: ALLOW_SENDS });
    h.t.store.sqlite.pragma("query_only = ON");

    const denied = await h.call({ args: SEND });

    expect(denied).toEqual({ status: "denied", reason: "internal", rule: null });
    expect(h.provider.executed).toEqual([]);
    expect(h.alerts).toEqual([{ kind: "store_unavailable", code: "SQLITE_READONLY" }]);
    expect(h.logs()).toContain("internal deny not audited");
    expect(h.logs()).not.toContain(SECRET);

    h.t.store.sqlite.pragma("query_only = OFF");
    // Nothing from the read-only spell was half-written.
    expect(h.counts()).toEqual([]);
    expect(h.audit()).toEqual([]);
    expect((await h.call({ args: SEND })).status).toBe("allowed");
    expect(h.provider.executed).toHaveLength(1);
  });

  it("never runs a call whose audit row the store refuses, and rolls its count back", async () => {
    const h = pipelineHarness({ owner: ALLOW_SENDS });
    sql(
      h,
      `CREATE TEMP TRIGGER refuse_audit BEFORE INSERT ON main.audit_log
       BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`,
    );

    const result = await h.call({ args: SEND });

    expect(result).toEqual({ status: "denied", reason: "internal", rule: null });
    expect(h.provider.executed).toEqual([]);
    // The reservation shared the audit row's transaction, so it went with it.
    expect(h.counts()).toEqual([]);
    // One alert, though the internal deny's own audit row was refused too.
    expect(h.alerts).toEqual([{ kind: "store_unavailable", code: "SQLITE_CONSTRAINT_TRIGGER" }]);
    expect(h.logs()).not.toContain(SECRET);
  });

  it("never runs a call whose count reservation the store refuses, and audits the deny", async () => {
    const h = pipelineHarness({ owner: ALLOW_SENDS });
    sql(
      h,
      `CREATE TEMP TRIGGER refuse_counts BEFORE INSERT ON main.count_events
       BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`,
    );

    const result = await h.call({ args: SEND });

    expect(result).toEqual({ status: "denied", reason: "internal", rule: null });
    expect(h.provider.executed).toEqual([]);
    // The allow's audit row rolled back with the reservation; only the internal deny remains.
    expect(h.audit()).toEqual([expect.objectContaining({ kind: "deny", reason: "internal" })]);
    expect(h.alerts).toEqual([{ kind: "store_unavailable", code: "SQLITE_CONSTRAINT_TRIGGER" }]);
  });

  it("denies a call when the store can't read the counts a rule needs", async () => {
    const h = pipelineHarness({
      owner: `rules:
  - match: { action: email.send, items: { over: 5, per: hour } }
    then: ask
  - match: { action: email.send }
    then: allow
`,
    });
    sql(h, "ALTER TABLE count_events RENAME TO count_events_away");

    const result = await h.call({ args: SEND });

    expect(result).toEqual({ status: "denied", reason: "internal", rule: null });
    // Unknown counts never read as zero, so the allow below never decides.
    expect(h.provider.executed).toEqual([]);
    expect(h.alerts).toEqual([{ kind: "store_unavailable", code: "SQLITE_ERROR" }]);
    expect(h.audit()).toEqual([expect.objectContaining({ kind: "deny", reason: "internal" })]);
    expect(h.logs()).not.toContain(SECRET);
  });

  it("raises no store alert for a failure that isn't the store's", async () => {
    const h = pipelineHarness({ owner: ALLOW_SENDS });
    h.provider.normalizeHook = () => {
      throw new Error(`definition bug near ${SECRET}`);
    };

    const result = await h.call({ args: SEND });

    expect(result).toEqual({ status: "denied", reason: "internal", rule: null });
    expect(h.alerts).toEqual([]);
  });
});
