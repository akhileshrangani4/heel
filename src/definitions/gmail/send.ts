import { createHash } from "node:crypto";
import { z } from "zod";
import type { Call } from "../../core/call.ts";
import { isPlainAddress, normalizeAddress, parseAddressList } from "../../core/rules/address.ts";
import { UpstreamError } from "../../gateway/pipeline/ports.ts";
import { GmailError, type GmailMessage, GmailNotFoundError } from "./client.ts";
import type { Mailbox } from "./mailbox.ts";
import { header, type MessageContent, messageContent } from "./messages.ts";
import {
  ComposeMismatchError,
  composeRaw,
  DELIVERY_HEADERS_REFUSED,
  rawHeaders,
  strictAddressList,
} from "./mime.ts";
import { GmailId, type GmailTool, gmailTool, type Preparation } from "./tool.ts";

/**
 * Gmail's sending tools (D9a-2): `email.send` for send, reply, reply_all,
 * forward and send_draft; `email.draft` for the draft tools (spec: Email,
 * "Gmail and Outlook").
 *
 * How heel keeps what it checks and what Gmail sends the same:
 * - `prepare` derives every recipient itself, from the original message for
 *   a reply and from the draft's own headers for `send_draft`, and puts them
 *   in the call's arguments. Rules, the call hash and the approval page all
 *   see those arguments, and `run` builds the message from them alone.
 * - Gmail sends to exactly the To, Cc and Bcc headers of the raw message
 *   (research §2.1). heel sends only to plain addresses, and `composeRaw`
 *   reads the headers back and refuses to send if they differ.
 * - Content heel didn't write (a forwarded original, a draft) is shown to
 *   the approver as text and pinned by its SHA-256. `run` reads it again and
 *   refuses to send if it changed, so an approval never covers bytes nobody
 *   saw.
 * - `from` must be one of the mailbox's verified send-as addresses, and
 *   there is no default: the agent names it (I-74).
 * - Only messages Gmail labels SENT count as the mailbox's own. A From
 *   header can be forged by anyone, and a draft hasn't been sent.
 */

/** An address as the agent gave it: a plain addr-spec, lower-cased. */
const Address = z
  .string()
  .max(320)
  .transform((text, ctx) => {
    const address = normalizeAddress(text);
    if (address === null || !isPlainAddress(address)) {
      ctx.addIssue({ code: "custom", message: "expected a plain email address" });
      return z.NEVER;
    }
    return address;
  });

const Addresses = z.array(Address).max(100);

/** Text that goes into a header: one line. */
const HeaderText = z
  .string()
  .max(998)
  .regex(/^[^\r\n]*$/, "must be one line");

const Body = z.string().max(1_000_000);

const Composed = {
  from: Address,
  to: Addresses.min(1),
  cc: Addresses.default([]),
  bcc: Addresses.default([]),
  subject: HeaderText,
  body: Body,
  html: Body.optional(),
};

/** A message heel composes, exactly as it will run. */
interface ComposedArgs {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  html?: string | undefined;
}

interface ThreadedArgs extends ComposedArgs {
  message_id: string;
  thread_id: string;
  in_reply_to?: string | undefined;
  references: string[];
}

/** What a send returns to the agent. */
interface Sent {
  id: string;
  thread_id: string;
}

function unique(addresses: readonly string[]): string[] {
  return [...new Set(addresses)];
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A failure in `run` before anything was posted: the call's outcome is known. */
function notSent(reason: string, status = 409): UpstreamError {
  return new UpstreamError(status, { error: `${reason}; nothing was sent` });
}

/** Reads `run` makes before sending fail as "not sent", never as "outcome unknown". */
async function beforeSending<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof GmailNotFoundError) throw notSent("the message is gone", 404);
    if (error instanceof GmailError) throw notSent("Gmail couldn't be read", 502);
    throw error;
  }
}

/** Gmail labels a message SENT once the mailbox has sent it; drafts carry DRAFT instead. */
function sentByMailbox(message: GmailMessage): boolean {
  return message.labelIds.includes("SENT") && !message.labelIds.includes("DRAFT");
}

async function checkSender(
  mailbox: Mailbox,
  from: string,
  signal: AbortSignal,
): Promise<{ deny: "sender_not_allowed" } | null> {
  return (await mailbox.sendAs(signal)).has(from) ? null : { deny: "sender_not_allowed" };
}

function prefixed(prefix: "Re" | "Fwd", subject: string | null): string {
  const text = (subject ?? "").replace(/[\r\n]+/g, " ");
  return new RegExp(`^${prefix}:`, "i").test(text) ? text : `${prefix}: ${text}`;
}

const MESSAGE_ID = /^<[^<>\s]+>$/;

