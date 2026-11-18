import { createHash } from "node:crypto";
import { z } from "zod";
import type { Call } from "../../core/call.ts";
import { normalizeAddress, parseAddressList } from "../../core/rules/address.ts";
import { UpstreamError } from "../../gateway/pipeline/ports.ts";
import type { GmailMessage } from "./client.ts";
import type { Mailbox } from "./mailbox.ts";
import { header } from "./messages.ts";
import { composeRaw, rawHeaders } from "./mime.ts";
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
 *   (research §2.1), and heel writes those headers from the checked lists.
 * - Content heel didn't write (a forwarded original, a draft) is pinned by
 *   its SHA-256 at prepare time. `run` reads it again and refuses to send
 *   if it changed, so an approval never covers bytes nobody checked.
 * - `from` must be one of the mailbox's verified send-as addresses, and
 *   there is no default: the agent names it (I-74).
 */

/** An address as the agent gave it, normalized to a lower-case addr-spec. */
const Address = z
  .string()
  .max(320)
  .transform((text, ctx) => {
    const address = normalizeAddress(text);
    if (address === null) {
      ctx.addIssue({ code: "custom", message: "expected an email address" });
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

/**
 * A header's addresses, normalized. One that doesn't parse is kept as
 * written, so the rules' address check denies the call
 * (`address_unparseable`) instead of heel dropping a recipient.
 */
function addressesIn(value: string | null): string[] {
  if (value === null || value.trim() === "") return [];
  return parseAddressList(value) ?? [value];
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Raised from `run` when content changed after heel checked it: nothing was sent. */
function changedSinceChecked(what: string): UpstreamError {
  return new UpstreamError(409, {
    error: `${what} changed after heel checked it; nothing was sent`,
  });
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

/** The threading headers for a message that answers `original` (RFC 5322 §3.6.4). */
function threading(original: GmailMessage) {
  const messageId = header(original, "Message-ID");
  const references = (header(original, "References") ?? "").split(/\s+/).filter((r) => r !== "");
  return {
    thread_id: original.threadId,
    ...(messageId === null ? {} : { in_reply_to: messageId }),
    references: messageId === null ? references : [...references, messageId],
  };
}

async function sendComposed(
  mailbox: Mailbox,
  args: ComposedArgs & Partial<ThreadedArgs>,
  signal: AbortSignal,
  forwarded?: Buffer,
): Promise<Sent> {
  const raw = await composeRaw({
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
  const sent = await mailbox.client.sendMessage({ raw, threadId: args.thread_id }, signal);
  return { id: sent.id, thread_id: sent.threadId };
}

const sent = async (_mailbox: Mailbox, result: unknown) => result;

const send = gmailTool({
  description:
    "Send a new message. `from` must be one of the addresses list_send_as returns. " +
    "Recipients are bare addresses.",
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

function replyTool(all: boolean) {
  return gmailTool({
    description: all
      ? "Reply to everyone on a message: its sender (or Reply-To) and its To and Cc, minus your own addresses."
      : "Reply to a message's sender, or its Reply-To when set. Replying to your own message goes to its To.",
    args: z.strictObject({ message_id: GmailId, from: Address, body: Body, html: Body.optional() }),
    readOnly: false,
    async prepare(mailbox, args, hiding, signal): Promise<Preparation<ThreadedArgs>> {
      const { message, hidden } = await mailbox.target(args.message_id, hiding, signal);
      if (hidden) return { deny: "not_available" };
      const denied = await checkSender(mailbox, args.from, signal);
      if (denied !== null) return denied;
      const own = await mailbox.sendAs(signal);
      const sender = addressesIn(header(message, "From"));
      const replyTo = addressesIn(header(message, "Reply-To"));
      // Answering the mailbox's own message goes back to whom it was sent,
      // as mail clients do; anything else goes to Reply-To, or else From.
      const ownMessage = sender.length > 0 && sender.every((a) => own.has(a));
      const to = ownMessage
        ? addressesIn(header(message, "To"))
        : replyTo.length > 0
          ? replyTo
          : sender;
      const everyone = all
        ? {
            to: unique([...to, ...addressesIn(header(message, "To"))]).filter((a) => !own.has(a)),
            cc: unique(addressesIn(header(message, "Cc"))).filter((a) => !own.has(a)),
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
        args: { message_id: message.id, ...prepared } as ThreadedArgs,
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
  message_id: string;
  /** SHA-256 of the original's raw bytes when heel checked it. */
  forwarded_sha256: string;
}

const forward = gmailTool({
  description:
    "Forward a message, attached whole, to the addresses you name, with your own note above it.",
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
    const raw = await mailbox.client.getRawMessage(message.id, signal);
    return {
      args: {
        ...args,
        message_id: message.id,
        subject: prefixed("Fwd", header(message, "Subject")),
        ...threading(message),
        forwarded_sha256: sha256(Buffer.from(raw.raw, "base64url")),
      },
      action: "email.send",
      recipients: unique([...args.to, ...args.cc, ...args.bcc]),
      targets: [message.id],
    };
  },
  async run(mailbox, args, signal) {
    const raw = Buffer.from(
      (await mailbox.client.getRawMessage(args.message_id, signal)).raw,
      "base64url",
    );
    if (sha256(raw) !== args.forwarded_sha256) throw changedSinceChecked("the forwarded message");
    return sendComposed(mailbox, args, signal, raw);
  },
  show: sent,
});

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
    const raw = await composeRaw({ ...args, text: args.body });
    const draft = await mailbox.client.createDraft({ raw }, signal);
    return { draft_id: draft.id, message_id: draft.message.id };
  },
  show: sent,
});

const updateDraft = gmailTool({
  description: "Replace a draft's whole content.",
  args: z.strictObject({ draft_id: GmailId, ...Composed }),
  readOnly: false,
  async prepare(
    mailbox,
    args,
    _hiding,
    signal,
  ): Promise<Preparation<ComposedArgs & { draft_id: string }>> {
    const denied = await checkSender(mailbox, args.from, signal);
    if (denied !== null) return denied;
    return {
      args,
      action: "email.draft",
      recipients: unique([...args.to, ...args.cc, ...args.bcc]),
    };
  },
  async run(mailbox, args, signal) {
    const raw = await composeRaw({ ...args, text: args.body });
    const draft = await mailbox.client.updateDraft(args.draft_id, { raw }, signal);
    return { draft_id: draft.id, message_id: draft.message.id };
  },
  show: sent,
});

const deleteDraft = gmailTool({
  description: "Delete a draft. Only ever a draft: sent and received mail can't be deleted here.",
  args: z.strictObject({ draft_id: GmailId }),
  readOnly: false,
  prepare: async (_mailbox, args) => ({ args, action: "email.draft" }),
  async run(mailbox, args, signal) {
    await mailbox.client.deleteDraft(args.draft_id, signal);
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
  thread_id: string;
  /** SHA-256 of the draft's raw bytes when heel checked them. */
  raw_sha256: string;
}

const sendDraft = gmailTool({
  description:
    "Send a saved draft exactly as it is now. If the draft changes after heel checks it, nothing is sent.",
  args: z.strictObject({ draft_id: GmailId }),
  readOnly: false,
  async prepare(mailbox, args, _hiding, signal): Promise<Preparation<SendDraftArgs>> {
    const draft = await mailbox.client.getDraft(args.draft_id, signal);
    const raw = Buffer.from(draft.message.raw, "base64url");
    const headers = rawHeaders(raw);
    if (headers === null) return { deny: "lookup_unavailable" };
    const one = (name: string) => headers.get(name)?.join(", ") ?? null;
    const from = normalizeAddress(one("from") ?? "");
    if (from === null) return { deny: "sender_not_allowed" };
    const denied = await checkSender(mailbox, from, signal);
    if (denied !== null) return denied;
    const to = addressesIn(one("to"));
    const cc = addressesIn(one("cc"));
    const bcc = addressesIn(one("bcc"));
    if (to.length + cc.length + bcc.length === 0) return { deny: "unsupported" };
    return {
      args: {
        draft_id: draft.id,
        from,
        to,
        cc,
        bcc,
        subject: (one("subject") ?? "").replace(/[\r\n]+/g, " "),
        thread_id: draft.message.threadId,
        raw_sha256: sha256(raw),
      },
      action: "email.send",
      recipients: unique([...to, ...cc, ...bcc]),
    };
  },
  async run(mailbox, args, signal) {
    const draft = await mailbox.client.getDraft(args.draft_id, signal);
    const raw = Buffer.from(draft.message.raw, "base64url");
    if (sha256(raw) !== args.raw_sha256) throw changedSinceChecked("the draft");
    // The checked bytes, through messages.send: drafts.send would send
    // whatever the draft holds by then (research §7, gap 1).
    const message = await mailbox.client.sendMessage(
      { raw: draft.message.raw, threadId: args.thread_id },
      signal,
    );
    try {
      await mailbox.client.deleteDraft(args.draft_id, signal);
    } catch {
      // The message went; a draft left behind is untidy, not a failure.
    }
    return { id: message.id, thread_id: message.threadId };
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
  const own = await mailbox.sendAs(signal);
  const allowed = new Set<string>();
  for (const message of thread.messages) {
    const from = normalizeAddress(header(message, "From") ?? "");
    const sentByMailbox = message.labelIds.includes("SENT") || (from !== null && own.has(from));
    if (!sentByMailbox) continue;
    for (const name of ["To", "Cc", "Bcc"]) {
      for (const address of parseAddressList(header(message, name) ?? "") ?? []) {
        allowed.add(address);
      }
    }
  }
  return recipients.every((r) => allowed.has(r)) ? "pass" : "fail";
}
