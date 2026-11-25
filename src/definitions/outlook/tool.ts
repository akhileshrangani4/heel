import { z } from "zod";
import { type ToolRow, toolRow } from "../tool-table.ts";
import type { OutlookMailbox } from "./messages.ts";

export type { Preparation } from "../tool-table.ts";

/** An Outlook tool: a tool row over Outlook's per-call mailbox (see `../tool-table.ts`). */
export type OutlookTool = ToolRow<OutlookMailbox>;

export const outlookTool = toolRow<OutlookMailbox>();

/** A Graph message, conversation, draft or folder id (immutable ids are base64-like). */
export const OutlookId = z.string().regex(/^[A-Za-z0-9_=+/-]{1,512}$/, "expected an Outlook id");
