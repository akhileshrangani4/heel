import { z } from "zod";
import { type ToolRow, toolRow } from "../tool-table.ts";
import type { Mailbox } from "./mailbox.ts";

export type { Preparation, Prepared } from "../tool-table.ts";

/** A Gmail tool: a tool row over Gmail's per-call `Mailbox` (see `../tool-table.ts`). */
export type GmailTool = ToolRow<Mailbox>;

export const gmailTool = toolRow<Mailbox>();

/** A Gmail message, thread or draft id. */
export const GmailId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, "expected a Gmail id");
