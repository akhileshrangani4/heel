import { describe, expect, it } from "vitest";
import { standingApprovals } from "../../src/store/schema.ts";
import { pendingId, SEND } from "../helpers/approvals.ts";
import {
  type Browser,
  type HumanPlaneHarness,
  humanPlaneHarness,
  issued,
} from "../helpers/human-plane.ts";
import { oneRule } from "../helpers/pipeline.ts";

/**
 * The approval page end to end over HTTP: a request appears for its
 * approver, and a decision needs a passkey assertion whose challenge names
 * exactly that decision (spec: The approval page, I-56).
 */

const ASK_SENDS = oneRule("{ action: email.send }", "ask");

async function setUp(): Promise<{
  h: HumanPlaneHarness;
  owner: Browser;
  approvalId: string;
  callHash: string;
}> {
  const h = humanPlaneHarness({ owner: ASK_SENDS });
  const owner = await h.signIn(await h.enroll());
  const approvalId = pendingId(await h.call({ args: SEND }));
  const callHash = h.audit().find((row) => row.approvalId === approvalId)?.callHash ?? "";
  return { h, owner, approvalId, callHash };
}

function decide(
  h: HumanPlaneHarness,
  as: Browser,
  approvalId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return h.ceremony(
    as,
    { url: `/approvals/${approvalId}/challenge`, body },
    `/approvals/${approvalId}/decide`,
  );
}

