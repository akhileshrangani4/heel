import { z } from "zod";
import { mapLimit } from "../mail/map-limit.ts";
import type { GmailLabel, GmailMessage } from "./client.ts";
import {
  type MessageDetail,
  type MessageSummary,
  messageDetail,
  messageSummary,
} from "./messages.ts";
import { GmailId, type GmailTool, gmailTool } from "./tool.ts";

/**
 * Gmail's read tools (D9a-1b). Results are rebuilt from the visible
 * messages, field by field, with one `hidden: { count }` placeholder
 * (I-40, I-41). By-id reads are refused for a hidden target exactly as for a
 * missing one (I-42).
 */

/** Reads per search page at once; Gmail recommends small bursts. */
const READ_CONCURRENCY = 5;

export interface SearchResult {
  messages: MessageSummary[];
  next_page_token?: string;
  hidden: { count: number };
}

export interface ThreadResult {
  id: string;
  messages: MessageDetail[];
  hidden: { count: number };
}

const search = gmailTool({
  description:
    "Search this mailbox with Gmail search syntax (from:, to:, subject:, label:, newer_than:, …). " +
    "Returns message summaries, newest first. Messages hidden from agents are left out and counted.",
  args: z.strictObject({
    query: z.string().max(2_000),
    max_results: z.number().int().min(1).max(100).default(20),
    page_token: z.string().max(512).optional(),
  }),
  readOnly: true,
  prepare: async (_mailbox, args) => ({ args }),
  async run(mailbox, args, signal) {
    const page = await mailbox.client.listMessages(
      { query: args.query, maxResults: args.max_results, pageToken: args.page_token },
      signal,
    );
    const messages = await mapLimit(page.messages, READ_CONCURRENCY, (m) =>
      mailbox.client.getMessage(m.id, "metadata", signal),
    );
    return { messages, nextPageToken: page.nextPageToken };
  },
  async show(mailbox, { messages, nextPageToken }, hiding, signal): Promise<SearchResult> {
    const hidden = await mapLimit(messages, READ_CONCURRENCY, (m) =>
      mailbox.isHidden(m, "metadata", hiding, signal),
    );
    const visible = messages.filter((_, i) => !hidden[i]);
    return {
      messages: await Promise.all(
        visible.map(async (m) => messageSummary(m, await mailbox.labelNames(m, signal))),
      ),
      ...(nextPageToken === undefined ? {} : { next_page_token: nextPageToken }),
      hidden: { count: messages.length - visible.length },
    };
  },
});

const getMessage = gmailTool({
  description: "Read one message in full: headers, labels, body and attachment names.",
  args: z.strictObject({ message_id: GmailId }),
  readOnly: true,
  async prepare(mailbox, args, hiding, signal) {
    const { message, hidden } = await mailbox.target(args.message_id, hiding, signal);
    if (hidden) return { deny: "not_available" };
    return { args, targets: [message.id] };
  },
  run: (mailbox, args, signal) => mailbox.client.getMessage(args.message_id, "full", signal),
  async show(mailbox, message: GmailMessage, hiding, signal) {
    // `prepare` already refused a hidden target; this is the backstop for a
    // message that changed in between.
    if (await mailbox.isHidden(message, "full", hiding, signal)) return { hidden: { count: 1 } };
    return messageDetail(message, await mailbox.labelNames(message, signal));
  },
});

const getThread = gmailTool({
  description:
    "Read every message in a thread, in order. Messages hidden from agents are left out and counted.",
  args: z.strictObject({ thread_id: GmailId }),
  readOnly: true,
  async prepare(mailbox, args, hiding, signal) {
    const format = hiding.needsBody ? "full" : "metadata";
    const thread = await mailbox.client.getThread(args.thread_id, format, signal);
    const hidden = await Promise.all(
      thread.messages.map((m) => mailbox.isHidden(m, format, hiding, signal)),
    );
    // A thread with nothing visible is refused like a missing one.
    if (hidden.every(Boolean)) return { deny: "not_available" };
    return { args, targets: thread.messages.map((m) => m.id) };
  },
  run: (mailbox, args, signal) => mailbox.client.getThread(args.thread_id, "full", signal),
  async show(mailbox, thread, hiding, signal): Promise<ThreadResult> {
    const hidden = await Promise.all(
      thread.messages.map((m) => mailbox.isHidden(m, "full", hiding, signal)),
    );
    const visible = thread.messages.filter((_, i) => !hidden[i]);
    return {
      id: thread.id,
      messages: await Promise.all(
        visible.map(async (m) => messageDetail(m, await mailbox.labelNames(m, signal))),
      ),
      hidden: { count: thread.messages.length - visible.length },
    };
  },
});

const listLabels = gmailTool({
  description: "List this mailbox's labels: system labels (INBOX, SENT, …) and your own.",
  args: z.strictObject({}),
  readOnly: true,
  prepare: async (_mailbox, args) => ({ args }),
  run: (mailbox, _args, signal) => mailbox.client.listLabels(signal),
  show: async (_mailbox, labels: GmailLabel[]) => ({
    labels: labels.map((label) => ({ id: label.id, name: label.name, type: label.type ?? "user" })),
  }),
});

const listSendAs = gmailTool({
  description:
    "List the addresses this mailbox can send as. Every send names one of them as `from`.",
  args: z.strictObject({}),
  readOnly: true,
  prepare: async (_mailbox, args) => ({ args }),
  run: async (mailbox, _args, signal) => [...(await mailbox.sendAs(signal))],
  show: async (_mailbox, addresses: string[]) => ({ addresses }),
});

export const READ_TOOLS: Record<string, GmailTool> = {
  search,
  get_message: getMessage,
  get_thread: getThread,
  list_labels: listLabels,
  list_send_as: listSendAs,
};
