import { z } from "zod";
import type { Hiding } from "../../core/hide.ts";
import { normalizeAddress } from "../../core/rules/address.ts";
import { mapLimit } from "../mail/map-limit.ts";
import type { Preparation } from "../mail/tool.ts";
import type { OutlookMailbox } from "./messages.ts";
import { OutlookId, type OutlookTool, outlookTool } from "./tool.ts";

/**
 * Outlook's tools that move, delete, categorize and filter mail (D9b; spec:
 * Email, "Gmail and Outlook").
 *
 * - `email.remove` is a delete, or a move into Deleted Items, Junk, Archive
 *   or Recoverable Items, any folder inside them, or a hidden folder. heel
 *   resolves the destination's folder chain by id, never by display name
 *   (research §7, gap 5), and moves to the id it resolved. Any other move,
 *   and categories, are `email.label`.
 * - Moves into Sent Items, Drafts or Outbox are refused: Sent Items decides
 *   which mail counts as the mailbox's own.
 * - `items` counts messages, and a batch holding any hidden or missing id is
 *   refused whole (I-42, Q-H3).
 * - heel never offers `permanentDelete`.
 * - An inbox rule is `email.filter`, whatever it does to future mail. One
 *   that forwards or redirects is `email.send` and persistence, with its
 *   addresses as recipients, as for Gmail filters (I-70).
 */

const MAX_BATCH = 100;
const READ_CONCURRENCY = 5;

const MessageIds = z.array(OutlookId).min(1).max(MAX_BATCH);

async function checkTargets(
  mailbox: OutlookMailbox,
  ids: readonly string[],
  hiding: Hiding,
  signal: AbortSignal,
): Promise<{ deny: "not_available" } | null> {
  if (hiding.entries.length === 0) return null;
  const hidden = await mapLimit(ids, READ_CONCURRENCY, async (id) => {
    const target = await mailbox.target(id, hiding, signal);
    return target.hidden;
  });
  return hidden.some(Boolean) ? { deny: "not_available" } : null;
}

const done = async (_mailbox: OutlookMailbox, result: unknown) => result;

/** One write per message, in order: a failure after some went leaves the outcome unknown. */
async function eachMessage(ids: readonly string[], write: (id: string) => Promise<void>) {
  let count = 0;
  try {
    for (const id of ids) {
      await write(id);
      count += 1;
    }
  } catch (error) {
    if (count === 0) throw error;
    throw new Error(`changed ${count} of ${ids.length} messages before a failure`, {
      cause: error,
    });
  }
  return count;
}

interface MoveArgs {
  message_ids: string[];
  destination: string;
}

async function prepareMove(
  mailbox: OutlookMailbox,
  args: MoveArgs,
  hiding: Hiding,
  signal: AbortSignal,
): Promise<Preparation<MoveArgs>> {
  const destination = await mailbox.destination(args.destination, signal);
  if (destination.kind === "refused") return { deny: "unsupported" };
  const ids = [...new Set(args.message_ids)];
  const denied = await checkTargets(mailbox, ids, hiding, signal);
  if (denied !== null) return denied;
  return {
    // The resolved folder id, so the move goes where heel judged it would.
    args: { message_ids: ids, destination: destination.id },
    action: destination.kind === "removal" ? "email.remove" : "email.label",
    targets: ids,
    items: ids.length,
  };
}

async function runMove(mailbox: OutlookMailbox, args: MoveArgs, signal: AbortSignal) {
  const moved = await eachMessage(args.message_ids, (id) =>
    mailbox.client.move(id, args.destination, signal),
  );
  return { moved };
}

const trash = outlookTool({
  returns: '{"moved"} (how many messages)',
  description: "Move messages to Deleted Items. Up to 100 ids.",
  args: z.strictObject({ message_ids: MessageIds }),
  readOnly: false,
  prepare: (mailbox, args, hiding, signal) =>
    prepareMove(
      mailbox,
      { message_ids: args.message_ids, destination: "deleteditems" },
      hiding,
      signal,
    ),
  run: runMove,
  show: done,
});

const archive = outlookTool({
  returns: '{"moved"} (how many messages)',
  description: "Move messages to the Archive folder. Up to 100 ids.",
  args: z.strictObject({ message_ids: MessageIds }),
  readOnly: false,
  prepare: (mailbox, args, hiding, signal) =>
    prepareMove(mailbox, { message_ids: args.message_ids, destination: "archive" }, hiding, signal),
  run: runMove,
  show: done,
});

const move = outlookTool({
  returns: '{"moved"} (how many messages)',
  description:
    "Move messages to a folder: a well-known name (inbox, archive, deleteditems, junkemail, …) or an id " +
    "from list_folders. Moving into Deleted Items, Junk or Archive removes. Up to 100 ids.",
  args: z.strictObject({ message_ids: MessageIds, folder: OutlookId }),
  readOnly: false,
  prepare: (mailbox, args, hiding, signal) =>
    prepareMove(
      mailbox,
      { message_ids: args.message_ids, destination: args.folder },
      hiding,
      signal,
    ),
  run: runMove,
  show: done,
});

const deleteMessages = outlookTool({
  returns: '{"deleted"} (how many messages)',
  description: "Delete messages into Deleted Items. Up to 100 ids.",
  args: z.strictObject({ message_ids: MessageIds }),
  readOnly: false,
  async prepare(mailbox, args, hiding, signal): Promise<Preparation<{ message_ids: string[] }>> {
    const ids = [...new Set(args.message_ids)];
    const denied = await checkTargets(mailbox, ids, hiding, signal);
    if (denied !== null) return denied;
    return { args: { message_ids: ids }, action: "email.remove", targets: ids, items: ids.length };
  },
  async run(mailbox, args, signal) {
    const deleted = await eachMessage(args.message_ids, (id) =>
      mailbox.client.deleteMessage(id, signal),
    );
    return { deleted };
  },
  show: done,
});

