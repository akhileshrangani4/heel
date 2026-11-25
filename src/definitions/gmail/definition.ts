import type { Tool } from "@modelcontextprotocol/server";
import type { Definition } from "../../gateway/pipeline/ports.ts";
import type { AccountRecord } from "../../store/directory.ts";
import { type ApiDeps, accountToken } from "../api-deps.ts";
import { listedTools, toolTableDefinition } from "../tool-table.ts";
import { GmailClient } from "./client.ts";
import { Mailbox } from "./mailbox.ts";
import { ORGANIZE_TOOLS } from "./organize.ts";
import { READ_TOOLS } from "./reads.ts";
import { allInThread, SEND_TOOLS } from "./send.ts";
import type { GmailTool } from "./tool.ts";

/**
 * The Gmail definition: heel's own tools, calling the Gmail API with the
 * account's credential. Each tool is one
 * row in `reads.ts`, `send.ts` or `organize.ts`; `toolTableDefinition` routes a
 * call to its row. Gmail refusing a write is an upstream error with a known
 * outcome; a write that never got an answer is left unknown.
 */

const TOOLS: Record<string, GmailTool> = { ...READ_TOOLS, ...SEND_TOOLS, ...ORGANIZE_TOOLS };

/** The tools as MCP lists them. */
export const GMAIL_TOOLS: readonly Tool[] = listedTools(TOOLS);

export function gmailDefinition(account: AccountRecord, deps: ApiDeps): Definition {
  const mailbox = new Mailbox(new GmailClient(deps.fetch, () => accountToken(deps, account)));
  return toolTableDefinition({
    tools: TOOLS,
    listed: GMAIL_TOOLS,
    box: mailbox,
    stateCheck: async (check, box, call, signal) =>
      check === "all_in_thread" ? allInThread(box, call, signal) : "fail",
  });
}
