import { z } from "zod";
import { mapLimit } from "../mail/map-limit.ts";
import { GRAPH_API_BASE } from "../microsoft/oauth.ts";
import type { OutlookFolder, OutlookMessage, OutlookRule } from "./client.ts";
import {
  type MessageDetail,
  type MessageSummary,
  messageDetail,
  messageSummary,
} from "./messages.ts";
import { OutlookId, type OutlookTool, outlookTool } from "./tool.ts";

/**
 * Outlook's read tools (D9b), the same as Gmail's: results are rebuilt from
 * the visible messages with one `hidden: { count }` placeholder (I-40,
 * I-41), and a by-id read of a hidden message is refused like a missing one
 * (I-42).
 */

const READ_CONCURRENCY = 5;

export interface SearchResult {
  messages: MessageSummary[];
  next_page_token?: string;
  hidden: { count: number };
}

const search = outlookTool({
  description:
    "Search this mailbox (KQL: from:, to:, subject:, received:, hasAttachments:, …). Returns message " +
    "summaries, newest first. Messages hidden from agents are left out and counted.",
  args: z.strictObject({
    query: z.string().max(1_000),
    max_results: z.number().int().min(1).max(100).default(20),
    page_token: z.string().max(4_000).optional(),
  }),
  readOnly: true,
  async prepare(_mailbox, args) {
    // A page token is a link Graph gave; heel follows only links back to this mailbox.
    if (args.page_token !== undefined && !args.page_token.startsWith(`${GRAPH_API_BASE}me/`)) {
      return { deny: "unsupported" as const };
    }
    return { args };
  },
  run: (mailbox, args, signal) =>
    mailbox.client.listMessages(
      args.page_token === undefined
        ? { search: args.query, top: args.max_results }
        : { nextLink: args.page_token },
      signal,
    ),
  async show(mailbox, page, hiding, signal): Promise<SearchResult> {
    const hidden = await mapLimit(page.messages, READ_CONCURRENCY, (m) =>
      mailbox.isHidden(m, hiding, signal),
    );
    const visible = page.messages.filter((_, i) => !hidden[i]);
    return {
      messages: await Promise.all(
        visible.map(async (m) => messageSummary(m, await mailbox.labels(m, signal))),
      ),
      ...(page.nextLink === undefined ? {} : { next_page_token: page.nextLink }),
      hidden: { count: page.messages.length - visible.length },
    };
  },
});

const getMessage = outlookTool({
  description: "Read one message in full: addresses, folder, categories and body.",
  args: z.strictObject({ message_id: OutlookId }),
  readOnly: true,
  async prepare(mailbox, args, hiding, signal) {
    const { message, hidden } = await mailbox.target(args.message_id, hiding, signal);
    if (hidden) return { deny: "not_available" as const };
    return { args, targets: [message.id] };
  },
  run: (mailbox, args, signal) => mailbox.client.getMessage(args.message_id, signal),
  async show(mailbox, message: OutlookMessage, hiding, signal) {
    if (await mailbox.isHidden(message, hiding, signal)) return { hidden: { count: 1 } };
    return messageDetail(message, await mailbox.labels(message, signal));
  },
});

export interface ThreadResult {
  conversation_id: string;
  messages: MessageDetail[];
  hidden: { count: number };
}

const getThread = outlookTool({
  description:
    "Read every message in a conversation, oldest first. Messages hidden from agents are left out and counted.",
  args: z.strictObject({ conversation_id: OutlookId }),
  readOnly: true,
  async prepare(mailbox, args, hiding, signal) {
    const messages = await mailbox.client.listConversation(args.conversation_id, null, signal);
    const hidden = await Promise.all(messages.map((m) => mailbox.isHidden(m, hiding, signal)));
    if (messages.length === 0 || hidden.every(Boolean)) return { deny: "not_available" as const };
    return { args, targets: messages.map((m) => m.id) };
  },
  run: (mailbox, args, signal) =>
    mailbox.client.listConversation(args.conversation_id, null, signal),
  async show(mailbox, messages: OutlookMessage[], hiding, signal): Promise<ThreadResult> {
    const hidden = await Promise.all(messages.map((m) => mailbox.isHidden(m, hiding, signal)));
    const visible = messages.filter((_, i) => !hidden[i]);
    return {
      conversation_id: messages[0]?.conversationId ?? "",
      messages: await Promise.all(
        visible.map(async (m) => messageDetail(m, await mailbox.labels(m, signal))),
      ),
      hidden: { count: messages.length - visible.length },
    };
  },
});

const listFolders = outlookTool({
  description: "List this mailbox's folders, nested ones included, with their ids.",
  args: z.strictObject({}),
  readOnly: true,
  prepare: async (_mailbox, args) => ({ args }),
  run: (mailbox, _args, signal) => mailbox.client.listFolders(signal),
  show: async (_mailbox, folders: OutlookFolder[]) => ({
    folders: folders.map((f) => ({ id: f.id, name: f.displayName })),
  }),
});

const listRules = outlookTool({
  description: "List this mailbox's inbox rules: what each matches and what it does.",
  args: z.strictObject({}),
  readOnly: true,
  prepare: async (_mailbox, args) => ({ args }),
  run: (mailbox, _args, signal) => mailbox.client.listRules(signal),
  show: async (_mailbox, rules: OutlookRule[]) => ({
    rules: rules.map((r) => ({
      id: r.id,
      name: r.displayName,
      conditions: r.conditions ?? {},
      actions: r.actions ?? {},
    })),
  }),
});

const listSendAs = outlookTool({
  description: "The address this mailbox sends as. Every send names it as `from`.",
  args: z.strictObject({}),
  readOnly: true,
  prepare: async (_mailbox, args) => ({ args }),
  run: async (mailbox) => [mailbox.address],
  show: async (_mailbox, addresses: string[]) => ({ addresses }),
});

export const READ_TOOLS: Record<string, OutlookTool> = {
  search,
  get_message: getMessage,
  get_thread: getThread,
  list_folders: listFolders,
  list_rules: listRules,
  list_send_as: listSendAs,
};
