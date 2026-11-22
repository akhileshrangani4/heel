import { z } from "zod";
import type { Call } from "../../core/call.ts";
import {
  Address,
  Addresses,
  Body,
  Composed,
  type ComposedArgs,
  composeOrRefuse,
  MESSAGE_ID,
  notSent,
  prefixed,
  sha256,
  unique,
} from "../mail/compose.ts";
import { draftEnvelope } from "../mail/mime.ts";
import type { Preparation } from "../mail/tool.ts";
import { OutlookError, type OutlookMessage, OutlookNotFoundError } from "./client.ts";
import { messageBody, type OutlookMailbox, plainRecipients } from "./messages.ts";
import { OutlookId, type OutlookTool, outlookTool } from "./tool.ts";

/**
 * Outlook's sending tools (D9b), built the same way as Gmail's (see
 * `../gmail/send.ts` for the reasoning):
 *
 * - heel derives every recipient itself and composes the MIME itself, then
 *   sends it with `sendMail`, which takes the recipients from the MIME's
 *   headers (graph-research §3). Graph's own reply and forward endpoints
 *   fill recipients in ways its docs don't pin down, so heel doesn't use
 *   them.
 * - `composeRaw` reads the headers back and refuses to send if they differ
 *   from the checked lists.
 * - A forwarded original or a draft is shown to the approver as text and
 *   pinned by the SHA-256 of its MIME; `run` reads it again and refuses to
 *   send if it changed.
 * - `from` must be the mailbox's own address (spec: Email, `send`).
 * - Only messages in Sent Items count as the mailbox's own.
 */

interface ThreadedArgs extends ComposedArgs {
  message_id: string;
  /** The conversation, for `all_in_thread`. */
  thread_id: string;
  in_reply_to?: string | undefined;
  references: string[];
}

const sent = async (_mailbox: OutlookMailbox, result: unknown) => result;

function checkSender(mailbox: OutlookMailbox, from: string): { deny: "sender_not_allowed" } | null {
  return from === mailbox.address ? null : { deny: "sender_not_allowed" };
}

/** Reads `run` makes before sending fail as "not sent", never as "outcome unknown". */
async function beforeSending<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof OutlookNotFoundError) throw notSent("the message is gone", 404);
    if (error instanceof OutlookError) throw notSent("Outlook couldn't be read", 502);
    throw error;
  }
}

function threading(original: OutlookMessage) {
  const id = original.internetMessageId?.trim() ?? null;
  const valid = id !== null && MESSAGE_ID.test(id) ? id : null;
  return {
    message_id: original.id,
    thread_id: original.conversationId,
    ...(valid === null ? {} : { in_reply_to: valid }),
    references: valid === null ? [] : [valid],
  };
}

async function sendComposed(
  mailbox: OutlookMailbox,
  args: ComposedArgs & Partial<ThreadedArgs>,
  signal: AbortSignal,
  forwarded?: Buffer,
): Promise<{ sent: true }> {
  const raw = await composeOrRefuse({
    from: args.from,
    to: args.to,
    cc: args.cc,
    bcc: args.bcc,
    subject: args.subject,
    text: args.body,
    html: args.html,
    inReplyTo: args.in_reply_to,
    references: args.references,
    forwarded,
  });
  // sendMail takes base64 of the MIME bytes; composeRaw gives base64url.
  await mailbox.client.sendMime(Buffer.from(raw, "base64url").toString("base64"), signal);
  return { sent: true };
}

/**
 * A message's readable text and the hash of its MIME, read so the two
 * describe the same version: MIME, then text, then MIME again. Null when it
 * changed in between.
 */
async function pinnedText(mailbox: OutlookMailbox, id: string, signal: AbortSignal) {
  const before = await mailbox.client.getMime(id, signal);
  const body = messageBody(await mailbox.client.getMessage(id, signal));
  const after = await mailbox.client.getMime(id, signal);
  if (sha256(before) !== sha256(after)) return null;
  const text =
    body.unreadable === undefined
      ? body.body
      : `[heel couldn't read this body: ${body.unreadable}]`;
  return { text, sha256: sha256(after), mime: after };
}

const send = outlookTool({
  returns: '{"sent"}',
  description: "Send a new message from this mailbox's address. Recipients are plain addresses.",
  args: z.strictObject(Composed),
  readOnly: false,
  async prepare(mailbox, args): Promise<Preparation<ComposedArgs>> {
    const denied = checkSender(mailbox, args.from);
    if (denied !== null) return denied;
    return {
      args,
      action: "email.send",
      recipients: unique([...args.to, ...args.cc, ...args.bcc]),
    };
  },
  run: (mailbox, args, signal) => sendComposed(mailbox, args, signal),
  show: sent,
});

