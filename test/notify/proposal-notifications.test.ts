import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createAdminHandler } from "../../src/admin/handlers.ts";
import { type ApprovalItem, type ProposalItem, withProposals } from "../../src/cli/tui.ts";
import { addAgent } from "../../src/gateway/agents.ts";
import type { ChannelSender, DeliveryTarget } from "../../src/notify/channels.ts";
import type { Notice } from "../../src/notify/message.ts";
import { Notifier } from "../../src/notify/notifier.ts";
import { findProposal, proposeRules, rejectProposal } from "../../src/proposals/rules.ts";
import { findRequest, rejectRequest, requestConnection } from "../../src/requests/connection.ts";
import { LOCAL_OWNER_NAME } from "../../src/store/install.ts";
import { savePushSubscription, setUserEmail } from "../../src/store/notifications.ts";
import { agents, type NotifyChannel, notificationDeliveries } from "../../src/store/schema.ts";
import { captureLogger } from "../helpers/log.ts";
import { testStore } from "../helpers/store.ts";

/**
 * Rule proposals reach their owner (roadmap 2.1): a notification on every
 * channel, and a line in `heel status` and `heel tui`. The outbox and the
 * proposal store are real; senders are fakes.
 */

const PUBLIC_URL = new URL("https://heel.example.com");
const PHONE = "https://push.example.com/send/phone-1";
const NOW = new Date("2026-11-19T12:00:00Z");

/** A rule object as an agent sends it; `then` is the rules file's own key. */
const ruleOf = (name: string) =>
  // biome-ignore lint/suspicious/noThenProperty: `then` is the rules file's key.
  ({ name, match: { action: "github.read" }, then: "allow" });

function fakeSender(channel: NotifyChannel) {
  const sent: { target: DeliveryTarget; notice: Notice }[] = [];
  const sender: ChannelSender = {
    channel,
    send: async (target, notice) => {
      sent.push({ target, notice });
      return { kind: "sent" };
    },
  };
  return { sender, sent };
}

function setUp() {
  const t = testStore();
  const { agentId } = addAgent(t.db, { orgId: t.orgId, ownerId: t.ownerId, name: "repo-bot" }, NOW);
  setUserEmail(t.db, t.orgId, LOCAL_OWNER_NAME, "owner@example.com");
  savePushSubscription(t.db, {
    orgId: t.orgId,
    userId: t.ownerId,
    endpoint: PHONE,
    p256dh: "p256dh-key",
    auth: "auth-secret",
    now: NOW,
  });
  const who = { orgId: t.orgId, ownerId: t.ownerId, agentId };
  const propose = (...names: string[]) => {
    const outcome = proposeRules(
      t.db,
      who,
      {
        rules: names.map((name) => ({ rule: ruleOf(name), why: "secret-looking why text" })),
        reason: "so I can review your repos",
      },
      NOW,
    );
    if (!outcome.ok) throw new Error(outcome.problems.join("; "));
    return outcome.proposalId;
  };
  const notifierWith = (senders: ChannelSender[]) =>
    new Notifier({
      db: t.db,
      orgId: t.orgId,
      log: captureLogger().logger,
      publicUrl: PUBLIC_URL,
      senders,
      now: () => NOW,
    });
  const deliveries = (proposalId: string) =>
    t.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.proposalId, proposalId))
      .all();
  return { t, propose, notifierWith, deliveries };
}

describe("rule proposal notifications", () => {
  it("reach the owner on every channel with how many rules, never the rules or the why", async () => {
    const { propose, notifierWith, deliveries } = setUp();
    const push = fakeSender("web_push");
    const email = fakeSender("email");
    const notifier = notifierWith([push.sender, email.sender]);

    const id = propose("read-repos", "read-issues");
    notifier.ruleProposed(id);
    await notifier.drain();

    expect(push.sent.map((s) => s.target.channel)).toEqual(["web_push"]);
    expect(email.sent.map((s) => s.notice)).toEqual([
      {
        kind: "proposal",
        agent: "repo-bot",
        rules: 2,
        hide: 0,
        workdirs: 0,
        url: `https://heel.example.com/proposals/${id}`,
      },
    ]);
    expect(JSON.stringify([push.sent, email.sent])).not.toMatch(/secret-looking|review your/);
    expect(deliveries(id).map((d) => [d.status, d.approvalId])).toEqual([
      ["sent", null],
      ["sent", null],
    ]);

    // Queuing the same proposal again adds nothing.
    notifier.ruleProposed(id);
    await notifier.drain();
    expect(deliveries(id)).toHaveLength(2);
  });

  it("stop once the proposal is decided or replaced", async () => {
    const { t, propose, notifierWith, deliveries } = setUp();
    const email = fakeSender("email");
    const notifier = notifierWith([email.sender]);

    // Replaced by the agent's next proposal before the first send.
    const first = propose("read-repos");
    const second = propose("read-repos", "read-issues");
    notifier.ruleProposed(first);
    await notifier.drain();
    expect(email.sent).toHaveLength(0);
    expect(deliveries(first).map((d) => [d.status, d.lastError])).toEqual([
      ["dropped", "request_settled"],
    ]);

    // Rejected before the send.
    const row = findProposal(t.db, t.orgId, second);
    if (row === null) throw new Error("the proposal is stored");
    rejectProposal(t.db, row, t.ownerId, NOW);
    notifier.ruleProposed(second);
    await notifier.drain();
    expect(email.sent).toHaveLength(0);
  });
});

