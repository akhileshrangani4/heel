import { z } from "zod";
import type { MailTool } from "../mail/tool.ts";
import type { OutlookMailbox } from "./messages.ts";

export type { Preparation } from "../mail/tool.ts";

/** An Outlook tool: a mail tool row over Outlook's per-call mailbox (see `../mail/tool.ts`). */
export type OutlookTool = MailTool<OutlookMailbox>;

/** Keeps each tool's own types while the table holds them all. */
export function outlookTool<S extends z.ZodType, P, R>(
  tool: MailTool<OutlookMailbox, S, P, R>,
): OutlookTool {
  return tool as unknown as OutlookTool;
}

/** A Graph message, conversation, draft or folder id (immutable ids are base64-like). */
export const OutlookId = z.string().regex(/^[A-Za-z0-9_=+/-]{1,512}$/, "expected an Outlook id");
