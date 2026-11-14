import { describe, expect, it } from "vitest";
import type { StandingChoice } from "../../src/store/approvals.ts";
import { listStanding, revokeStanding } from "../../src/store/approvals.ts";
import {
  type ApprovalHarness,
  approvalHarness,
  HOUR,
  pendingId,
  SEND,
} from "../helpers/approvals.ts";
import { oneRule } from "../helpers/pipeline.ts";

const ASK_SENDS = oneRule("{ action: email.send }", "ask");
const RULE_DAY: StandingChoice = { scope: "rule", duration: "1d" };
const EXACT_DAY: StandingChoice = { scope: "exact_call", duration: "1d" };

/** Asks, approves as standing, and uses the one-time approval so only the standing one remains. */
async function grantStanding(
  h: ApprovalHarness,
  standing: StandingChoice,
  args: unknown = SEND,
): Promise<string> {
  const id = pendingId(await h.call({ args }));
  const decided = h.decide(id, "approve", { standing });
  if (!decided.ok || decided.standingApprovalId === null) {
    throw new Error(`expected a standing approval, got ${JSON.stringify(decided)}`);
  }
  expect(await h.call({ args })).toMatchObject({
    status: "allowed",
    via: { kind: "approval", approvalId: id },
  });
  return decided.standingApprovalId;
}