function replyTool(all: boolean) {
  return outlookTool({
    returns: '{"sent"}',
    description: all
      ? "Reply to everyone on a message: its sender (or Reply-To) and its To and Cc, minus this mailbox."
      : "Reply to a message's sender, or its Reply-To when set. Replying to your own sent message goes to its To.",
    args: z.strictObject({
      message_id: OutlookId,
      from: Address,
      body: Body,
      html: Body.optional(),
    }),
    readOnly: false,
    async prepare(mailbox, args, hiding, signal): Promise<Preparation<ThreadedArgs>> {
      const { message, hidden } = await mailbox.target(args.message_id, hiding, signal);
      if (hidden) return { deny: "not_available" };
      const denied = checkSender(mailbox, args.from);
      if (denied !== null) return denied;
      const sender = plainRecipients(message.from ? [message.from] : []);
      const replyTo = plainRecipients(message.replyTo);
      const origTo = plainRecipients(message.toRecipients);
      const origCc = plainRecipients(message.ccRecipients);
      if (sender === null || replyTo === null || origTo === null || origCc === null) {
        return { deny: "address_unparseable" };
      }
      const own = (a: string) => a === mailbox.address;
      const to = (await mailbox.sentByMailbox(message, signal))
        ? origTo
        : replyTo.length > 0
          ? replyTo
          : sender;
      const everyone = all
        ? {
            to: unique([...to, ...origTo]).filter((a) => !own(a)),
            cc: unique(origCc).filter((a) => !own(a)),
          }
        : { to: unique(to).filter((a) => !own(a)), cc: [] };
      const cc = everyone.cc.filter((a) => !everyone.to.includes(a));
      if (everyone.to.length === 0 && cc.length === 0) return { deny: "unsupported" };
      const prepared: ThreadedArgs = {
        from: args.from,
        to: everyone.to,
        cc,
        bcc: [],
        subject: prefixed("Re", message.subject),
        body: args.body,
        ...(args.html === undefined ? {} : { html: args.html }),
        ...threading(message),
      };
      return {
        args: prepared,
        action: "email.send",
        recipients: unique([...prepared.to, ...prepared.cc]),
        targets: [message.id],
      };
    },
    run: (mailbox, args, signal) => sendComposed(mailbox, args, signal),
    show: sent,
  });
}

interface ForwardArgs extends ThreadedArgs {
  forwarded_text: string;
  forwarded_sha256: string;
}

const forward = outlookTool({
  returns: '{"sent"}',
  description:
    "Forward a message, attached whole (without its Bcc), to the addresses you name, with your own note above it.",
  args: z.strictObject({
    message_id: OutlookId,
    from: Address,
    to: Addresses.min(1),
    cc: Addresses.default([]),
    bcc: Addresses.default([]),
    body: Body.default(""),
    html: Body.optional(),
  }),
  readOnly: false,
  async prepare(mailbox, args, hiding, signal): Promise<Preparation<ForwardArgs>> {
    const { message, hidden } = await mailbox.target(args.message_id, hiding, signal);
    if (hidden) return { deny: "not_available" };
    const denied = checkSender(mailbox, args.from);
    if (denied !== null) return denied;
    const pinned = await pinnedText(mailbox, message.id, signal);
    if (pinned === null) return { deny: "lookup_unavailable" };
    return {
      args: {
        ...args,
        subject: prefixed("Fwd", message.subject),
        ...threading(message),
        forwarded_text: pinned.text,
        forwarded_sha256: pinned.sha256,
      },
      action: "email.send",
      recipients: unique([...args.to, ...args.cc, ...args.bcc]),
      targets: [message.id],
    };
  },
  async run(mailbox, args, signal) {
    const mime = await beforeSending(() => mailbox.client.getMime(args.message_id, signal));
    if (sha256(mime) !== args.forwarded_sha256) {
      throw notSent("the forwarded message changed after heel checked it");
    }
    return sendComposed(mailbox, args, signal, mime);
  },
  show: sent,
});

const createDraft = outlookTool({
  returns: '{"draft_id"}',
  description: "Save a draft. Drafts never send anything; send one later with send_draft.",
  args: z.strictObject(Composed),
  readOnly: false,
  async prepare(mailbox, args): Promise<Preparation<ComposedArgs>> {
    const denied = checkSender(mailbox, args.from);
    if (denied !== null) return denied;
    return {
      args,
      action: "email.draft",
      recipients: unique([...args.to, ...args.cc, ...args.bcc]),
    };
  },
  async run(mailbox, args, signal) {
    const raw = await composeOrRefuse({ ...args, text: args.body });
    const draft = await mailbox.client.createDraftMime(
      Buffer.from(raw, "base64url").toString("base64"),
      signal,
    );
    return { draft_id: draft.id };
  },
  show: sent,
});

/** Reads a draft a call is aimed at: refused like a missing one when hidden, or not a draft. */
async function targetDraft(
  mailbox: OutlookMailbox,
  draftId: string,
  hiding: Parameters<OutlookTool["prepare"]>[2],
  signal: AbortSignal,
) {
  const { message, hidden } = await mailbox.target(draftId, hiding, signal);
  return { draft: message, refused: hidden || !message.isDraft };
}

const recipients = (list: readonly string[]) =>
  list.map((address) => ({ emailAddress: { address } }));

