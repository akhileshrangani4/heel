import type { Tool } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Definition } from "../../gateway/pipeline/ports.ts";
import type { AccountRecord } from "../../store/directory.ts";
import { type ApiDeps, accountToken } from "../api-deps.ts";
import { listedTools, type ToolRow, toolRow, toolTableDefinition } from "../tool-table.ts";
import { SlackClient } from "./client.ts";

/**
 * The Slack definition: heel's own tools on the Slack Web API with the
 * account's token
 * (a bot or user token, connected with `heel connect slack --credential-stdin`).
 *
 * - Actions: `slack.read`, `slack.post`, `slack.update`, `slack.delete`, and
 *   `slack.schedule` for a scheduled message, which is persistence (I-70): it
 *   posts after heel is revoked. It has its own action so a rule allowing
 *   `slack.post` doesn't reach it.
 * - Rules see `channel` (the channel id) and `external`: whether the channel
 *   is shared with another organization through Slack Connect
 *   (`is_ext_shared` or `is_pending_ext_shared` from `conversations.info`),
 *   read before any rule. A failed read denies the call.
 * - Messages are plain text only: no blocks or attachments; `&`, `<` and
 *   `>` are escaped, so no mention, broadcast or disguised link can hide in
 *   them, and links don't unfurl. What an approver reads is what is posted.
 * - A DM or group DM counts as `external`: Slack doesn't mark external
 *   people on those conversations.
 * - heel offers no tool for incoming webhooks or app installs.
 *
 * Methods (https://docs.slack.dev/reference/methods/<name>): conversations.list,
 * conversations.info, conversations.history, conversations.replies,
 * chat.postMessage, chat.update, chat.delete, chat.scheduleMessage.
 */

interface Box {
  client: SlackClient;
}

type SlackTool = ToolRow<Box>;
const tool = toolRow<Box>();

const Channel = z.string().regex(/^[CDG][A-Z0-9]{2,30}$/, "expected a channel id like C0123ABCD");
const Ts = z
  .string()
  .regex(/^[0-9]{10}\.[0-9]{6}$/, "expected a message ts like 1700000000.000100");
const Cursor = z.string().max(500).optional();
const Limit = z.number().int().min(1).max(200).default(50);
const Text = z.string().min(1).max(40_000);

/**
 * The channel's id and whether it may reach another organization, failing
 * closed: `is_ext_shared` must be a boolean (otherwise the read fails and the
 * call is denied), and a DM or group DM counts as external, since Slack marks
 * external people on the user, not on the conversation
 * (https://docs.slack.dev/reference/objects/conversation-object).
 */
async function channelFields(box: Box, channel: string, signal: AbortSignal) {
  const info = await box.client.call("conversations.info", { channel }, signal);
  const c = info["channel"] as Record<string, unknown> | undefined;
  if (c === undefined || c["id"] !== channel) {
    throw new Error("conversations.info answered for another channel");
  }
  const direct = c["is_im"] === true || c["is_mpim"] === true;
  if (!direct && typeof c["is_ext_shared"] !== "boolean") {
    throw new Error("conversations.info didn't say whether the channel is shared");
  }
  return {
    channel,
    external: direct || c["is_ext_shared"] === true || c["is_pending_ext_shared"] === true,
  };
}

/**
 * Text exactly as written: `&`, `<` and `>` are escaped (Slack's documented
 * escaping, https://docs.slack.dev/messaging/formatting-message-text), so
 * `<!channel>`, mentions and `<url|label>` links can't hide in it.
 */
const plain = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const message = (raw: unknown) => {
  const m = raw as Record<string, unknown>;
  return {
    ts: m["ts"] ?? null,
    user: m["user"] ?? m["bot_id"] ?? null,
    text: m["text"] ?? "",
    thread_ts: m["thread_ts"] ?? null,
    replies: m["reply_count"] ?? 0,
  };
};
const page = (body: Record<string, unknown>) => ({
  messages: Array.isArray(body["messages"]) ? body["messages"].map(message) : [],
  next_cursor:
    (body["response_metadata"] as { next_cursor?: unknown } | undefined)?.next_cursor || null,
});

