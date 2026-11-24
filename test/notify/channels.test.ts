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
  action: "email.send",
  tool: "send_message",
  method: null,
  account: "gmail-work",
  reason: null,
  url: "https://heel.example.com/approvals/apr_1",
  tag: "approval:apr_1",
};

describe("the notice", () => {
  it("leads with the ask in plain words and the account, then who asked", () => {
    expect(noticeText(NOTICE)).toEqual({
      title: "Send an email from gmail-work?",
      body: "inbox-bot is asking.",
    });
    expect(approvalUrl(new URL("https://heel.example.com/"), "apr_1")).toBe(NOTICE.url);
    expect(noticeText({ ...NOTICE, action: "github.merge", account: "work-gh" }).title).toBe(
      "Merge a pull request on work-gh?",
    );
    // An action heel has no words for reads as its tool.
    expect(
      noticeText({ ...NOTICE, action: null, tool: "list_issues", account: "linear" }).title,
    ).toBe("Run list issues on linear?");
    // A call to an API heel only knows by its paths: the path is an argument, so only the method.
    expect(
      noticeText({ ...NOTICE, action: null, tool: "POST /v1/customers/cus_9", method: "POST" })
        .title,
    ).toBe("Make a POST request on gmail-work?");
  });

  it("carries the agent's own reason on one line, cut to fit", () => {
    expect(noticeText({ ...NOTICE, reason: "Reply to Dana about the Q3 numbers" }).body).toBe(
      "inbox-bot: Reply to Dana about the Q3 numbers",
    );
    // Line breaks and bidi controls can't make the agent's words read as something else.
    expect(noticeText({ ...NOTICE, reason: "  one\nline\u202e here " }).body).toBe(
      "inbox-bot: one line here",
    );
    expect(noticeText({ ...NOTICE, reason: " \n " }).body).toBe("inbox-bot is asking.");
    const long = noticeText({ ...NOTICE, reason: "x".repeat(500) }).body;
    expect(long).toBe(`inbox-bot: ${"x".repeat(199)}…`);
  });

  it("asks to connect heel's word for the service, with the agent's why, never the alias", () => {
    const notice = {
      kind: "connection",
      agent: "claude-code-heel",
      service: "Linear",
      reason: "Notification test only. Please reject this request.",
      url: "https://heel.example.com/requests/req_1",
      tag: "connection:agt_1:notify-test",
    } as const;
    expect(noticeText(notice)).toEqual({
      title: "Connect Linear?",
      body: "claude-code-heel: Notification test only. Please reject this request.",
    });
    expect(noticeText({ ...notice, reason: null }).body).toBe("claude-code-heel is asking.");
    expect(requestUrl(new URL("https://heel.example.com/"), "req_1")).toBe(notice.url);
  });

  it("asks to add how many rules an agent proposes, and nothing of the rules themselves", () => {
    const one = {
      kind: "proposal",
      agent: "inbox-bot",
      rules: 1,
      hide: 0,
      workdirs: 0,
      reason: "so I can review your repos",
      url: "u",
      tag: "proposal:agt_1",
    } as const;
    expect(noticeText(one)).toEqual({
      title: "Add a new rule?",
      body: "inbox-bot: so I can review your repos",
    });
    expect(noticeText({ ...one, rules: 3 }).title).toBe("Add 3 new rules?");
    expect(noticeText({ ...one, rules: 0, workdirs: 1 }).title).toBe("Add a workdir?");
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
    // The tag lets a retry replace the notification already shown instead of stacking a second.
    expect(JSON.parse(payload ?? "")).toEqual({
      title: "Send an email from gmail-work?",
      body: "inbox-bot is asking.",
      url: NOTICE.url,
      tag: "approval:apr_1",
    });
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
      subject: "Send an email from gmail-work?",
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

  it("escapes the agent's words, so they can't make a link or a mention", async () => {
    const slack = fakeSlack("U123");
    const sender = slackSender({ client: slack.client });
    const notice = { ...NOTICE, reason: "see <https://evil.example|Open heel> & <!channel>" };

    await sender.send({ channel: "slack", email: "owner@example.com" }, notice);
    expect(slack.posted[0]?.["text"]).toBe(
      "*Send an email from gmail-work?*\n" +
        "inbox-bot: see &lt;https://evil.example|Open heel&gt; &amp; &lt;!channel&gt; " +
        `<${NOTICE.url}|Open heel>`,
    );
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
