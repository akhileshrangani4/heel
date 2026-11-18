import type { Tool } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Hiding } from "../../core/hide.ts";
import type { Definition, Normalized } from "../../gateway/pipeline/ports.ts";
import type { AccountRecord } from "../../store/directory.ts";
import type { Vault } from "../../vault/vault.ts";
import type { FetchFn } from "../google/oauth.ts";
import {
  GmailClient,
  type GmailLabel,
  type GmailMessage,
  GmailNotFoundError,
  type MessageFormat,
} from "./client.ts";
import {
  hideCandidate,
  type MessageDetail,
  type MessageSummary,
  messageBody,
  messageDetail,
  messageSummary,
} from "./messages.ts";

/**
 * The Gmail definition (D9a-1b: reads). heel's own tools, calling the Gmail
 * API with the account's credential (spec: Email, "Gmail and Outlook").
 *
 * Each tool is one row of `TOOLS`: its schema for the agent, its argument
 * validation, and its kind. The table is the only place a Gmail tool is
 * marked `read` (I-20).
 *
 * Hiding (spec: Hiding):
 * - Results are rebuilt from the visible messages, field by field, with one
 *   `hidden: { count }` placeholder and no per-row markers (I-40, I-41).
 * - `get_message` and `get_thread` read their target while normalizing. A
 *   hidden target and a missing one are denied the same way, `not_available`,
 *   so the deny can't tell an agent which hidden ids exist (I-42).
 * - Bodies are read only when an entry uses `looks_like`.
 */

export interface GmailDeps {
  vault: Vault;
  fetch: FetchFn;
}

/** Reads per search page at once; Gmail recommends small bursts. */
const READ_CONCURRENCY = 5;

const MessageId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, "expected a Gmail id");

const TOOLS = {
  search: {
    description:
      "Search this mailbox with Gmail search syntax (from:, to:, subject:, label:, newer_than:, …). " +
      "Returns message summaries, newest first. Messages hidden from agents are left out and counted.",
    args: z.strictObject({
      query: z.string().max(2_000),
      max_results: z.number().int().min(1).max(100).default(20),
      page_token: z.string().max(512).optional(),
    }),
  },
  get_message: {
    description: "Read one message in full: headers, labels, body and attachment names.",
    args: z.strictObject({ message_id: MessageId }),
  },
  get_thread: {
    description:
      "Read every message in a thread, in order. Messages hidden from agents are left out and counted.",
    args: z.strictObject({ thread_id: MessageId }),
  },
  list_labels: {
    description: "List this mailbox's labels: system labels (INBOX, SENT, …) and your own.",
    args: z.strictObject({}),
  },
} as const;
type ToolName = keyof typeof TOOLS;

function isToolName(name: string): name is ToolName {
  return Object.hasOwn(TOOLS, name);
}

/** The tools as MCP lists them. All of them only read. */
export const GMAIL_TOOLS: readonly Tool[] = Object.entries(TOOLS).map(([name, tool]) => ({
  name,
  description: tool.description,
  inputSchema: z.toJSONSchema(tool.args, { io: "input" }) as Tool["inputSchema"],
  annotations: { readOnlyHint: true },
}));

/** What `execute` hands to `hide`; never shown to an agent as is. */
type Fetched =
  | { tool: "search"; messages: GmailMessage[]; nextPageToken: string | undefined }
  | { tool: "get_message"; message: GmailMessage }
  | { tool: "get_thread"; threadId: string; messages: GmailMessage[] }
  | { tool: "list_labels"; labels: GmailLabel[] };

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