const TOOLS: Record<string, SlackTool> = {
  list_channels: tool({
    returns: '{"channels": [{"id", "name", "private", "external"}, ...], "next_cursor"}',
    description: "List the channels this account can see, with their ids.",
    args: z.strictObject({
      cursor: Cursor,
      limit: Limit,
      include_private: z.boolean().default(false),
    }),
    readOnly: true,
    prepare: async (_box, args) => ({ args, action: "slack.read" }),
    run: (box, a, signal) =>
      box.client.call(
        "conversations.list",
        {
          types: a.include_private ? "public_channel,private_channel" : "public_channel",
          exclude_archived: true,
          limit: a.limit,
          cursor: a.cursor,
        },
        signal,
      ),
    show: async (_box, body: Record<string, unknown>) => ({
      channels: Array.isArray(body["channels"])
        ? (body["channels"] as Record<string, unknown>[]).map((c) => ({
            id: c["id"],
            name: c["name"],
            private: c["is_private"] === true,
            external: c["is_ext_shared"] === true || c["is_pending_ext_shared"] === true,
          }))
        : [],
      next_cursor:
        (body["response_metadata"] as { next_cursor?: unknown } | undefined)?.next_cursor || null,
    }),
  }),

  read_channel: tool({
    returns: '{"messages": [{"ts", "user", "text", "thread_ts", "replies"}, ...], "next_cursor"}',
    description: "Read a channel's recent messages, newest first.",
    args: z.strictObject({
      channel: Channel,
      cursor: Cursor,
      limit: Limit,
      oldest: Ts.optional(),
      latest: Ts.optional(),
    }),
    readOnly: true,
    prepare: async (box, args, _h, signal) => ({
      args,
      action: "slack.read",
      fields: await channelFields(box, args.channel, signal),
    }),
    run: (box, a, signal) =>
      box.client.call(
        "conversations.history",
        {
          channel: a.channel,
          cursor: a.cursor,
          limit: a.limit,
          oldest: a.oldest,
          latest: a.latest,
        },
        signal,
      ),
    show: async (_box, body: Record<string, unknown>) => page(body),
  }),

  read_thread: tool({
    returns: '{"messages": [{"ts", "user", "text", "thread_ts", "replies"}, ...], "next_cursor"}',
    description: "Read a thread: the parent message and its replies.",
    args: z.strictObject({ channel: Channel, ts: Ts, cursor: Cursor, limit: Limit }),
    readOnly: true,
    prepare: async (box, args, _h, signal) => ({
      args,
      action: "slack.read",
      fields: await channelFields(box, args.channel, signal),
      targets: [`${args.channel}/${args.ts}`],
    }),
    run: (box, a, signal) =>
      box.client.call(
        "conversations.replies",
        { channel: a.channel, ts: a.ts, cursor: a.cursor, limit: a.limit },
        signal,
      ),
    show: async (_box, body: Record<string, unknown>) => page(body),
  }),

  post_message: tool({
    returns: '{"channel", "ts"}',
    description: "Post a plain-text message to a channel, or as a reply in a thread.",
    args: z.strictObject({ channel: Channel, text: Text, thread_ts: Ts.optional() }),
    readOnly: false,
    prepare: async (box, args, _h, signal) => ({
      args,
      action: "slack.post",
      fields: await channelFields(box, args.channel, signal),
    }),
    run: (box, a, signal) =>
      box.client.call(
        "chat.postMessage",
        {
          channel: a.channel,
          text: plain(a.text),
          thread_ts: a.thread_ts,
          unfurl_links: false,
          unfurl_media: false,
        },
        signal,
        true,
      ),
    show: async (_box, body: Record<string, unknown>) => ({
      channel: body["channel"],
      ts: body["ts"],
    }),
  }),

  update_message: tool({
    returns: '{"channel", "ts"}',
    description: "Replace the text of a message this account posted.",
    args: z.strictObject({ channel: Channel, ts: Ts, text: Text }),
    readOnly: false,
    prepare: async (box, args, _h, signal) => ({
      args,
      action: "slack.update",
      fields: await channelFields(box, args.channel, signal),
      targets: [`${args.channel}/${args.ts}`],
    }),
    run: (box, a, signal) =>
      box.client.call(
        "chat.update",
        { channel: a.channel, ts: a.ts, text: plain(a.text) },
        signal,
        true,
      ),
    show: async (_box, body: Record<string, unknown>) => ({
      channel: body["channel"],
      ts: body["ts"],
    }),
  }),

  delete_message: tool({
    returns: '{"channel", "ts"}',
    description:
      "Delete a message. Slack lets a token delete what its user could delete in the app.",
    args: z.strictObject({ channel: Channel, ts: Ts }),
    readOnly: false,
    prepare: async (box, args, _h, signal) => ({
      args,
      action: "slack.delete",
      fields: await channelFields(box, args.channel, signal),
      targets: [`${args.channel}/${args.ts}`],
    }),
    run: (box, a, signal) =>
      box.client.call("chat.delete", { channel: a.channel, ts: a.ts }, signal, true),
    show: async (_box, body: Record<string, unknown>) => ({
      channel: body["channel"],
      ts: body["ts"],
    }),
  }),

  schedule_message: tool({
    returns: '{"channel", "scheduled_message_id", "post_at"}',
    description:
      "Schedule a plain-text message to post later (up to 120 days ahead). It posts even if heel is revoked first.",
    args: z.strictObject({
      channel: Channel,
      text: Text,
      post_at: z.number().int().min(0),
      thread_ts: Ts.optional(),
    }),
    readOnly: false,
    prepare: async (box, args, _h, signal) => ({
      args,
      action: "slack.schedule",
      persistence: true,
      fields: await channelFields(box, args.channel, signal),
    }),
    run: (box, a, signal) =>
      box.client.call(
        "chat.scheduleMessage",
        {
          channel: a.channel,
          text: plain(a.text),
          post_at: a.post_at,
          thread_ts: a.thread_ts,
          unfurl_links: false,
          unfurl_media: false,
        },
        signal,
        true,
      ),
    show: async (_box, body: Record<string, unknown>) => ({
      channel: body["channel"],
      scheduled_message_id: body["scheduled_message_id"],
      post_at: body["post_at"],
    }),
  }),
};

export const SLACK_TOOLS: readonly Tool[] = listedTools(TOOLS);

export function slackDefinition(account: AccountRecord, deps: ApiDeps): Definition {
  const token = () => accountToken(deps, account);
  return toolTableDefinition({
    tools: TOOLS,
    listed: SLACK_TOOLS,
    box: { client: new SlackClient(deps.fetch, token) },
    stateCheck: async () => "fail",
  });
}
