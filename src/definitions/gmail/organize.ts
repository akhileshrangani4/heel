import { z } from "zod";
import { normalizeAddress } from "../../core/rules/address.ts";
import { mapLimit } from "../mail/map-limit.ts";
import type { FilterAction, FilterCriteria, GmailFilter } from "./client.ts";
import type { Mailbox } from "./mailbox.ts";
import { GmailId, type GmailTool, gmailTool, type Preparation } from "./tool.ts";

/**
 * Gmail's tools that remove, label and filter mail (D9a-3; spec: Email,
 * "Gmail and Outlook", and Counts).
 *
 * - `email.remove` is any change that takes mail out of view: trash, adding
 *   TRASH or SPAM, and removing INBOX (an archive). Every other label change
 *   is `email.label`.
 * - `items` is the number of messages affected, so one batch of 500 counts
 *   500 and a thread counts its messages (spec: Counts).
 * - A batch with any hidden or missing id is denied whole, and the deny
 *   doesn't say which (I-42, Q-H3).
 * - heel never asks for the scope that deletes permanently, so there is no
 *   delete tool: trash is reversible for 30 days.
 * - A filter is `email.filter`. One that forwards is `email.send` instead,
 *   so every rule that limits where mail may go also limits where a filter
 *   may forward it, and it is persistence: it keeps sending mail out after
 *   heel is revoked, so only a rule that names it can allow it (I-70). Its
 *   forward address is the call's recipient.
 */

/** Gmail's limit for `batchModify` (research §2.1). */
const MAX_BATCH = 1_000;

/** Messages read at once when checking a batch for hidden ids. */
const READ_CONCURRENCY = 5;

const MessageIds = z.array(GmailId).min(1).max(MAX_BATCH);

/** The system labels whose change removes mail from view. */
const REMOVING_ADDS = new Set(["TRASH", "SPAM"]);
const REMOVING_REMOVALS = new Set(["INBOX"]);

/** Pure: whether a label change takes mail out of view. */
export function removes(add: readonly string[], remove: readonly string[]): boolean {
  return add.some((id) => REMOVING_ADDS.has(id)) || remove.some((id) => REMOVING_REMOVALS.has(id));
}

/**
 * Checks a batch before rules run: every id must exist and be visible, or
 * the whole call is denied the same way (I-42). Without hide entries there
 * is nothing to hide, so no reads are made.
 */
async function checkTargets(
  mailbox: Mailbox,
  ids: readonly string[],
  hiding: Parameters<GmailTool["prepare"]>[2],
  signal: AbortSignal,
): Promise<{ deny: "not_available" } | null> {
  if (hiding.entries.length === 0) return null;
  const hidden = await mapLimit(ids, READ_CONCURRENCY, async (id) => {
    const target = await mailbox.target(id, hiding, signal);
    return target.hidden;
  });
  return hidden.some(Boolean) ? { deny: "not_available" } : null;
}

interface BatchArgs {
  message_ids: string[];
}

interface LabelChange extends BatchArgs {
  add_label_ids: string[];
  remove_label_ids: string[];
}

const changed = async (_mailbox: Mailbox, result: unknown) => result;

/** A label change over a batch, with its action and count. */
async function prepareChange(
  mailbox: Mailbox,
  change: LabelChange,
  hiding: Parameters<GmailTool["prepare"]>[2],
  signal: AbortSignal,
): Promise<Preparation<LabelChange>> {
  const ids = [...new Set(change.message_ids)];
  const denied = await checkTargets(mailbox, ids, hiding, signal);
  if (denied !== null) return denied;
  return {
    args: { ...change, message_ids: ids },
    action: removes(change.add_label_ids, change.remove_label_ids) ? "email.remove" : "email.label",
    targets: ids,
    items: ids.length,
  };
}

async function runChange(mailbox: Mailbox, change: LabelChange, signal: AbortSignal) {
  await mailbox.client.batchModify(
    change.message_ids,
    { add: change.add_label_ids, remove: change.remove_label_ids },
    signal,
  );
  return { changed: change.message_ids.length };
}

