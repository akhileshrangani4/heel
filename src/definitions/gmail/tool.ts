import { z } from "zod";
import type { MailTool } from "../mail/tool.ts";
import type { Mailbox } from "./mailbox.ts";

export type { Preparation, Prepared } from "../mail/tool.ts";

/** A Gmail tool: a mail tool row over Gmail's per-call `Mailbox` (see `../mail/tool.ts`). */
export type GmailTool = MailTool<Mailbox>;

/** Keeps each tool's own types while the table holds them all. */
export function gmailTool<S extends z.ZodType, P, R>(tool: MailTool<Mailbox, S, P, R>): GmailTool {
  return tool as unknown as GmailTool;
}

/** A Gmail message, thread or draft id. */
export const GmailId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, "expected a Gmail id");
