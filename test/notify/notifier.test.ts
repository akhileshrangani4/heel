import { describe, expect, it } from "vitest";
import { createAdminHandler } from "../../src/admin/handlers.ts";
import type { ChannelSender, DeliveryTarget, SendOutcome } from "../../src/notify/channels.ts";
import type { ApprovalNotice } from "../../src/notify/message.ts";
import { RETRY_DELAYS_MS } from "../../src/notify/message.ts";
import { Notifier } from "../../src/notify/notifier.ts";
import { LOCAL_OWNER_NAME } from "../../src/store/install.ts";
import {
  deliveriesFor,
  findPushSubscription,
  savePushSubscription,
  setUserEmail,
} from "../../src/store/notifications.ts";
import type { NotifyChannel } from "../../src/store/schema.ts";
import { type ApprovalHarness, approvalHarness, pendingId, SEND } from "../helpers/approvals.ts";
import { captureLogger } from "../helpers/log.ts";
import { oneRule } from "../helpers/pipeline.ts";

/**
 * Approval notifications (spec: Notifications, D4d): who gets one, what it
 * says, and what happens when a channel fails. Senders are fakes; the
 * outbox, approvals and subscriptions are the real SQLite stores.
 */

const PUBLIC_URL = new URL("https://heel.example.com");
const ASK_SENDS = oneRule("{ action: email.send }", "ask");
const PHONE = "https://push.example.com/send/phone-1";
const FIRST_RETRY_MS = RETRY_DELAYS_MS[0] ?? 0;

/** A sender that records what it was asked to send and answers with `outcome`. */
function fakeSender(
  channel: NotifyChannel,
  outcome: () => SendOutcome = () => ({ kind: "sent" }),
): ChannelSender & { sent: { target: DeliveryTarget; notice: ApprovalNotice }[] } {
  const sent: { target: DeliveryTarget; notice: ApprovalNotice }[] = [];
  return {
    channel,
    sent,
    send: async (target, notice) => {
      sent.push({ target, notice });
      return outcome();
    },
  };
}

function notifierFor(h: ApprovalHarness, senders: ChannelSender[]): Notifier {
  return new Notifier({
    db: h.t.db,
    orgId: h.t.orgId,
    log: captureLogger().logger,
    publicUrl: PUBLIC_URL,
    senders,
    now: () => h.clock.now,
  });
}

/** The owner with an email and one phone subscribed, and a pending send waiting on them. */
async function ownerWithRequest(): Promise<{ h: ApprovalHarness; approvalId: string }> {
  const h = approvalHarness({ owner: ASK_SENDS });
  setUserEmail(h.t.db, h.t.orgId, LOCAL_OWNER_NAME, "owner@example.com");
  savePushSubscription(h.t.db, {
    orgId: h.t.orgId,
    userId: h.t.ownerId,
    endpoint: PHONE,
    p256dh: "p256dh-key",
    auth: "auth-secret",
    now: h.clock.now,
  });
  const approvalId = pendingId(await h.call({ args: SEND }));
  return { h, approvalId };
}