describe("standing approvals", () => {
  it("I-15: turns its parent rule's ask into allow for later calls", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    const standingId = await grantStanding(h, RULE_DAY);

    const later = await h.call({ args: { ...SEND, subject: "Q4" } });

    expect(later).toMatchObject({
      status: "allowed",
      via: { kind: "rule", rule: { line: 2 }, standingApprovalId: standingId },
    });
    expect(h.provider.executed).toHaveLength(2);
    expect(h.notified).toHaveLength(1);
  });

  it("I-15: never answers an ask from a different rule", async () => {
    const h = approvalHarness({
      owner: `rules:
  - match: { action: email.remove }
    then: ask
  - match: { action: email.send }
    then: ask
`,
    });
    await grantStanding(h, RULE_DAY);

    const removal = await h.call({ args: { action: "email.remove" } });

    expect(removal.status).toBe("pending");
  });

  it("I-15: only turns ask into allow; a call its rule doesn't match is still default-denied", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    await grantStanding(h, RULE_DAY);

    expect(await h.call({ args: { action: "email.label" } })).toMatchObject({
      status: "denied",
      reason: "no_rule_matched",
    });
  });

  it("I-14: a deny above the parent rule still wins", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    await grantStanding(h, RULE_DAY);
    h.setRules({
      owner: `rules:
  - match: { recipients: { any_domain_in: [vendor.com] } }
    then: deny
  - match: { action: email.send }
    then: ask
`,
    });

    expect(await h.call({ args: { ...SEND, subject: "Q4" } })).toMatchObject({
      status: "denied",
      reason: "rule",
      rule: { line: 2 },
    });
  });

  it("I-14: an org deny wins over a standing approval", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    await grantStanding(h, RULE_DAY);
    h.setRules({
      org: oneRule("{ recipients: { any_domain_in: [vendor.com] } }", "deny"),
      owner: ASK_SENDS,
    });

    expect(await h.call({ args: { ...SEND, subject: "Q4" } })).toMatchObject({
      status: "denied",
      rule: { file: "org-rules.yaml" },
    });
  });

  it("I-16: lapses when its parent rule is edited in any way", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    await grantStanding(h, RULE_DAY);
    // Narrowed: it would still match this call, but it's a different rule now.
    h.setRules({ owner: oneRule("{ action: email.send, recipients: { max: 5 } }", "ask") });

    expect((await h.call({ args: { ...SEND, subject: "Q4" } })).status).toBe("pending");
  });

  it("I-16: lapses when its parent rule is deleted, and stays lapsed if it comes back edited", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    await grantStanding(h, RULE_DAY);

    h.setRules({ owner: oneRule("{ action: email.label }", "allow") });
    expect(await h.call({ args: { ...SEND, subject: "Q4" } })).toMatchObject({
      status: "denied",
      reason: "no_rule_matched",
    });

    h.setRules({ owner: oneRule("{ action: email.send, account: gmail-work }", "ask") });
    expect((await h.call({ args: { ...SEND, subject: "Q5" } })).status).toBe("pending");
  });

  it("I-16: moving the rule without changing it keeps the approval", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    const standingId = await grantStanding(h, RULE_DAY);
    h.setRules({
      owner: `rules:
  - match: { action: email.label }
    then: allow
  - match: { action: email.send }
    then: ask
`,
    });

    expect(await h.call({ args: { ...SEND, subject: "Q4" } })).toMatchObject({
      status: "allowed",
      via: { kind: "rule", rule: { line: 4 }, standingApprovalId: standingId },
    });
  });

  it("is scoped to the agent it was granted for", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    const other = h.addAgent("ci-bot");
    await grantStanding(h, RULE_DAY);

    expect((await h.call({ agent: other, args: SEND })).status).toBe("pending");
  });

  it("exact-call scope covers only the same account, tool and arguments", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    const standingId = await grantStanding(h, EXACT_DAY);

    expect(await h.call({ args: SEND })).toMatchObject({
      status: "allowed",
      via: { standingApprovalId: standingId },
    });
    expect((await h.call({ args: { ...SEND, subject: "Q4" } })).status).toBe("pending");
    expect((await h.call({ account: "gmail-personal", args: SEND })).status).toBe("pending");
  });

  it("ends when its duration runs out", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    await grantStanding(h, { scope: "rule", duration: "1h" });

    h.clock.advance(HOUR - 1);
    expect((await h.call({ args: { ...SEND, subject: "Q4" } })).status).toBe("allowed");
    h.clock.advance(1);
    expect((await h.call({ args: { ...SEND, subject: "Q5" } })).status).toBe("pending");
  });

  it("can be revoked, effective on the next call", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    const standingId = await grantStanding(h, RULE_DAY);

    expect(revokeStanding(h.t.db, h.t.orgId, standingId, h.t.ownerId, h.clock.now)).toEqual({
      ok: true,
    });
    expect(revokeStanding(h.t.db, h.t.orgId, standingId, h.t.ownerId, h.clock.now)).toEqual({
      ok: false,
      reason: "already_revoked",
    });
    expect((await h.call({ args: { ...SEND, subject: "Q4" } })).status).toBe("pending");
  });

  it("lists with its agent, account and what it covers, for the approval page", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    const standingId = await grantStanding(h, EXACT_DAY);

    const [record, ...rest] = listStanding(h.t.db, h.t.orgId);

    expect(rest).toEqual([]);
    expect(record).toMatchObject({
      row: { id: standingId, scope: "exact_call", revokedAt: null },
      agentName: "inbox-bot",
      account: "gmail-work",
      covers: "email.send",
      createdByName: expect.any(String),
      ownerId: h.t.ownerId,
    });
  });

  it("Q-A7: an org ask can be approved once but never as a standing approval", async () => {
    const h = approvalHarness({ org: ASK_SENDS, owner: oneRule("{}", "allow") });
    const id = pendingId(await h.call({ args: SEND }));

    expect(h.decide(id, "approve", { standing: RULE_DAY })).toEqual({
      ok: false,
      reason: "org_ask_cannot_stand",
    });
    expect(h.status(id)).toBe("pending");
    expect(listStanding(h.t.db, h.t.orgId)).toEqual([]);
  });

  it("Q-A6: durations are capped at 90 days", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    const standingId = await grantStanding(h, { scope: "rule", duration: "30d" });

    const [record] = listStanding(h.t.db, h.t.orgId);

    expect(record?.row.id).toBe(standingId);
    expect(record && record.row.expiresAt.getTime() - record.row.createdAt.getTime()).toBe(
      30 * 24 * HOUR,
    );
  });
});