const archive = gmailTool({
  returns: '{"changed"} (how many messages)',
  description: "Archive messages: take them out of the inbox. Up to 1,000 ids.",
  args: z.strictObject({ message_ids: MessageIds }),
  readOnly: false,
  prepare: (mailbox, args, hiding, signal) =>
    prepareChange(
      mailbox,
      { message_ids: args.message_ids, add_label_ids: [], remove_label_ids: ["INBOX"] },
      hiding,
      signal,
    ),
  run: runChange,
  show: changed,
});

const trash = gmailTool({
  returns: '{"trashed"} (how many messages)',
  description: "Move messages to the trash, where Gmail keeps them for 30 days. Up to 1,000 ids.",
  args: z.strictObject({ message_ids: MessageIds }),
  readOnly: false,
  async prepare(mailbox, args, hiding, signal): Promise<Preparation<BatchArgs>> {
    const ids = [...new Set(args.message_ids)];
    const denied = await checkTargets(mailbox, ids, hiding, signal);
    if (denied !== null) return denied;
    return { args: { message_ids: ids }, action: "email.remove", targets: ids, items: ids.length };
  },
  async run(mailbox, args, signal) {
    // One documented call per message, in order. A refusal of the first is
    // a clean "not done"; a failure after some went leaves the outcome
    // unknown, which is the truth. Counts stay reserved either way.
    let done = 0;
    try {
      for (const id of args.message_ids) {
        await mailbox.client.trashMessage(id, signal);
        done += 1;
      }
    } catch (error) {
      if (done === 0) throw error;
      throw new Error(`trashed ${done} of ${args.message_ids.length} before a failure`, {
        cause: error,
      });
    }
    return { trashed: done };
  },
  show: changed,
});

const trashThread = gmailTool({
  returns: '{"trashed_thread"} (the thread id)',
  description: "Move every message in a thread to the trash.",
  args: z.strictObject({ thread_id: GmailId }),
  readOnly: false,
  async prepare(mailbox, args, hiding, signal) {
    const format = hiding.needsBody ? "full" : "metadata";
    const thread = await mailbox.client.getThread(args.thread_id, format, signal);
    const hidden = await Promise.all(
      thread.messages.map((m) => mailbox.isHidden(m, format, hiding, signal)),
    );
    // A thread holding any hidden message is refused whole, like a batch.
    if (hidden.some(Boolean)) return { deny: "not_available" as const };
    return {
      args,
      action: "email.remove",
      targets: thread.messages.map((m) => m.id),
      items: thread.messages.length,
    };
  },
  async run(mailbox, args, signal) {
    await mailbox.client.trashThread(args.thread_id, signal);
    return { trashed_thread: args.thread_id };
  },
  show: changed,
});

const LabelNames = z.array(z.string().min(1).max(225)).max(100).default([]);

const modifyLabels = gmailTool({
  returns: '{"changed"} (how many messages)',
  description:
    "Add and remove labels on messages, by label name (see list_labels). Removing INBOX archives; " +
    "adding TRASH or SPAM removes. Up to 1,000 ids.",
  args: z.strictObject({ message_ids: MessageIds, add: LabelNames, remove: LabelNames }),
  readOnly: false,
  async prepare(mailbox, args, hiding, signal): Promise<Preparation<LabelChange>> {
    const byName = new Map(
      [...(await mailbox.labelTable(signal)).values()].map((label) => [label.name, label.id]),
    );
    const resolve = (names: readonly string[]) => names.map((name) => byName.get(name));
    const add = resolve(args.add);
    const remove = resolve(args.remove);
    // A name heel can't resolve is refused rather than guessed.
    if ([...add, ...remove].some((id) => id === undefined)) return { deny: "unsupported" };
    // SENT decides which mail counts as the mailbox's own, and DRAFT marks
    // mail about to be sent: heel never adds either.
    if (add.some((id) => id === "SENT" || id === "DRAFT")) return { deny: "unsupported" };
    if (add.length + remove.length === 0) return { deny: "unsupported" };
    return prepareChange(
      mailbox,
      {
        message_ids: args.message_ids,
        add_label_ids: add as string[],
        remove_label_ids: remove as string[],
      },
      hiding,
      signal,
    );
  },
  run: runChange,
  show: changed,
});