const Categories = z.array(z.string().min(1).max(255)).max(25).default([]);

interface CategoryArgs {
  message_ids: string[];
  /** Each message's categories after the change, as heel read them. */
  categories: Record<string, string[]>;
}

const setCategories = outlookTool({
  returns: '{"changed"} (how many messages)',
  description: "Add and remove categories on messages. Up to 100 ids.",
  args: z.strictObject({ message_ids: MessageIds, add: Categories, remove: Categories }),
  readOnly: false,
  async prepare(mailbox, args, hiding, signal): Promise<Preparation<CategoryArgs>> {
    if (args.add.length + args.remove.length === 0) return { deny: "unsupported" };
    const ids = [...new Set(args.message_ids)];
    const targets = await mapLimit(ids, READ_CONCURRENCY, (id) =>
      mailbox.target(id, hiding, signal),
    );
    if (targets.some((t) => t.hidden)) return { deny: "not_available" };
    // Keyed by the id the agent sent, which is the id the PATCH uses.
    const categories: Record<string, string[]> = {};
    ids.forEach((id, i) => {
      const next = new Set([...(targets[i]?.message.categories ?? []), ...args.add]);
      for (const name of args.remove) next.delete(name);
      categories[id] = [...next];
    });
    return {
      args: { message_ids: ids, categories },
      action: "email.label",
      targets: ids,
      items: ids.length,
    };
  },
  async run(mailbox, args, signal) {
    const changed = await eachMessage(args.message_ids, (id) => {
      const categories = args.categories[id];
      if (categories === undefined) throw new Error(`no categories prepared for ${id}`);
      return mailbox.client.patchMessage(id, { categories }, signal);
    });
    return { changed };
  },
  show: done,
});

const AddressList = z.array(z.string().max(320)).max(20).default([]);

interface RuleArgs {
  rule: Record<string, unknown>;
}

const createRule = outlookTool({
  returns: '{"rule_id"}',
  description:
    "Create an inbox rule for future mail. A rule that forwards or redirects keeps sending mail out after " +
    "heel is revoked, so it needs a rule that names create_rule.",
  args: z.strictObject({
    name: z.string().min(1).max(255),
    conditions: z
      .strictObject({
        from_addresses: AddressList,
        subject_contains: z.array(z.string().min(1).max(255)).max(20).default([]),
        body_contains: z.array(z.string().min(1).max(255)).max(20).default([]),
      })
      .refine(
        (c) => c.from_addresses.length + c.subject_contains.length + c.body_contains.length > 0,
        "a rule needs at least one condition",
      ),
    move_to_folder: OutlookId.optional(),
    add_categories: Categories,
    mark_as_read: z.boolean().optional(),
    delete: z.boolean().optional(),
    forward_to: AddressList,
    redirect_to: AddressList,
  }),
  readOnly: false,
  async prepare(mailbox, args, _hiding, signal): Promise<Preparation<RuleArgs>> {
    const plain = (list: readonly string[]) => list.map((a) => normalizeAddress(a));
    const from = plain(args.conditions.from_addresses);
    const forwardTo = plain(args.forward_to);
    const redirectTo = plain(args.redirect_to);
    if ([...from, ...forwardTo, ...redirectTo].some((a) => a === null)) {
      return { deny: "address_unparseable" };
    }
    const asRecipients = (list: (string | null)[]) =>
      (list as string[]).map((address) => ({ emailAddress: { address } }));
    const destination =
      args.move_to_folder === undefined
        ? null
        : await mailbox.destination(args.move_to_folder, signal);
    if (destination?.kind === "refused") return { deny: "unsupported" };
    const actions: Record<string, unknown> = {
      ...(destination === null ? {} : { moveToFolder: destination.id }),
      ...(args.add_categories.length === 0 ? {} : { assignCategories: args.add_categories }),
      ...(args.mark_as_read === undefined ? {} : { markAsRead: args.mark_as_read }),
      ...(args.delete === true ? { delete: true } : {}),
      ...(forwardTo.length === 0 ? {} : { forwardTo: asRecipients(forwardTo) }),
      ...(redirectTo.length === 0 ? {} : { redirectTo: asRecipients(redirectTo) }),
    };
    if (Object.keys(actions).length === 0) return { deny: "unsupported" };
    const conditions: Record<string, unknown> = {
      ...(from.length === 0 ? {} : { fromAddresses: asRecipients(from) }),
      ...(args.conditions.subject_contains.length === 0
        ? {}
        : { subjectContains: args.conditions.subject_contains }),
      ...(args.conditions.body_contains.length === 0
        ? {}
        : { bodyContains: args.conditions.body_contains }),
    };
    const rule = { displayName: args.name, sequence: 1, isEnabled: true, conditions, actions };
    const outbound = [...forwardTo, ...redirectTo] as string[];
    // A rule is `email.filter`, whatever it does to future mail, as in the
    // spec and for Gmail; one that sends mail out is `email.send` too.
    return {
      args: { rule },
      ...(outbound.length > 0
        ? { action: "email.send", recipients: [...new Set(outbound)], persistence: true }
        : { action: "email.filter" }),
    };
  },
  async run(mailbox, args, signal) {
    const rule = await mailbox.client.createRule(args.rule, signal);
    return { rule_id: rule.id };
  },
  show: done,
});

export const ORGANIZE_TOOLS: Record<string, OutlookTool> = {
  trash,
  archive,
  move,
  delete: deleteMessages,
  set_categories: setCategories,
  create_rule: createRule,
};
