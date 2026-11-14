import { describe, expect, it } from "vitest";
import type { PauseScope } from "../../src/core/call.ts";
import { pause, resume, SqlitePauseStore } from "../../src/store/pauses.ts";
import {
  type ApprovalHarness,
  approvalHarness,
  DAY,
  pendingId,
  SEND,
} from "../helpers/approvals.ts";
import { oneRule } from "../helpers/pipeline.ts";

const ALLOW_ALL = oneRule("{}", "allow");
const ASK_SENDS = oneRule("{ action: email.send }", "ask");

/** The pause key that covers the harness's default agent on `gmail-work`. */
function keyFor(h: ApprovalHarness, scope: PauseScope): { scope: PauseScope; target: string } {
  switch (scope) {
    case "global":
      return { scope, target: "" };
    case "owner":
      return { scope, target: h.agent.ownerId };
    case "agent":
      return { scope, target: h.agent.agentId };
    case "account":
      return { scope, target: "gmail-work" };
    case "provider":
      return { scope, target: "gmail" };
  }
}

const SCOPES: readonly PauseScope[] = ["global", "owner", "agent", "account", "provider"];

describe("pause", () => {
  it.each(SCOPES)("I-60: a %s pause returns paused and reaches no upstream", async (scope) => {
    const h = approvalHarness({ owner: ALLOW_ALL });
    h.pause(keyFor(h, scope));

    expect(await h.call({ args: SEND })).toEqual({ status: "paused", scope });
    expect(h.provider.executed).toEqual([]);
    expect(h.counts()).toEqual([]);
    expect(h.audit().map((row) => row.kind)).toEqual(["paused"]);
  });

  it("I-60: is checked before the rules, so a paused ask creates no request", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    h.pause(keyFor(h, "agent"));

    expect(await h.call({ args: SEND })).toEqual({ status: "paused", scope: "agent" });
    expect(h.notified).toEqual([]);
  });

  it("I-60: an already-approved call is paused on re-send and its approval isn't used", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    const id = pendingId(await h.call({ args: SEND }));
    expect(h.decide(id, "approve")).toMatchObject({ ok: true });
    h.pause(keyFor(h, "account"));

    expect(await h.call({ args: SEND })).toEqual({ status: "paused", scope: "account" });
    expect(h.status(id)).toBe("approved");
    expect(h.provider.executed).toEqual([]);

    h.resume(keyFor(h, "account"));
    expect(await h.call({ args: SEND })).toMatchObject({
      status: "allowed",
      via: { kind: "approval", approvalId: id },
    });
  });

  it("I-60: reports the broadest scope when several pauses cover a call", async () => {
    const h = approvalHarness({ owner: ALLOW_ALL });
    h.pause(keyFor(h, "account"));
    h.pause(keyFor(h, "owner"));

    expect(await h.call({ args: SEND })).toEqual({ status: "paused", scope: "owner" });
  });

  it("I-60: covers only its scope", async () => {
    const h = approvalHarness({ owner: ALLOW_ALL });
    const other = h.addAgent("ci-bot");
    h.pause(keyFor(h, "agent"));
    h.pause({ scope: "account", target: "gmail-personal" });

    expect((await h.call({ args: SEND })).status).toBe("paused");
    expect((await h.call({ agent: other, args: SEND })).status).toBe("allowed");
    expect((await h.call({ agent: other, account: "gmail-personal", args: SEND })).status).toBe(
      "paused",
    );
  });

  it("is idempotent and survives a restart of the store", async () => {
    const h = approvalHarness({ owner: ALLOW_ALL });
    const key = keyFor(h, "agent");

    expect(pause(h.t.db, h.t.orgId, key, h.t.ownerId, h.clock.now)).toEqual({ created: true });
    expect(pause(h.t.db, h.t.orgId, key, h.t.ownerId, h.clock.now)).toEqual({ created: false });

    const fresh = new SqlitePauseStore();
    expect(
      fresh.find(h.t.db, {
        orgId: h.t.orgId,
        agentId: h.agent.agentId,
        ownerId: h.agent.ownerId,
        account: "gmail-work",
        provider: "gmail",
      }),
    ).toBe("agent");

    expect(resume(h.t.db, h.t.orgId, key)).toEqual({ removed: true });
    expect(resume(h.t.db, h.t.orgId, key)).toEqual({ removed: false });
  });
});

describe("deciding while paused", () => {
  it.each(SCOPES)("I-61: approving a request in a paused %s scope is refused", async (scope) => {
    const h = approvalHarness({ owner: ASK_SENDS });
    const id = pendingId(await h.call({ args: SEND }));
    h.pause(keyFor(h, scope));

    expect(h.decide(id, "approve")).toEqual({ ok: false, reason: "paused", pauseScope: scope });
    expect(h.decide(id, "approve", { standing: { scope: "rule", duration: "1d" } })).toEqual({
      ok: false,
      reason: "paused",
      pauseScope: scope,
    });
    expect(h.status(id)).toBe("pending");
  });

  it("I-61: denying is still allowed while paused, since it can only stop a call", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    const id = pendingId(await h.call({ args: SEND }));
    h.pause(keyFor(h, "global"));

    expect(h.decide(id, "deny")).toMatchObject({ ok: true, status: "denied" });
  });

  it("I-61: a pause on another agent doesn't block the decision", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    const other = h.addAgent("ci-bot");
    const id = pendingId(await h.call({ args: SEND }));
    h.pause({ scope: "agent", target: other.agentId });

    expect(h.decide(id, "approve")).toMatchObject({ ok: true, status: "approved" });
  });
});

describe("resume", () => {
  it("I-63: pending requests become approvable again and nothing from the pause is replayed", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    const id = pendingId(await h.call({ args: SEND }));
    h.pause(keyFor(h, "agent"));
    // Calls made during the pause.
    await h.call({ args: SEND });
    await h.call({ args: { ...SEND, subject: "during pause" } });

    h.resume(keyFor(h, "agent"));

    expect(h.provider.executed).toEqual([]);
    expect(h.counts()).toEqual([]);
    expect(h.notified).toEqual([id]);
    expect(h.decide(id, "approve")).toMatchObject({ ok: true, status: "approved" });
    // Approving still runs nothing; only the agent's re-send does.
    expect(h.provider.executed).toEqual([]);
    expect(await h.call({ args: SEND })).toMatchObject({ status: "allowed" });
    expect(h.provider.executed).toHaveLength(1);
  });

  it("I-63: a request whose TTL passed during the pause stays expired", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    const id = pendingId(await h.call({ args: SEND }));
    h.pause(keyFor(h, "global"));
    h.clock.advance(DAY);

    h.resume(keyFor(h, "global"));

    expect(h.decide(id, "approve")).toEqual({ ok: false, reason: "not_pending" });
    expect(await h.call({ args: SEND })).toEqual({ status: "expired", approvalId: id });
  });
});