describe("approval notifications", () => {
  it("reach the account's owner on every configured channel, once each", async () => {
    const { h, approvalId } = await ownerWithRequest();
    const push = fakeSender("web_push");
    const email = fakeSender("email");
    const slack = fakeSender("slack");
    const notifier = notifierFor(h, [push, email, slack]);

    notifier.approvalRequested(approvalId);
    await notifier.drain();

    expect(push.sent.map((s) => s.target)).toEqual([
      {
        channel: "web_push",
        subscription: { endpoint: PHONE, keys: { p256dh: "p256dh-key", auth: "auth-secret" } },
      },
    ]);
    expect(email.sent.map((s) => s.target)).toEqual([
      { channel: "email", email: "owner@example.com" },
    ]);
    expect(slack.sent.map((s) => s.target)).toEqual([
      { channel: "slack", email: "owner@example.com" },
    ]);
    expect(deliveriesFor(h.t.db, approvalId).map((d) => d.status)).toEqual([
      "sent",
      "sent",
      "sent",
    ]);

    // Queuing the same request again adds nothing (I-51 already keeps the pipeline from asking).
    notifier.approvalRequested(approvalId);
    await notifier.drain();
    expect(deliveriesFor(h.t.db, approvalId)).toHaveLength(3);
    expect(push.sent).toHaveLength(1);
  });

  it("I-56: say who, what and where, and link to the page, never the call's contents", async () => {
    const { h, approvalId } = await ownerWithRequest();
    const email = fakeSender("email");
    const notifier = notifierFor(h, [email]);

    notifier.approvalRequested(approvalId);
    await notifier.drain();

    const notice = email.sent[0]?.notice;
    expect(notice).toEqual({
      agent: "inbox-bot",
      what: "email.send",
      account: "gmail-work",
      url: `https://heel.example.com/approvals/${approvalId}`,
    });
    // The arguments (the recipient, the subject) appear nowhere in what was sent.
    // (The approval id is random and can itself contain "Q3", so it's taken out first.)
    expect(JSON.stringify(email.sent).replaceAll(approvalId, "")).not.toMatch(/bob@vendor\.com|Q3/);
  });

  it("send an org ask to the admins, not to the account's owner", async () => {
    const h = approvalHarness({ org: oneRule("{ action: email.send }", "ask"), owner: ASK_SENDS });
    const admin = h.addUser("ada", "admin");
    setUserEmail(h.t.db, h.t.orgId, "ada", "ada@example.com");
    setUserEmail(h.t.db, h.t.orgId, LOCAL_OWNER_NAME, "owner@example.com");
    const approvalId = pendingId(await h.call({ args: SEND }));
    const email = fakeSender("email");
    const notifier = notifierFor(h, [email]);

    notifier.approvalRequested(approvalId);
    await notifier.drain();

    // The local owner is an admin too, so both admins hear about it.
    expect(email.sent.map((s) => s.target).sort()).toEqual(
      [
        { channel: "email", email: "ada@example.com" },
        { channel: "email", email: "owner@example.com" },
      ].sort(),
    );
    expect(admin.role).toBe("admin");
  });

  it("retry a failing channel with backoff, then give up; the request stays pending", async () => {
    const { h, approvalId } = await ownerWithRequest();
    const email = fakeSender("email", () => ({ kind: "retry", reason: "responseCode 451" }));
    const notifier = notifierFor(h, [email]);

    notifier.approvalRequested(approvalId);
    await notifier.drain();
    expect(deliveriesFor(h.t.db, approvalId)[0]).toMatchObject({
      status: "pending",
      attempts: 1,
      lastError: "responseCode 451",
    });

    // Nothing is due until the first delay passes.
    h.clock.advance(FIRST_RETRY_MS - 1);
    await notifier.drain();
    expect(email.sent).toHaveLength(1);

    for (const delay of RETRY_DELAYS_MS) {
      h.clock.advance(delay);
      await notifier.drain();
    }
    expect(email.sent).toHaveLength(RETRY_DELAYS_MS.length + 1);
    expect(deliveriesFor(h.t.db, approvalId)[0]).toMatchObject({
      status: "failed",
      attempts: RETRY_DELAYS_MS.length + 1,
    });
    expect(h.status(approvalId)).toBe("pending");
  });

  it("stop sending once the request is decided", async () => {
    const { h, approvalId } = await ownerWithRequest();
    const email = fakeSender("email", () => ({ kind: "retry", reason: "timeout" }));
    const notifier = notifierFor(h, [email]);
    notifier.approvalRequested(approvalId);
    await notifier.drain();

    h.decide(approvalId, "deny");
    h.clock.advance(FIRST_RETRY_MS);
    await notifier.drain();

    expect(email.sent).toHaveLength(1);
    expect(deliveriesFor(h.t.db, approvalId)[0]).toMatchObject({
      status: "dropped",
      lastError: "request_settled",
    });
  });

  it("forget a push subscription the push service says is gone", async () => {
    const { h, approvalId } = await ownerWithRequest();
    const push = fakeSender("web_push", () => ({ kind: "gone", reason: "statusCode 410" }));
    const notifier = notifierFor(h, [push]);

    notifier.approvalRequested(approvalId);
    await notifier.drain();

    expect(findPushSubscription(h.t.db, PHONE)).toBeNull();
    expect(deliveriesFor(h.t.db, approvalId)[0]).toMatchObject({
      status: "dropped",
      lastError: "statusCode 410",
    });
  });

  it("queue nothing for a channel heel isn't configured for, or a person with no address", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    const approvalId = pendingId(await h.call({ args: SEND }));
    const notifier = notifierFor(h, [fakeSender("email"), fakeSender("web_push")]);

    notifier.approvalRequested(approvalId);
    await notifier.drain();

    // No email set and no device subscribed: the request waits on the page alone.
    expect(deliveriesFor(h.t.db, approvalId)).toEqual([]);
  });

  it("are wired to the pipeline's new requests, and a repeat notifies no one again (I-51)", async () => {
    const { h } = await ownerWithRequest();
    const email = fakeSender("email");
    const notifier = notifierFor(h, [email]);
    for (const id of h.notified) notifier.approvalRequested(id);
    await h.call({ args: SEND });
    await notifier.drain();

    // The harness records each onApprovalRequested call: one, for the first ask.
    expect(h.notified).toHaveLength(1);
    expect(email.sent).toHaveLength(1);
  });
});

describe("heel user email", () => {
  it("sets and clears where a person's notifications go", async () => {
    const h = approvalHarness();
    const handle = createAdminHandler({
      db: h.t.db,
      orgId: h.t.orgId,
      vault: null,
      version: "test",
      publicUrl: PUBLIC_URL,
      now: () => h.clock.now,
    });

    expect(
      await handle({
        method: "user.email",
        params: { name: LOCAL_OWNER_NAME, email: "o@example.com" },
      }),
    ).toMatchObject({ ok: true, result: { email: "o@example.com" } });
    expect(
      await handle({ method: "user.email", params: { name: "nobody", email: "x@example.com" } }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(
      await handle({ method: "user.email", params: { name: LOCAL_OWNER_NAME, email: null } }),
    ).toMatchObject({ ok: true, result: { email: null } });
  });
});
