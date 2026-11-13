import { describe, expect, it } from "vitest";
import { approvalHarness, pendingId, SEND } from "../helpers/approvals.ts";
import { oneRule } from "../helpers/pipeline.ts";

const ASK_SENDS = oneRule("{ action: email.send }", "ask");

describe("approving and re-sending", () => {
  it("I-53: approving runs nothing; only the agent's identical re-send executes", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    const id = pendingId(await h.call({ args: SEND }));

    expect(h.decide(id, "approve")).toMatchObject({ ok: true, status: "approved" });

    expect(h.provider.executed).toEqual([]);
    expect(h.counts()).toEqual([]);
    expect(h.status(id)).toBe("approved");

    const rerun = await h.call({ args: SEND });
    expect(rerun).toMatchObject({ status: "allowed", via: { kind: "approval", approvalId: id } });
    expect(h.provider.executed).toHaveLength(1);
  });

  it("I-53: a different call doesn't use the approval", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    const id = pendingId(await h.call({ args: SEND }));
    h.decide(id, "approve");

    const other = await h.call({ args: { ...SEND, subject: "Q4" } });

    expect(pendingId(other)).not.toBe(id);
    expect(h.status(id)).toBe("approved");
    expect(h.provider.executed).toEqual([]);
  });

  it("I-54: an approved call executes once; the next identical call is a new call", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    const id = pendingId(await h.call({ args: SEND }));
    h.decide(id, "approve");

    const rerun = await h.call({ args: SEND });
    const after = await h.call({ args: SEND });

    expect(rerun.status).toBe("allowed");
    expect(h.status(id)).toBe("executed");
    expect(pendingId(after)).not.toBe(id);
    expect(h.provider.executed).toHaveLength(1);
    expect(h.counts()).toHaveLength(1);
    expect(h.audit().map((row) => row.kind)).toEqual(["ask", "approved", "executed", "ask"]);
  });

  it("I-54: concurrent re-sends of one approved call execute it exactly once", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    const id = pendingId(await h.call({ args: SEND }));
    h.decide(id, "approve");

    const results = await Promise.all(Array.from({ length: 8 }, () => h.call({ args: SEND })));

    const allowed = results.filter((r) => r.status === "allowed");
    expect(allowed).toHaveLength(1);
    expect(results.filter((r) => r.status === "pending")).toHaveLength(7);
    expect(h.provider.executed).toHaveLength(1);
    // The approval is consumed in the same transaction as the count reservation.
    expect(h.counts()).toHaveLength(1);
    expect(h.status(id)).toBe("executed");
  });

  it("I-54: the approval stays consumed when the upstream fails", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    const id = pendingId(await h.call({ args: SEND }));
    h.decide(id, "approve");
    h.provider.upstream = { kind: "error", status: 500, body: { error: "boom" } };

    expect(await h.call({ args: SEND })).toMatchObject({ status: "upstream_error" });
    expect(h.status(id)).toBe("executed");
    expect(h.counts()).toHaveLength(1);

    h.provider.upstream = { kind: "ok" };
    expect((await h.call({ args: SEND })).status).toBe("pending");
    expect(h.provider.executed).toHaveLength(1);
  });

  it("re-checks the rules: a deny added above the asking rule wins, and the approval waits", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    const id = pendingId(await h.call({ args: SEND }));
    h.decide(id, "approve");
    h.setRules({
      owner: `rules:
  - match: { recipients: { any_domain_in: [vendor.com] } }
    then: deny
  - match: { action: email.send }
    then: ask
`,
    });

    expect(await h.call({ args: SEND })).toMatchObject({ status: "denied", reason: "rule" });
    expect(h.status(id)).toBe("approved");
    expect(h.provider.executed).toEqual([]);
  });

  it("re-checks counts: items are reserved only when the approved call executes", async () => {
    const h = approvalHarness({
      owner: `rules:
  - match: { action: email.remove, items: { over: 2, per: hour } }
    then: ask
  - match: { action: email.remove }
    then: allow
`,
    });
    const remove = { action: "email.remove", ids: ["m1", "m2", "m3"] };
    const id = pendingId(await h.call({ args: remove }));
    expect(h.counts()).toEqual([]);
    h.decide(id, "approve");

    expect(await h.call({ args: remove })).toMatchObject({ status: "allowed" });
    expect(h.counts().map((row) => row.items)).toEqual([3]);
  });
});

describe("who may decide", () => {
  it("I-56: a decision must name the call hash of the request it decides", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    const id = pendingId(await h.call({ args: SEND }));
    const other = pendingId(await h.call({ args: { ...SEND, subject: "Q4" } }));
    const otherHash = h.audit().find((row) => row.approvalId === other)?.callHash;

    expect(h.decide(id, "approve", { callHash: otherHash ?? "" })).toEqual({
      ok: false,
      reason: "hash_mismatch",
    });
    expect(h.status(id)).toBe("pending");
  });

  it("only the account's owner approves an owner ask; another member can't", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    const id = pendingId(await h.call({ args: SEND }));
    const member = h.addUser("mallory", "member");
    const admin = h.addUser("ada", "admin");

    expect(h.decide(id, "approve", { by: member })).toEqual({
      ok: false,
      reason: "not_approver",
    });
    // An admin who isn't the account's approver can't approve it either.
    expect(h.decide(id, "approve", { by: admin })).toEqual({
      ok: false,
      reason: "not_approver",
    });
    expect(h.status(id)).toBe("pending");
  });

  it("an org ask goes to admins and can be approved once by one", async () => {
    const h = approvalHarness({ org: ASK_SENDS, owner: oneRule("{}", "allow") });
    const id = pendingId(await h.call({ args: SEND }));
    const admin = h.addUser("ada", "admin");
    const member = h.addUser("mallory", "member");

    expect(h.decide(id, "approve", { by: member })).toEqual({
      ok: false,
      reason: "not_approver",
    });
    expect(h.decide(id, "approve", { by: admin })).toMatchObject({ ok: true });
    expect(await h.call({ args: SEND })).toMatchObject({ status: "allowed" });
  });

  it("a decided request can't be decided again", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    const id = pendingId(await h.call({ args: SEND }));
    h.decide(id, "deny");

    expect(h.decide(id, "approve")).toEqual({ ok: false, reason: "not_pending" });
    expect(h.status(id)).toBe("denied");
  });
});