describe("pending proposals in heel status and heel tui", () => {
  it("are listed through the admin socket with a link to their page", async () => {
    const { t, propose } = setUp();
    const id = propose("read-repos");
    const handle = createAdminHandler({
      db: t.db,
      orgId: t.orgId,
      vault: null,
      version: "test",
      publicUrl: PUBLIC_URL,
      now: () => NOW,
    });

    expect(await handle({ method: "proposals.list" })).toEqual({
      ok: true,
      result: [
        {
          id,
          agent: "repo-bot",
          owner: LOCAL_OWNER_NAME,
          rules: 1,
          hide: 0,
          workdirs: 0,
          summary: "repo-bot proposes a new rule for owner's rules",
          reason: "so I can review your repos",
          createdAt: NOW.toISOString(),
          expiresAt: expect.any(String),
          url: `https://heel.example.com/proposals/${id}`,
        },
      ],
    });
  });

  it("join the TUI's Requests list as waiting items, newest first", () => {
    const approval: ApprovalItem = {
      id: "apr_1",
      agent: "inbox-bot",
      account: "gmail-work",
      status: "pending",
      summary: "inbox-bot wants to send an email",
      reason: null,
      createdAt: "2026-11-19T11:00:00.000Z",
      expiresAt: "2026-11-20T11:00:00.000Z",
      url: "https://heel.example.com/approvals/apr_1",
    };
    const proposal: ProposalItem = {
      id: "rpr_1",
      agent: "repo-bot",
      owner: "avi",
      rules: 2,
      summary: "repo-bot proposes 2 new rules for avi's rules",
      reason: null,
      createdAt: "2026-11-19T12:00:00.000Z",
      expiresAt: "2026-11-26T12:00:00.000Z",
      url: "https://heel.example.com/proposals/rpr_1",
    };

    expect(withProposals([approval], [proposal]).map((i) => [i.id, i.status, i.account])).toEqual([
      ["rpr_1", "pending", "avi's rules"],
      ["apr_1", "pending", "gmail-work"],
    ]);
  });
});

describe("connection request notifications", () => {
  it("reach the agent's owner, and stop once the request is decided", async () => {
    const { t, notifierWith } = setUp();
    const agent = t.db.select().from(agents).get();
    if (agent === undefined) throw new Error("the agent exists");
    const asked = requestConnection(
      t.db,
      { orgId: t.orgId, ownerId: t.ownerId, agentId: agent.id },
      { service: "gmail", alias: "inbox-new", why: "secret-looking why text" },
      NOW,
    );
    if (!asked.ok) throw new Error(asked.problem);
    const email = fakeSender("email");
    const notifier = notifierWith([email.sender]);
    notifier.agentRequested(asked.requestId);
    await notifier.drain();
    expect(email.sent.map((s) => s.notice)).toEqual([
      {
        kind: "connection",
        agent: "repo-bot",
        service: "Gmail",
        url: `https://heel.example.com/requests/${asked.requestId}`,
      },
    ]);
    expect(JSON.stringify(email.sent)).not.toMatch(/secret-looking|inbox-new/);

    // A second request, rejected before its notice goes out, sends nothing.
    const second = requestConnection(
      t.db,
      { orgId: t.orgId, ownerId: t.ownerId, agentId: agent.id },
      { service: "outlook", alias: "outlook-new" },
      NOW,
    );
    if (!second.ok) throw new Error(second.problem);
    const row = findRequest(t.db, t.orgId, second.requestId);
    if (row === null) throw new Error("stored");
    rejectRequest(t.db, row, t.ownerId, NOW);
    notifier.agentRequested(second.requestId);
    await notifier.drain();
    expect(email.sent).toHaveLength(1);
  });
});