/** The threading headers for a message that answers `original` (RFC 5322 §3.6.4). */
function threading(original: GmailMessage) {
  const messageId = header(original, "Message-ID")?.trim() ?? null;
  const valid = messageId !== null && MESSAGE_ID.test(messageId) ? messageId : null;
  const references = (header(original, "References") ?? "")
    .split(/\s+/)
    .filter((r) => MESSAGE_ID.test(r));
  return {
    message_id: original.id,
    thread_id: original.threadId,
    ...(valid === null ? {} : { in_reply_to: valid }),
    references: valid === null ? references : [...references, valid],
  };
}

async function sendComposed(
  mailbox: Mailbox,
  args: ComposedArgs & Partial<ThreadedArgs>,
  signal: AbortSignal,
  forwarded?: Buffer,
): Promise<Sent> {
  let raw: string;
  try {
    raw = await composeRaw({
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
  } catch (error) {
    if (error instanceof ComposeMismatchError) throw notSent(error.message, 422);
    throw error;
  }
  const sent = await mailbox.client.sendMessage({ raw, threadId: args.thread_id }, signal);
  return { id: sent.id, thread_id: sent.threadId };
}

const sent = async (_mailbox: Mailbox, result: unknown) => result;

const send = gmailTool({
  description:
    "Send a new message. `from` must be one of the addresses list_send_as returns. " +
    "Recipients are plain addresses.",
  args: z.strictObject(Composed),
  readOnly: false,
  async prepare(mailbox, args, _hiding, signal): Promise<Preparation<ComposedArgs>> {
    const denied = await checkSender(mailbox, args.from, signal);
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

/** A header's addresses for a derived recipient list; null when any part isn't one plain mailbox. */
function derived(message: GmailMessage, name: string): string[] | null {
  const value = header(message, name);
  if (value === null || value.trim() === "") return [];
  return strictAddressList(value);
}

function replyTool(all: boolean) {
  return gmailTool({
    description: all
      ? "Reply to everyone on a message: its sender (or Reply-To) and its To and Cc, minus your own addresses."
      : "Reply to a message's sender, or its Reply-To when set. Replying to your own sent message goes to its To.",
    args: z.strictObject({ message_id: GmailId, from: Address, body: Body, html: Body.optional() }),
    readOnly: false,
    async prepare(mailbox, args, hiding, signal): Promise<Preparation<ThreadedArgs>> {
      const { message, hidden } = await mailbox.target(args.message_id, hiding, signal);
      if (hidden) return { deny: "not_available" };
      const denied = await checkSender(mailbox, args.from, signal);
      if (denied !== null) return denied;
      const own = await mailbox.sendAs(signal);
      const [sender, replyTo, origTo, origCc] = ["From", "Reply-To", "To", "Cc"].map((name) =>
        derived(message, name),
      );
      // A header heel can't read plainly decides where a reply goes: refuse.
      if (sender == null || replyTo == null || origTo == null || origCc == null) {
        return { deny: "address_unparseable" };
      }
      // Answering a message the mailbox sent goes back to whom it was sent,
      // as mail clients do; anything else goes to Reply-To, or else From.
      const to = sentByMailbox(message) ? origTo : replyTo.length > 0 ? replyTo : sender;
      const everyone = all
        ? {
            to: unique([...to, ...origTo]).filter((a) => !own.has(a)),
            cc: unique(origCc).filter((a) => !own.has(a)),
          }
        : { to: unique(to), cc: [] };
      // Someone on both lines gets the message once, on To.
      const cc = everyone.cc.filter((a) => !everyone.to.includes(a));
      if (everyone.to.length === 0 && cc.length === 0) return { deny: "unsupported" };
      const prepared: ThreadedArgs = {
        from: args.from,
        to: everyone.to,
        cc,
        bcc: [],
        subject: prefixed("Re", header(message, "Subject")),
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
  /** The forwarded message's text, HTML and attachments, so the approver sees what goes out. */
  forwarded_text: string;
  forwarded_html: string | null;
  forwarded_attachments: string[];
  /** SHA-256 of the original's raw bytes when heel checked it. */
  forwarded_sha256: string;
}

const forward = gmailTool({
  description:
    "Forward a message, attached whole (without its Bcc), to the addresses you name, with your own note above it.",
  args: z.strictObject({
    message_id: GmailId,
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
    const denied = await checkSender(mailbox, args.from, signal);
    if (denied !== null) return denied;
    const pinned = await pinnedContent(mailbox, message.id, signal);
    if (pinned === null) return { deny: "lookup_unavailable" };
    return {
      args: {
        ...args,
        subject: prefixed("Fwd", header(message, "Subject")),
        ...threading(message),
        forwarded_text: pinned.content.text,
        forwarded_html: pinned.content.html,
        forwarded_attachments: pinned.content.attachments,
        forwarded_sha256: pinned.sha256,
      },
      action: "email.send",
      recipients: unique([...args.to, ...args.cc, ...args.bcc]),
      targets: [message.id],
    };
  },
  async run(mailbox, args, signal) {
    const raw = await beforeSending(async () =>
      Buffer.from((await mailbox.client.getRawMessage(args.message_id, signal)).raw, "base64url"),
    );
    if (sha256(raw) !== args.forwarded_sha256) {
      throw notSent("the forwarded message changed after heel checked it");
    }
    return sendComposed(mailbox, args, signal, raw);
  },
  show: sent,
});

/**
 * What a message says (text, HTML, attachment names) and the hash of its
 * raw bytes, read so the two describe the same version: raw, then content,
 * then raw again. Null when the message changed in between.
 */
async function pinnedContent(
  mailbox: Mailbox,
  messageId: string,
  signal: AbortSignal,
): Promise<{ content: MessageContent; sha256: string; raw: Buffer } | null> {
  const readRaw = async () =>
    Buffer.from((await mailbox.client.getRawMessage(messageId, signal)).raw, "base64url");
  const before = await readRaw();
  const content = messageContent(await mailbox.client.getMessage(messageId, "full", signal));
  const after = await readRaw();
  if (sha256(before) !== sha256(after)) return null;
  return { content, sha256: sha256(after), raw: after };
}

const createDraft = gmailTool({
  description: "Save a draft. Drafts never send anything; send one later with send_draft.",
  args: z.strictObject(Composed),
  readOnly: false,
  async prepare(mailbox, args, _hiding, signal): Promise<Preparation<ComposedArgs>> {
    const denied = await checkSender(mailbox, args.from, signal);
    if (denied !== null) return denied;
    return {
      args,
      action: "email.draft",
      recipients: unique([...args.to, ...args.cc, ...args.bcc]),
    };
  },
  async run(mailbox, args, signal) {
    const raw = await composeOrRefuse({ ...args, text: args.body });
    const draft = await mailbox.client.createDraft({ raw }, signal);
    return { draft_id: draft.id, message_id: draft.message.id };
  },
  show: sent,
});

async function composeOrRefuse(message: Parameters<typeof composeRaw>[0]): Promise<string> {
  try {
    return await composeRaw(message);
  } catch (error) {
    if (error instanceof ComposeMismatchError) throw notSent(error.message, 422);
    throw error;
  }
}

/**
 * Reads a draft a call is aimed at and checks hiding on it, as for any
 * by-id call (I-42): a hidden draft is refused like a missing one.
 */
async function targetDraft(
  mailbox: Mailbox,
  draftId: string,
  hiding: Parameters<GmailTool["prepare"]>[2],
  signal: AbortSignal,
) {
  const draft = await mailbox.client.getDraft(draftId, signal);
  const { hidden } = await mailbox.target(draft.message.id, hiding, signal);
  return { draft, hidden };
}

const updateDraft = gmailTool({
  description: "Replace a draft's whole content.",
  args: z.strictObject({ draft_id: GmailId, ...Composed }),
  readOnly: false,
  async prepare(
    mailbox,
    args,
    hiding,
    signal,
  ): Promise<Preparation<ComposedArgs & { draft_id: string }>> {
    const { draft, hidden } = await targetDraft(mailbox, args.draft_id, hiding, signal);
    if (hidden) return { deny: "not_available" };
    const denied = await checkSender(mailbox, args.from, signal);
    if (denied !== null) return denied;
    return {
      args,
      action: "email.draft",
      recipients: unique([...args.to, ...args.cc, ...args.bcc]),
      targets: [draft.message.id],
    };
  },
  async run(mailbox, args, signal) {
    const raw = await composeOrRefuse({ ...args, text: args.body });
    const draft = await mailbox.client.updateDraft(args.draft_id, { raw }, signal);
    return { draft_id: draft.id, message_id: draft.message.id };
  },
  show: sent,
});

const deleteDraft = gmailTool({
  description: "Delete a draft. Only ever a draft: sent and received mail can't be deleted here.",
  args: z.strictObject({ draft_id: GmailId }),
  readOnly: false,
  async prepare(mailbox, args, hiding, signal) {
    const { draft, hidden } = await targetDraft(mailbox, args.draft_id, hiding, signal);
    if (hidden) return { deny: "not_available" as const };
    return { args, action: "email.draft", targets: [draft.message.id] };
  },
  async run(mailbox, args, signal) {
    await mailbox.client.deleteDraft(args.draft_id, signal);
    return { deleted: args.draft_id };
  },
  show: sent,
});

interface SendDraftArgs {
  draft_id: string;
  /** The draft's current message; Gmail gives a draft a new one on every update. */
  draft_message_id: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  /** The draft's text, HTML and attachments, so the approver sees what goes out. */
  body: string;
  html: string | null;
  attachments: string[];
  thread_id: string;
  /** SHA-256 of the draft's raw bytes when heel checked them. */
  raw_sha256: string;
}

/**
 * Who a draft sends to and from, read strictly from its own headers. Null
 * when anything could be read two ways: a header heel can't parse plainly,
 * a repeated From, To, Cc or Bcc, or a header that changes delivery.
 */
function draftEnvelope(raw: Buffer) {
  const headers = rawHeaders(raw);
  if (headers === null) return null;
  if ([...headers.keys()].some((name) => DELIVERY_HEADERS_REFUSED.test(name))) return null;
  const single = (name: string): string[] | null => {
    const values = headers.get(name) ?? [];
    if (values.length > 1) return null;
    // Bytes outside ASCII would be read as latin1 here and as UTF-8 elsewhere.
    if (values.some((value) => [...value].some((c) => c.charCodeAt(0) > 0x7f))) return null;
    return values.length === 0 ? [] : strictAddressList(values[0] ?? "");
  };
  const from = single("from");
  const to = single("to");
  const cc = single("cc");
  const bcc = single("bcc");
  if (from === null || from.length !== 1 || to === null || cc === null || bcc === null) return null;
  const subject = (headers.get("subject") ?? []).join(" ");
  return { from: from[0] as string, to, cc, bcc, subject };
}

const sendDraft = gmailTool({
  description:
    "Send a saved draft exactly as it is now. If the draft changes after heel checks it, nothing is sent.",
  args: z.strictObject({ draft_id: GmailId }),
  readOnly: false,
  async prepare(mailbox, args, hiding, signal): Promise<Preparation<SendDraftArgs>> {
    const { draft, hidden } = await targetDraft(mailbox, args.draft_id, hiding, signal);
    if (hidden) return { deny: "not_available" };
    const pinned = await pinnedContent(mailbox, draft.message.id, signal);
    if (pinned === null) return { deny: "lookup_unavailable" };
    const envelope = draftEnvelope(pinned.raw);
    if (envelope === null) return { deny: "address_unparseable" };
    const denied = await checkSender(mailbox, envelope.from, signal);
    if (denied !== null) return denied;
    const recipients = unique([...envelope.to, ...envelope.cc, ...envelope.bcc]);
    if (recipients.length === 0) return { deny: "unsupported" };
    return {
      args: {
        draft_id: draft.id,
        draft_message_id: draft.message.id,
        ...envelope,
        body: pinned.content.text,
        html: pinned.content.html,
        attachments: pinned.content.attachments,
        thread_id: draft.message.threadId,
        raw_sha256: pinned.sha256,
      },
      action: "email.send",
      recipients,
      targets: [draft.message.id],
    };
  },
  async run(mailbox, args, signal) {
    // The same source prepare hashed. An updated draft has a new message, so
    // the old one is gone and nothing is sent.
    const message = await beforeSending(() =>
      mailbox.client.getRawMessage(args.draft_message_id, signal),
    );
    if (sha256(Buffer.from(message.raw, "base64url")) !== args.raw_sha256) {
      throw notSent("the draft changed after heel checked it");
    }
    // The checked bytes, through messages.send: drafts.send would send
    // whatever the draft holds by then (research §7, gap 1).
    const sentMessage = await mailbox.client.sendMessage(
      { raw: message.raw, threadId: args.thread_id },
      signal,
    );
    try {
      await mailbox.client.deleteDraft(args.draft_id, signal);
    } catch {
      // The message went; a draft left behind is untidy, not a failure.
    }
    return { id: sentMessage.id, thread_id: sentMessage.threadId };
  },
  show: sent,
});

export const SEND_TOOLS: Record<string, GmailTool> = {
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
 * `all_in_thread` (spec: State checks; I-21): passes when every recipient
 * was on a message this mailbox sent in the call's thread. A call with no
 * thread, a thread the mailbox never sent in, or no recipients fails.
 *
 * Only messages labelled SENT count. The spec also counts a From in
 * `sendAs.list`, but anyone can write that From on mail to you, and a draft
 * carries it too, so heel doesn't.
 */
export async function allInThread(
  mailbox: Mailbox,
  call: Call,
  signal: AbortSignal,
): Promise<"pass" | "fail"> {
  const threadId = (call.args as { thread_id?: unknown }).thread_id;
  const recipients = call.recipients ?? [];
  if (typeof threadId !== "string" || recipients.length === 0) return "fail";
  const thread = await mailbox.client.getThread(threadId, "metadata", signal);
  const allowed = new Set<string>();
  for (const message of thread.messages) {
    if (!sentByMailbox(message)) continue;
    for (const name of ["To", "Cc", "Bcc"]) {
      for (const address of parseAddressList(header(message, name) ?? "") ?? []) {
        allowed.add(address);
      }
    }
  }
  return recipients.every((r) => allowed.has(r)) ? "pass" : "fail";
}
