import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Transporter } from "nodemailer";
import { describe, expect, it } from "vitest";
import type { sendNotification } from "web-push";
import {
  emailSender,
  type SlackApi,
  slackSender,
  webPushSender,
} from "../../src/notify/channels.ts";
import {
  type ApprovalNotice,
  approvalUrl,
  nextAttemptAfter,
  noticeText,
  proposalUrl,
  RETRY_DELAYS_MS,
  requestUrl,
} from "../../src/notify/message.ts";
import { loadOrCreateVapidKeys, notifySetup } from "../../src/notify/setup.ts";
import { tempDir } from "../helpers/store.ts";

/**
 * The three senders, each against a fake of the library it wraps, and the
 * setup that builds them from `heel.yaml`.
 */

const NOTICE: ApprovalNotice = {
  kind: "approval",
  agent: "inbox-bot",
  what: "email.send",
  account: "gmail-work",
  url: "https://heel.example.com/approvals/apr_1",
};

describe("the notice", () => {
  it("names the agent, the action and the account, and nothing else", () => {
    expect(noticeText(NOTICE)).toEqual({
      title: "inbox-bot is asking to email.send",
      body: "On gmail-work. Open heel to see the full call and decide.",
    });
    expect(approvalUrl(new URL("https://heel.example.com/"), "apr_1")).toBe(NOTICE.url);
  });

  it("names the agent and heel's word for the service in a connection request, not its alias or why", () => {
    const notice = {
      kind: "connection",
      agent: "inbox-bot",
      service: "Gmail",
      url: "https://heel.example.com/requests/req_1",
    } as const;
    expect(noticeText(notice)).toEqual({
      title: "inbox-bot wants to connect Gmail",
      body: "Open heel to decide.",
    });
    expect(requestUrl(new URL("https://heel.example.com/"), "req_1")).toBe(notice.url);
  });

  it("tells an owner how many rules an agent proposes, and nothing of the rules themselves", () => {
    const one = {
      kind: "proposal",
      agent: "inbox-bot",
      rules: 1,
      hide: 0,
      workdirs: 0,
      url: "u",
    } as const;
    expect(noticeText(one)).toEqual({
      title: "inbox-bot wants to add a new rule",
      body: "Open heel to decide.",
    });
    expect(noticeText({ ...one, rules: 3 }).title).toBe("inbox-bot wants to add 3 new rules");
    expect(noticeText({ ...one, rules: 0, workdirs: 1 }).title).toBe(
      "inbox-bot wants to add a workdir",
    );
    expect(proposalUrl(new URL("https://heel.example.com/"), "rpr_1")).toBe(
      "https://heel.example.com/proposals/rpr_1",
    );
  });

  it("retries on a fixed schedule, then gives up", () => {
    const now = new Date("2026-11-17T12:00:00Z");
    expect(nextAttemptAfter(1, now)).toEqual(new Date(now.getTime() + 30_000));
    expect(nextAttemptAfter(RETRY_DELAYS_MS.length, now)).not.toBeNull();
    expect(nextAttemptAfter(RETRY_DELAYS_MS.length + 1, now)).toBeNull();
  });
});

describe("web push", () => {
  const KEYS = { publicKey: "pub", privateKey: "priv" };
  const TARGET = {
    channel: "web_push" as const,
    subscription: { endpoint: "https://push.example.com/1", keys: { p256dh: "k", auth: "a" } },
  };

  it("sends the notice, signed with the install's VAPID keys, for a day at high urgency", async () => {
    const calls: Parameters<typeof sendNotification>[] = [];
    const sender = webPushSender({
      keys: KEYS,
      subject: "mailto:ops@example.com",
      send: async (...args) => {
        calls.push(args);
        return { statusCode: 201, body: "", headers: {} };
      },
    });

    expect(await sender.send(TARGET, NOTICE)).toEqual({ kind: "sent" });
    const [subscription, payload, options] = calls[0] ?? [];
    expect(subscription).toEqual(TARGET.subscription);
    expect(JSON.parse(payload ?? "")).toEqual({ ...noticeText(NOTICE), url: NOTICE.url });
    expect(options).toMatchObject({
      vapidDetails: { subject: "mailto:ops@example.com", publicKey: "pub", privateKey: "priv" },
      TTL: 86_400,
      urgency: "high",
    });
  });

  it.each([
    [410, "gone"],
    [404, "gone"],
    [429, "retry"],
    [503, "retry"],
  ])("reads a %i from the push service as %s", async (statusCode, kind) => {
    const sender = webPushSender({
      keys: KEYS,
      subject: "mailto:ops@example.com",
      send: async () => {
        throw Object.assign(new Error("push refused"), { statusCode });
      },
    });
    expect(await sender.send(TARGET, NOTICE)).toEqual({ kind, reason: `statusCode ${statusCode}` });
  });
});

