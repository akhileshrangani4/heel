import type { Tool } from "@modelcontextprotocol/server";
import { GOOGLE_CALENDAR_TOOLS } from "../definitions/calendar/google.ts";
import { GITHUB_TOOLS } from "../definitions/github/definition.ts";
import { GMAIL_TOOLS } from "../definitions/gmail/definition.ts";
import { LINEAR_TOOLS } from "../definitions/linear/definition.ts";
import { NOTION_TOOLS } from "../definitions/notion/definition.ts";
import { OUTLOOK_TOOLS } from "../definitions/outlook/definition.ts";
import { SLACK_TOOLS } from "../definitions/slack/definition.ts";
import { STRIPE_TOOLS } from "../definitions/stripe/definition.ts";

/**
 * What an agent could do with a built-in service, from the service's own
 * tool list: each tool's name, its description and whether the definition
 * marks it read-only. The request page groups these by the rule that would
 * decide each one, so the owner sees "these run, these ask" in the service's
 * own words before connecting it. Pure.
 */

export interface ServiceAction {
  /** The tool's name, as rules and stubs name it: `merge_pull_request`. */
  tool: string;
  /** The tool's name in words: "merge pull request". */
  label: string;
  /** The definition's own one-line description, without its "Returns ..." tail. */
  description: string;
  /** The definition marks it read-only, so its calls carry `kind: read`. */
  read: boolean;
  /** Why it deserves a second look before approving: it can't be undone, or reaches people. */
  risk: string | null;
}

const TOOLS: Readonly<Record<string, readonly Tool[]>> = {
  gmail: GMAIL_TOOLS,
  outlook: OUTLOOK_TOOLS,
  "google-calendar": GOOGLE_CALENDAR_TOOLS,
  github: GITHUB_TOOLS,
  linear: LINEAR_TOOLS,
  notion: NOTION_TOOLS,
  slack: SLACK_TOOLS,
  stripe: STRIPE_TOOLS,
};

/**
 * Tools to flag inside the "asks you" group. A short table by tool name, not
 * a field on the definitions yet: if the flags prove useful, they belong on
 * each tool beside `readOnly`.
 */
const RISKS: Readonly<Record<string, string>> = {
  send: "sends mail",
  reply: "sends mail",
  reply_all: "sends mail",
  forward: "sends mail",
  send_draft: "sends mail",
  create_filter: "can forward mail after heel is revoked",
  create_rule: "can forward mail after heel is revoked",
  delete: "deletes mail",
  create_event: "emails attendees",
  update_event: "emails attendees",
  delete_event: "emails attendees",
  merge_pull_request: "can't be undone",
  put_file: "pushes a commit",
  post_message: "posts as you",
  schedule_message: "posts after heel is revoked",
  delete_message: "can't be undone",
  refund: "moves money",
  create_payment: "moves money",
};

/** `list_pull_requests` → "list pull requests". */
export function toolLabel(tool: string): string {
  return tool.replaceAll("_", " ");
}

/** Null when heel has no built-in definition for the provider (an MCP server). */
export function serviceActions(provider: string): readonly ServiceAction[] | null {
  const tools = TOOLS[provider];
  if (tools === undefined) return null;
  return tools.map((tool) => {
    const read = tool.annotations?.readOnlyHint === true;
    return {
      tool: tool.name,
      label: toolLabel(tool.name),
      description: (tool.description ?? "").split(" Returns ")[0] ?? "",
      read,
      risk: read ? null : (RISKS[tool.name] ?? null),
    };
  });
}
