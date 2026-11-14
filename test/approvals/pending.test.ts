import { describe, expect, it } from "vitest";
import { approvalStatusForAgent, getApproval } from "../../src/store/approvals.ts";
import { approvalHarness, DAY, HOUR, MINUTE, pendingId, SEND } from "../helpers/approvals.ts";
import { oneRule } from "../helpers/pipeline.ts";

const ASK_SENDS = oneRule("{ action: email.send }", "ask");

describe("pending requests over the SQLite store", () => {
  it("I-50: an ask returns pending at once and nothing reaches the upstream", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });

    const result = await h.call({ args: SEND });

    const id = pendingId(result);
    expect(id).toMatch(/^apr_/);
    expect(h.status(id)).toBe("pending");
    expect(h.provider.executed).toEqual([]);
    expect(h.counts()).toEqual([]);
  });

  it("I-51: identical calls join one request, across runs, and notify once", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });

    const first = await h.call({ args: SEND, runId: "run-1" });
    const reordered = await h.call({
      args: { subject: "Q3", recipients: ["bob@vendor.com"], action: "email.send" },
      runId: "run-2",
    });
    const noRun = await h.call({ args: SEND });

    expect(reordered).toEqual(first);
    expect(noRun).toEqual(first);
    expect(h.notified).toEqual([pendingId(first)]);
  });

  it("I-51: another agent's identical call is its own request", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    const other = h.addAgent("ci-bot");

    const mine = pendingId(await h.call({ args: SEND }));
    const theirs = pendingId(await h.call({ agent: other, args: SEND }));

    expect(theirs).not.toBe(mine);
    expect(h.notified).toEqual([mine, theirs]);
  });

  it("check-back is read-only and scoped to the agent that asked", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    const other = h.addAgent("ci-bot");
    const id = pendingId(await h.call({ args: SEND }));

    expect(approvalStatusForAgent(h.t.db, h.agent, id, h.clock.now)).toBe("pending");
    expect(approvalStatusForAgent(h.t.db, other, id, h.clock.now)).toBeNull();
    expect(approvalStatusForAgent(h.t.db, h.agent, "apr_nope", h.clock.now)).toBeNull();
    expect(h.decide(id, "approve")).toMatchObject({ ok: true, status: "approved" });
    // Reading the status many times runs nothing.
    for (let i = 0; i < 3; i++) {
      expect(approvalStatusForAgent(h.t.db, h.agent, id, h.clock.now)).toBe("approved");
    }
    expect(h.provider.executed).toEqual([]);
  });
});

describe("TTLs", () => {
  it("I-55: a pending request expires 24 h after it was created", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    const id = pendingId(await h.call({ args: SEND }));

    h.clock.advance(DAY - MINUTE);
    expect(await h.call({ args: SEND })).toMatchObject({ status: "pending", approvalId: id });

    h.clock.advance(MINUTE);
    expect(approvalStatusForAgent(h.t.db, h.agent, id, h.clock.now)).toBe("expired");
    expect(await h.call({ args: SEND })).toEqual({ status: "expired", approvalId: id });
    expect(h.status(id)).toBe("expired");
    // It can't be approved after its TTL.
    expect(h.decide(id, "approve")).toEqual({ ok: false, reason: "not_pending" });

    // The next identical call starts a new request.
    const next = pendingId(await h.call({ args: SEND }));
    expect(next).not.toBe(id);
    expect(h.provider.executed).toEqual([]);
  });

  it("I-55: an approval the agent doesn't use expires 1 h after the decision", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    const id = pendingId(await h.call({ args: SEND }));
    h.clock.advance(5 * HOUR);
    expect(h.decide(id, "approve")).toMatchObject({ ok: true, status: "approved" });

    h.clock.advance(HOUR);

    expect(approvalStatusForAgent(h.t.db, h.agent, id, h.clock.now)).toBe("expired");
    expect(await h.call({ args: SEND })).toEqual({ status: "expired", approvalId: id });
    expect(h.provider.executed).toEqual([]);
    expect(h.audit().map((row) => row.kind)).toEqual(["ask", "approved", "expired"]);
  });

  it("I-55: TTLs are configurable", async () => {
    const h = approvalHarness({
      owner: ASK_SENDS,
      ttls: { pendingMs: 10 * MINUTE, approvedMs: MINUTE },
    });
    const id = pendingId(await h.call({ args: SEND }));

    h.clock.advance(10 * MINUTE);

    expect(await h.call({ args: SEND })).toEqual({ status: "expired", approvalId: id });
  });

  it("Q-A5: a denied call reads denied with the same id until the pending TTL ends, then asks anew", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    const asked = await h.call({ args: SEND });
    const id = pendingId(asked);
    h.clock.advance(2 * HOUR);
    expect(h.decide(id, "deny")).toMatchObject({ ok: true, status: "denied" });

    h.clock.advance(20 * HOUR);
    expect(await h.call({ args: SEND })).toEqual({
      status: "denied",
      reason: "approval_denied",
      rule: asked.status === "pending" ? asked.rule : null,
      approvalId: id,
    });
    expect(approvalStatusForAgent(h.t.db, h.agent, id, h.clock.now)).toBe("denied");

    h.clock.advance(2 * HOUR);
    const again = pendingId(await h.call({ args: SEND }));
    expect(again).not.toBe(id);
    // The denial still reads as denied on check-back; only re-sends start over.
    expect(approvalStatusForAgent(h.t.db, h.agent, id, h.clock.now)).toBe("denied");
    expect(h.notified).toEqual([id, again]);
    expect(h.provider.executed).toEqual([]);
  });
});

describe("the approval page's view of a request", () => {
  it("I-57: keeps the full canonical arguments, the rule and the agent", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    const recipients = Array.from({ length: 40 }, (_, i) => `person-${i}@vendor.example.com`);
    const id = pendingId(await h.call({ args: { ...SEND, recipients }, runId: "nightly-7" }));

    const record = getApproval(h.t.db, h.t.orgId, id, h.clock.now);

    expect(record).not.toBeNull();
    expect(record?.agentName).toBe("inbox-bot");
    expect(record?.row.runId).toBe("nightly-7");
    expect(record?.row.call.recipients).toEqual(recipients);
    expect(record?.row.call.args).toEqual({ ...SEND, recipients });
    expect(record?.row.rule).toMatchObject({ file: "rules/owner.yaml", line: 2 });
  });
});