const updateDraft = outlookTool({
  returns: '{"draft_id"}',
  description: "Replace a draft's addresses, subject and text.",
  args: z.strictObject({ draft_id: OutlookId, ...Composed }),
  readOnly: false,
  async prepare(
    mailbox,
    args,
    hiding,
    signal,
  ): Promise<Preparation<ComposedArgs & { draft_id: string }>> {
    const { draft, refused } = await targetDraft(mailbox, args.draft_id, hiding, signal);
    if (refused) return { deny: "not_available" };
    const denied = checkSender(mailbox, args.from);
    if (denied !== null) return denied;
    return {
      args,
      action: "email.draft",
      recipients: unique([...args.to, ...args.cc, ...args.bcc]),
      targets: [draft.id],
    };
  },
  async run(mailbox, args, signal) {
    await mailbox.client.patchMessage(
      args.draft_id,
      {
        subject: args.subject,
        body:
          args.html === undefined
            ? { contentType: "text", content: args.body }
            : { contentType: "html", content: args.html },
        toRecipients: recipients(args.to),
        ccRecipients: recipients(args.cc),
        bccRecipients: recipients(args.bcc),
      },
      signal,
    );
    return { draft_id: args.draft_id };
  },
  show: sent,
});

const deleteDraft = outlookTool({
  returns: '{"deleted"} (the draft id)',
  description: "Delete a draft. Only ever a draft: other mail is refused here.",
  args: z.strictObject({ draft_id: OutlookId }),
  readOnly: false,
  async prepare(mailbox, args, hiding, signal) {
    const { draft, refused } = await targetDraft(mailbox, args.draft_id, hiding, signal);
    if (refused) return { deny: "not_available" as const };
    return { args, action: "email.draft", targets: [draft.id] };
  },
  async run(mailbox, args, signal) {
    await mailbox.client.deleteMessage(args.draft_id, signal);
    return { deleted: args.draft_id };
  },
  show: sent,
});

interface SendDraftArgs {
  draft_id: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  thread_id: string;
  mime_sha256: string;
}

const sendDraft = outlookTool({
  returns: '{"sent"}',
  description:
    "Send a saved draft exactly as it is now. If the draft changes after heel checks it, nothing is sent.",
  args: z.strictObject({ draft_id: OutlookId }),
  readOnly: false,
  async prepare(mailbox, args, hiding, signal): Promise<Preparation<SendDraftArgs>> {
    const { draft, refused } = await targetDraft(mailbox, args.draft_id, hiding, signal);
    if (refused) return { deny: "not_available" };
    const pinned = await pinnedText(mailbox, draft.id, signal);
    if (pinned === null) return { deny: "lookup_unavailable" };
    const envelope = draftEnvelope(pinned.mime);
    if (envelope === null) return { deny: "address_unparseable" };
    const denied = checkSender(mailbox, envelope.from);
    if (denied !== null) return denied;
    const all = unique([...envelope.to, ...envelope.cc, ...envelope.bcc]);
    if (all.length === 0) return { deny: "unsupported" };
    return {
      args: {
        draft_id: draft.id,
        ...envelope,
        body: pinned.text,
        thread_id: draft.conversationId,
        mime_sha256: pinned.sha256,
      },
      action: "email.send",
      recipients: all,
      targets: [draft.id],
    };
  },
  async run(mailbox, args, signal) {
    const mime = await beforeSending(() => mailbox.client.getMime(args.draft_id, signal));
    if (sha256(mime) !== args.mime_sha256) throw notSent("the draft changed after heel checked it");
    // The checked bytes, through sendMail: the draft's own /send would send
    // whatever it holds by then.
    await mailbox.client.sendMime(mime.toString("base64"), signal);
    try {
      await mailbox.client.deleteMessage(args.draft_id, signal);
    } catch {
      // The message went; a draft left behind is untidy, not a failure.
    }
    return { sent: true };
  },
  show: sent,
});

export const SEND_TOOLS: Record<string, OutlookTool> = {
  send,
  reply: replyTool(false),
  reply_all: replyTool(true),
  forward,
  create_draft: createDraft,
  update_draft: updateDraft,
  delete_draft: deleteDraft,
  send_draft: sendDraft,
};

/**
 * `all_in_thread` (spec: State checks; I-21) for Outlook: every recipient
 * must be on a message of the call's conversation that sits in Sent Items.
 * A call with no conversation or no recipients fails.
 */
export async function allInThread(
  mailbox: OutlookMailbox,
  call: Call,
  signal: AbortSignal,
): Promise<"pass" | "fail"> {
  const conversationId = (call.args as { thread_id?: unknown }).thread_id;
  const wanted = call.recipients ?? [];
  if (typeof conversationId !== "string" || conversationId === "" || wanted.length === 0) {
    return "fail";
  }
  const sentMessages = await mailbox.client.listConversation(conversationId, "sentitems", signal);
  const allowed = new Set<string>();
  for (const message of sentMessages) {
    if (message.isDraft) continue;
    for (const list of [message.toRecipients, message.ccRecipients, message.bccRecipients]) {
      for (const address of plainRecipients(list) ?? []) allowed.add(address);
    }
  }
  return wanted.every((r) => allowed.has(r)) ? "pass" : "fail";
}