async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function gmailDefinition(account: AccountRecord, deps: GmailDeps): Definition {
  const client = new GmailClient(deps.fetch, async () =>
    (await deps.vault.accessToken(account.id)).reveal(),
  );
  // One definition serves one call, so the label table is read at most once per call.
  let labels: Promise<Map<string, GmailLabel>> | null = null;
  const labelTable = (signal: AbortSignal) => {
    labels ??= client
      .listLabels(signal)
      .then((list) => new Map(list.map((label) => [label.id, label])));
    return labels;
  };

  /** Whether a message is hidden; a message heel can't judge is. */
  async function isHidden(
    message: GmailMessage,
    format: MessageFormat,
    hiding: Hiding,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (hiding.entries.length === 0) return false;
    let body: ReturnType<typeof messageBody> | undefined;
    if (hiding.needsBody) {
      const full =
        format === "full" ? message : await client.getMessage(message.id, "full", signal);
      body = messageBody(full);
    }
    const candidate = hideCandidate(message, await labelTable(signal), body);
    return candidate === null || hiding.isHidden(candidate);
  }

  async function labelNamesOf(message: GmailMessage, signal: AbortSignal): Promise<string[]> {
    const table = await labelTable(signal);
    return message.labelIds.map((id) => table.get(id)?.name ?? id);
  }

  return {
    tools: async () => [...GMAIL_TOOLS],

    async normalize(base, ctx): Promise<Normalized> {
      if (!isToolName(base.tool)) return { ok: false, reason: "unsupported" };
      const parsed = TOOLS[base.tool].args.safeParse(base.args);
      if (!parsed.success) return { ok: false, reason: "unsupported" };
      const call = { ...base, args: parsed.data, kind: "read" as const, items: 1 };
      const format: MessageFormat = ctx.hide.needsBody ? "full" : "metadata";
      try {
        if (base.tool === "get_message") {
          const { message_id } = parsed.data as { message_id: string };
          const message = await client.getMessage(message_id, format, ctx.signal);
          if (await isHidden(message, format, ctx.hide, ctx.signal)) {
            return { ok: false, reason: "not_available" };
          }
          return { ok: true, call: { ...call, targets: [message.id] } };
        }
        if (base.tool === "get_thread") {
          const { thread_id } = parsed.data as { thread_id: string };
          const thread = await client.getThread(thread_id, format, ctx.signal);
          const hidden = await Promise.all(
            thread.messages.map((m) => isHidden(m, format, ctx.hide, ctx.signal)),
          );
          if (hidden.every(Boolean)) return { ok: false, reason: "not_available" };
          return { ok: true, call: { ...call, targets: thread.messages.map((m) => m.id) } };
        }
      } catch (error) {
        if (error instanceof GmailNotFoundError) return { ok: false, reason: "not_available" };
        return { ok: false, reason: "lookup_unavailable" };
      }
      return { ok: true, call };
    },

    async execute(call, signal): Promise<Fetched> {
      const args = call.args as Record<string, unknown>;
      switch (call.tool as ToolName) {
        case "search": {
          const page = await client.listMessages(
            {
              query: args["query"] as string,
              maxResults: args["max_results"] as number,
              pageToken: args["page_token"] as string | undefined,
            },
            signal,
          );
          const messages = await mapLimit(page.messages, READ_CONCURRENCY, (m) =>
            client.getMessage(m.id, "metadata", signal),
          );
          return { tool: "search", messages, nextPageToken: page.nextPageToken };
        }
        case "get_message":
          return {
            tool: "get_message",
            message: await client.getMessage(args["message_id"] as string, "full", signal),
          };
        case "get_thread": {
          const thread = await client.getThread(args["thread_id"] as string, "full", signal);
          return { tool: "get_thread", threadId: thread.id, messages: thread.messages };
        }
        case "list_labels":
          return { tool: "list_labels", labels: await client.listLabels(signal) };
      }
    },

    async hide(_call, result, hiding) {
      const fetched = result as Fetched;
      const signal = AbortSignal.timeout(60_000);
      switch (fetched.tool) {
        case "search": {
          const hidden = await mapLimit(fetched.messages, READ_CONCURRENCY, (m) =>
            isHidden(m, "metadata", hiding, signal),
          );
          const visible = fetched.messages.filter((_, i) => !hidden[i]);
          const out: SearchResult = {
            messages: await Promise.all(
              visible.map(async (m) => messageSummary(m, await labelNamesOf(m, signal))),
            ),
            hidden: { count: fetched.messages.length - visible.length },
          };
          if (fetched.nextPageToken !== undefined) out.next_page_token = fetched.nextPageToken;
          return out;
        }
        case "get_message": {
          // Normalizing already refused a hidden target; this is the backstop
          // for a message that changed in between.
          if (await isHidden(fetched.message, "full", hiding, signal))
            return { hidden: { count: 1 } };
          return messageDetail(fetched.message, await labelNamesOf(fetched.message, signal));
        }
        case "get_thread": {
          const hidden = await Promise.all(
            fetched.messages.map((m) => isHidden(m, "full", hiding, signal)),
          );
          const visible = fetched.messages.filter((_, i) => !hidden[i]);
          const out: ThreadResult = {
            id: fetched.threadId,
            messages: await Promise.all(
              visible.map(async (m) => messageDetail(m, await labelNamesOf(m, signal))),
            ),
            hidden: { count: fetched.messages.length - visible.length },
          };
          return out;
        }
        case "list_labels":
          return {
            labels: fetched.labels.map((label) => ({
              id: label.id,
              name: label.name,
              type: label.type ?? "user",
            })),
          };
      }
    },
  };
}