describe("the approval page", () => {
  it("lists a pending request for its approver and shows it in full", async () => {
    const { h, owner, approvalId } = await setUp();

    const list = await (await h.fetch("/approvals", { as: owner })).text();
    expect(list).toContain(`/approvals/${approvalId}`);

    const detail = await h.fetch(`/approvals/${approvalId}`, { as: owner });
    expect(detail.status).toBe(200);
    const page = await detail.text();
    expect(page).toContain("bob@vendor.com");
    expect(page).toContain("Approve once");
  });

  it("sends a signed-out browser to sign in, and back afterwards", async () => {
    const { h } = await setUp();

    const response = await h.fetch("/approvals");

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/sign-in?next=%2Fapprovals");
  });

  it("I-53: approve once with a passkey; the agent's identical re-send then runs once", async () => {
    const { h, owner, approvalId, callHash } = await setUp();

    const done = await decide(h, owner, approvalId, { callHash, intent: "approve" });

    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ ok: true, next: `/approvals/${approvalId}` });
    expect(h.status(approvalId)).toBe("approved");
    expect(h.provider.executed).toHaveLength(0);
    expect(await h.call({ args: SEND })).toMatchObject({
      status: "allowed",
      via: { kind: "approval" },
    });
  });

  it("denies with a passkey", async () => {
    const { h, owner, approvalId, callHash } = await setUp();

    await decide(h, owner, approvalId, { callHash, intent: "deny" });

    expect(h.status(approvalId)).toBe("denied");
    expect(await h.call({ args: SEND })).toMatchObject({
      status: "denied",
      reason: "approval_denied",
    });
  });

  it("approves as standing when the signed challenge says so", async () => {
    const { h, owner, approvalId, callHash } = await setUp();

    await decide(h, owner, approvalId, {
      callHash,
      intent: "approve",
      standing: { scope: "rule", duration: "7d" },
    });

    expect(h.t.db.select().from(standingApprovals).all()).toMatchObject([
      { scope: "rule", approvalId },
    ]);
  });

  it("I-56: the decision comes from the signed challenge, not from what is posted with it", async () => {
    const { h, owner, approvalId, callHash } = await setUp();
    // Sign an "approve once" challenge...
    const response = await h.fetch(`/approvals/${approvalId}/challenge`, {
      as: owner,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callHash, intent: "approve" }),
    });
    const { challengeId, options } = await issued(response);
    // ...then post it with a standing choice slipped in beside it.
    const done = await h.fetch(`/approvals/${approvalId}/decide`, {
      as: owner,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        challengeId,
        response: owner.authenticator.assert(options, "https://heel.example.com"),
        intent: "approve",
        standing: { scope: "rule", duration: "30d" },
      }),
    });

    expect(done.status).toBe(200);
    expect(h.status(approvalId)).toBe("approved");
    expect(h.t.db.select().from(standingApprovals).all()).toEqual([]);
  });

  it("I-56: an assertion for one request can't decide another", async () => {
    const { h, owner, approvalId, callHash } = await setUp();
    const other = pendingId(await h.call({ args: { ...SEND, subject: "another" } }));
    const response = await h.fetch(`/approvals/${approvalId}/challenge`, {
      as: owner,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callHash, intent: "approve" }),
    });
    const { challengeId, options } = await issued(response);

    const done = await h.fetch(`/approvals/${other}/decide`, {
      as: owner,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        challengeId,
        response: owner.authenticator.assert(options, "https://heel.example.com"),
      }),
    });

    expect(done.status).toBe(400);
    expect(h.status(approvalId)).toBe("pending");
    expect(h.status(other)).toBe("pending");
  });

  it("refuses a decision made against a stale call hash", async () => {
    const { h, owner, approvalId } = await setUp();

    const done = await decide(h, owner, approvalId, {
      callHash: "f".repeat(64),
      intent: "approve",
    });

    expect(done.status).toBe(409);
    expect(await done.json()).toMatchObject({
      ok: false,
      message: expect.stringMatching(/changed/),
    });
    expect(h.status(approvalId)).toBe("pending");
  });

  it("refuses a decision without the page's CSRF token", async () => {
    const { h, owner, approvalId, callHash } = await setUp();

    const response = await h.fetch(`/approvals/${approvalId}/challenge`, {
      as: owner,
      csrf: false,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callHash, intent: "approve" }),
    });

    expect(response.status).toBe(403);
  });

  it("refuses any post from another origin", async () => {
    const { h, owner, approvalId, callHash } = await setUp();

    const response = await h.fetch(`/approvals/${approvalId}/challenge`, {
      as: owner,
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ callHash, intent: "approve" }),
    });

    expect(response.status).toBe(403);
  });

  it("remembers which sections a person keeps open, per kind of request", async () => {
    const { h, owner, approvalId } = await setUp();
    const page = async () => (await h.fetch(`/approvals/${approvalId}`, { as: owner })).text();
    expect(await page()).toMatch(/data-heel-fold="args"(?! open)/);

    const saved = await h.fetch("/approvals/folds", {
      as: owner,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "email.send", section: "args", open: true }),
    });
    expect(saved.status).toBe(200);
    expect(await page()).toMatch(/data-heel-fold="args" open/);

    // Another kind of request keeps its own state.
    await h.fetch("/approvals/folds", {
      as: owner,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "github.merge", section: "args", open: false }),
    });
    expect(await page()).toMatch(/data-heel-fold="args" open/);
  });

  it("refuses a fold without the CSRF token, or with names heel doesn't show", async () => {
    const { h, owner } = await setUp();
    const post = (body: unknown, csrf = true) =>
      h.fetch("/approvals/folds", {
        as: owner,
        csrf,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    expect((await post({ kind: "email.send", section: "args", open: true }, false)).status).toBe(
      403,
    );
    expect((await post({ kind: "email.send", section: "<b>", open: true })).status).toBe(400);
    expect((await post({ kind: "email.send", section: "args", open: "yes" })).status).toBe(400);
    expect((await h.fetch("/approvals/folds", { method: "POST" })).status).toBe(401);
  });

  it("shows a request only to people who may decide it", async () => {
    const { h, approvalId } = await setUp();
    h.addUser("sam", "member");
    const sam = await h.signIn(await h.enroll("sam"));

    expect((await h.fetch(`/approvals/${approvalId}`, { as: sam })).status).toBe(404);
    expect(await (await h.fetch("/approvals", { as: sam })).text()).not.toContain(approvalId);
  });

  it("I-61: approving while paused is refused, and denying still works", async () => {
    const { h, owner, approvalId, callHash } = await setUp();
    h.pause({ scope: "global", target: "" });

    const approve = await decide(h, owner, approvalId, { callHash, intent: "approve" });
    expect(approve.status).toBe(409);
    expect(h.status(approvalId)).toBe("pending");

    await decide(h, owner, approvalId, { callHash, intent: "deny" });
    expect(h.status(approvalId)).toBe("denied");
  });
});