const listFilters = gmailTool({
  returns: '{"filters": [{"id", "criteria", "action"}, ...]}',
  description: "List this mailbox's filters: what each matches and what it does.",
  args: z.strictObject({}),
  readOnly: true,
  prepare: async (_mailbox, args) => ({ args }),
  run: (mailbox, _args, signal) => mailbox.client.listFilters(signal),
  show: async (_mailbox, filters: GmailFilter[]) => ({
    filters: filters.map((f) => ({ id: f.id, criteria: f.criteria, action: f.action })),
  }),
});

interface FilterArgs {
  criteria: FilterCriteria;
  action: FilterAction;
}

const createFilter = gmailTool({
  returns: '{"filter_id"}',
  description:
    "Create a filter for future mail. Labels by name. A filter that forwards keeps sending mail out " +
    "after heel is revoked, so it needs a rule that names create_filter.",
  args: z.strictObject({
    criteria: z
      .strictObject({
        from: z.string().max(500).optional(),
        to: z.string().max(500).optional(),
        subject: z.string().max(500).optional(),
        query: z.string().max(1_000).optional(),
        has_attachment: z.boolean().optional(),
      })
      .refine((c) => Object.keys(c).length > 0, "a filter needs at least one criterion"),
    add_labels: LabelNames,
    remove_labels: LabelNames,
    forward_to: z.string().max(320).optional(),
  }),
  readOnly: false,
  async prepare(mailbox, args, _hiding, signal): Promise<Preparation<FilterArgs>> {
    const byName = new Map(
      [...(await mailbox.labelTable(signal)).values()].map((label) => [label.name, label.id]),
    );
    const add = args.add_labels.map((name) => byName.get(name));
    const remove = args.remove_labels.map((name) => byName.get(name));
    if ([...add, ...remove].some((id) => id === undefined)) return { deny: "unsupported" };
    if (add.some((id) => id === "SENT" || id === "DRAFT")) return { deny: "unsupported" };
    const forward = args.forward_to === undefined ? null : normalizeAddress(args.forward_to);
    if (args.forward_to !== undefined && forward === null) return { deny: "unsupported" };
    const criteria: FilterCriteria = {
      ...(args.criteria.from === undefined ? {} : { from: args.criteria.from }),
      ...(args.criteria.to === undefined ? {} : { to: args.criteria.to }),
      ...(args.criteria.subject === undefined ? {} : { subject: args.criteria.subject }),
      ...(args.criteria.query === undefined ? {} : { query: args.criteria.query }),
      ...(args.criteria.has_attachment === undefined
        ? {}
        : { hasAttachment: args.criteria.has_attachment }),
    };
    const action: FilterAction = {
      ...(add.length === 0 ? {} : { addLabelIds: add as string[] }),
      ...(remove.length === 0 ? {} : { removeLabelIds: remove as string[] }),
      ...(forward === null ? {} : { forward }),
    };
    if (Object.keys(action).length === 0) return { deny: "unsupported" };
    return {
      args: { criteria, action },
      ...(forward === null
        ? { action: "email.filter" }
        : { action: "email.send", recipients: [forward], persistence: true }),
    };
  },
  async run(mailbox, args, signal) {
    const filter = await mailbox.client.createFilter(args.criteria, args.action, signal);
    return { filter_id: filter.id };
  },
  show: changed,
});

export const ORGANIZE_TOOLS: Record<string, GmailTool> = {
  archive,
  trash,
  trash_thread: trashThread,
  modify_labels: modifyLabels,
  list_filters: listFilters,
  create_filter: createFilter,
};
