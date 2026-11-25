import type { Tool } from "@modelcontextprotocol/server";
import type { Definition } from "../../gateway/pipeline/ports.ts";
import type { AccountRecord } from "../../store/directory.ts";
import { type ApiDeps, accountToken } from "../api-deps.ts";
import { mailboxSettings } from "../sign-in.ts";
import { listedTools, toolTableDefinition } from "../tool-table.ts";
import { CALENDAR_TOOLS } from "./calendar.ts";
import { OutlookClient } from "./client.ts";
import { OutlookMailbox } from "./messages.ts";
import { ORGANIZE_TOOLS } from "./organize.ts";
import { READ_TOOLS } from "./reads.ts";
import { allInThread, SEND_TOOLS } from "./send.ts";
import type { OutlookTool } from "./tool.ts";

/**
 * The Outlook definition: heel's own tools on Microsoft Graph, with
 * the account's credential. Each tool is one row in `reads.ts`, `send.ts`
 * or `organize.ts`; `toolTableDefinition` routes a call to its row.
 *
 * An account that has never signed in has no mailbox address yet, so it
 * has no definition: its calls are denied (`provider_unavailable`) until
 * its owner signs in.
 */

const TOOLS: Record<string, OutlookTool> = {
  ...READ_TOOLS,
  ...SEND_TOOLS,
  ...ORGANIZE_TOOLS,
  ...CALENDAR_TOOLS,
};

/** The tools as MCP lists them. */
export const OUTLOOK_TOOLS: readonly Tool[] = listedTools(TOOLS);

export function outlookDefinition(account: AccountRecord, deps: ApiDeps): Definition | null {
  const settings = mailboxSettings(account.settings);
  if (settings === null) return null;
  const mailbox = new OutlookMailbox(
    new OutlookClient(deps.fetch, () => accountToken(deps, account)),
    settings.mailbox,
  );
  return toolTableDefinition({
    tools: TOOLS,
    listed: OUTLOOK_TOOLS,
    box: mailbox,
    stateCheck: async (check, box, call, signal) =>
      check === "all_in_thread" ? allInThread(box, call, signal) : "fail",
  });
}
