import type { WebClient } from "@slack/web-api";
import type { Transporter } from "nodemailer";
import type { PushSubscription, SendOptions, sendNotification, VapidKeys } from "web-push";
import type { NotifyChannel } from "../store/schema.ts";
import { type Notice, noticeText } from "./message.ts";

/**
 * The three ways a notification leaves heel (spec: Notifications). Each
 * sender turns a `Notice` into one message on its channel and
 * reports what happened, so the notifier can mark the delivery sent, retry
 * it, or stop trying.
 */

export type SendOutcome =
  | { kind: "sent" }
  /** The target no longer exists (an expired push subscription, an unknown Slack user). */
  | { kind: "gone"; reason: string }
  /** Worth trying again later. `reason` is a status or code, never message content. */
  | { kind: "retry"; reason: string };

/** Where one delivery goes. Push needs the subscription's keys; the others an address. */
export type DeliveryTarget =
  | { channel: "web_push"; subscription: PushSubscription }
  | { channel: "email" | "slack"; email: string };

export interface ChannelSender {
  readonly channel: NotifyChannel;
  send(target: DeliveryTarget, notice: Notice): Promise<SendOutcome>;
}

/** A short, content-free description of an error for the outbox's `last_error`. */
function reasonOf(error: unknown): string {
  if (typeof error !== "object" || error === null) return "error";
  const fields = error as Record<string, unknown>;
  for (const key of ["statusCode", "code", "responseCode"]) {
    const value = fields[key];
    if (typeof value === "number" || typeof value === "string") return `${key} ${value}`;
  }
  return error instanceof Error ? error.name : "error";
}

// ── web push ────────────────────────────────────────────────────────────────

/** Push services keep an undelivered message this long: a request lives 24 h. */
const PUSH_TTL_SECONDS = 24 * 60 * 60;

/**
 * Web push to an installed approval page (VAPID). The payload is the
 * notice's title, body, link and tag, which the service worker shows; push
 * services only see it encrypted.
 */
export function webPushSender(options: {
  keys: VapidKeys;
  subject: string;
  /** `web-push`'s `sendNotification`; tests pass a fake. */
  send: typeof sendNotification;
}): ChannelSender {
  const sendOptions: SendOptions = {
    vapidDetails: { subject: options.subject, ...options.keys },
    TTL: PUSH_TTL_SECONDS,
    urgency: "high",
    timeout: 10_000,
  };
  return {
    channel: "web_push",
    async send(target, notice) {
      if (target.channel !== "web_push") throw new Error("web push needs a subscription");
      const payload = JSON.stringify({ ...noticeText(notice), url: notice.url, tag: notice.tag });
      try {
        await options.send(target.subscription, payload, sendOptions);
        return { kind: "sent" };
      } catch (error) {
        const status = (error as { statusCode?: unknown }).statusCode;
        // 404 and 410 mean the browser dropped the subscription; it will never work again.
        if (status === 404 || status === 410)
          return { kind: "gone", reason: `statusCode ${status}` };
        return { kind: "retry", reason: reasonOf(error) };
      }
    },
  };
}

// ── email ───────────────────────────────────────────────────────────────────

/** Email over the operator's SMTP server, as plain text with the link. */
export function emailSender(options: { transport: Transporter; from: string }): ChannelSender {
  return {
    channel: "email",
    async send(target, notice) {
      if (target.channel !== "email") throw new Error("email needs an address");
      const text = noticeText(notice);
      try {
        await options.transport.sendMail({
          from: options.from,
          to: target.email,
          subject: text.title,
          text: `${text.body}\n\n${notice.url}\n\nReplying to this email does nothing; decide on the page.\n`,
        });
        return { kind: "sent" };
      } catch (error) {
        return { kind: "retry", reason: reasonOf(error) };
      }
    },
  };
}

// ── Slack ───────────────────────────────────────────────────────────────────

/** The two Slack Web API methods heel calls; a `WebClient` has both. */
export type SlackApi = Pick<WebClient, "users" | "chat">;

/**
 * Slack's three control characters, escaped, so the agent's words can't
 * become a link or a mention in heel's message.
 */
function slackText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * A Slack direct message from heel's bot, found by the person's email. The
 * message is text with a link and no buttons: nothing in Slack can decide.
 */
export function slackSender(options: { client: SlackApi }): ChannelSender {
  return {
    channel: "slack",
    async send(target, notice) {
      if (target.channel !== "slack") throw new Error("Slack needs an email to look up");
      const text = noticeText(notice);
      try {
        const found = await options.client.users.lookupByEmail({ email: target.email });
        const userId = found.user?.id;
        if (userId === undefined) return { kind: "gone", reason: "users_not_found" };
        await options.client.chat.postMessage({
          channel: userId,
          text: `*${slackText(text.title)}*\n${slackText(text.body)} <${notice.url}|Open heel>`,
          unfurl_links: false,
          unfurl_media: false,
        });
        return { kind: "sent" };
      } catch (error) {
        const code = (error as { data?: { error?: unknown } }).data?.error;
        if (code === "users_not_found") return { kind: "gone", reason: "users_not_found" };
        return { kind: "retry", reason: typeof code === "string" ? code : reasonOf(error) };
      }
    },
  };
}