describe("email", () => {
  it("sends a plain-text message with the link and no way to decide by reply", async () => {
    const mails: Record<string, unknown>[] = [];
    const transport = { sendMail: async (mail: Record<string, unknown>) => mails.push(mail) };
    const sender = emailSender({
      transport: transport as unknown as Transporter,
      from: "heel <heel@example.com>",
    });

    expect(await sender.send({ channel: "email", email: "owner@example.com" }, NOTICE)).toEqual({
      kind: "sent",
    });
    expect(mails[0]).toMatchObject({
      from: "heel <heel@example.com>",
      to: "owner@example.com",
      subject: "inbox-bot is asking to email.send",
    });
    expect(mails[0]?.["text"]).toContain(NOTICE.url);
    expect(mails[0]).not.toHaveProperty("html");
  });

  it("retries when the SMTP server refuses, keeping only its code", async () => {
    const transport = {
      sendMail: async () => {
        throw Object.assign(new Error("mailbox full for owner@example.com"), { responseCode: 452 });
      },
    };
    const sender = emailSender({ transport: transport as unknown as Transporter, from: "heel" });
    expect(await sender.send({ channel: "email", email: "owner@example.com" }, NOTICE)).toEqual({
      kind: "retry",
      reason: "responseCode 452",
    });
  });
});

describe("Slack", () => {
  function fakeSlack(found: string | null) {
    const posted: Record<string, unknown>[] = [];
    const client = {
      users: { lookupByEmail: async () => ({ ok: true, user: found ? { id: found } : undefined }) },
      chat: {
        postMessage: async (message: Record<string, unknown>) => {
          posted.push(message);
          return { ok: true };
        },
      },
    };
    return { client: client as unknown as SlackApi, posted };
  }

  it("DMs the person found by email, as text with a link and no buttons", async () => {
    const slack = fakeSlack("U123");
    const sender = slackSender({ client: slack.client });

    expect(await sender.send({ channel: "slack", email: "owner@example.com" }, NOTICE)).toEqual({
      kind: "sent",
    });
    expect(slack.posted[0]).toMatchObject({ channel: "U123", unfurl_links: false });
    expect(slack.posted[0]?.["text"]).toContain(`<${NOTICE.url}|Open heel>`);
    expect(slack.posted[0]).not.toHaveProperty("blocks");
  });

  it("stops when nobody in Slack has that email", async () => {
    const sender = slackSender({ client: fakeSlack(null).client });
    expect(await sender.send({ channel: "slack", email: "nobody@example.com" }, NOTICE)).toEqual({
      kind: "gone",
      reason: "users_not_found",
    });
  });
});

describe("setup", () => {
  it("creates the VAPID key pair once, readable only by heel, and keeps it", () => {
    const dir = tempDir();
    const file = join(dir, "vapid.json");
    const first = loadOrCreateVapidKeys(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadOrCreateVapidKeys(file)).toEqual(first);
  });

  it("turns on web push always, and email and Slack only when configured", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "secrets"));
    const keyFile = join(dir, "vapid.json");
    const base = {
      webPush: { keyFile, subject: "https://heel.example.com" },
      email: null,
      slack: null,
    };

    expect(notifySetup(base, {}).senders.map((s) => s.channel)).toEqual(["web_push"]);

    const full = notifySetup(
      {
        ...base,
        email: {
          host: "smtp.example.com",
          port: 587,
          tls: false,
          username: null,
          passwordFile: null,
          from: "heel <heel@example.com>",
        },
        slack: { tokenFile: join(dir, "secrets", "missing") },
      },
      { HEEL_SLACK_TOKEN: "xoxb-from-env" },
    );
    expect(full.senders.map((s) => s.channel)).toEqual(["web_push", "email", "slack"]);
    expect(full.vapidPublicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
  });
});
