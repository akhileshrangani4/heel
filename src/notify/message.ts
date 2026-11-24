/**
 * What a notification says, and how often heel retries one.
 * Pure.
 *
 * A notification tells someone what is waiting for them and links to where
 * they decide it (spec: Notifications, I-56). The title is the ask in plain
 * words, first, so a lock screen that cuts it short still shows what it is:
 * "Connect Linear?", "Send an email from gmail-work?". The body says who
 * asked, with the agent's own one-line reason when it gave one.
 *
 * It never carries the call's arguments, the proposed rules or any message
 * content, because Slack and email would re-expose data heel hides from
 * agents. The agent's reason is its own words, already shown on the page as
 * its claim, never part of the call. A notification never carries an
 * approve action either: replying to it changes nothing.
 */

import { describeProposal } from "../proposals/describe.ts";
import { ACTION_PHRASES, actionPhrase } from "../web/ui/summary.ts";

interface NoticeBase {
  /** The agent's name. */
  agent: string;
  /** The agent's own one-line reason, as it gave it, or null. */
  reason: string | null;
  /** The page to decide on. */
  url: string;
  /**
   * Which earlier notification this one replaces on a device (web push's
   * `tag`): one per thing the owner decides, so a retry or a replacement
   * shows once instead of stacking.
   */
  tag: string;
}

export interface ApprovalNotice extends NoticeBase {
  kind: "approval";
  /** The normalized action, e.g. `email.send`, or null when there is none. */
  action: string | null;
  /** The call's tool, for an action heel has no words for. */
  tool: string;
  /** The HTTP method of a call to an API heel only knows by its paths; null otherwise. */
  method: string | null;
  account: string;
}

/**
 * A rule proposal waiting for its owner (roadmap 2.1). Like a request, it
 * says how many rules, never the rules themselves: they are the agent's
 * words, and the page is where the owner reads them.
 */
export interface ProposalNotice extends NoticeBase {
  kind: "proposal";
  rules: number;
  /** Hide entries proposed beside the rules. */
  hide: number;
  /** `heel run` directories the agent asks for. */
  workdirs: number;
}

/**
 * An agent asking for a connection (roadmap 2.5). Names heel's own name for
 * the service; the alias stays on the page.
 */
export interface ConnectionNotice extends NoticeBase {
  kind: "connection";
  /** heel's words for the service: "Gmail", "the MCP server at mcp.example.com". */
  service: string;
}

export type Notice = ApprovalNotice | ProposalNotice | ConnectionNotice;

export interface NoticeText {
  title: string;
  body: string;
}

/** How much of the agent's reason a notification carries; the page has all of it. */
const REASON_CHARS = 200;

export function noticeText(notice: Notice): NoticeText {
  return { title: titleOf(notice), body: bodyOf(notice) };
}

/** The ask, as a question the owner answers on the page. */
function titleOf(notice: Notice): string {
  switch (notice.kind) {
    case "connection":
      return `Connect ${notice.service}?`;
    case "proposal": {
      const what = describeProposal(notice.rules, notice.hide, notice.workdirs);
      return `Add ${what === "" ? "new rules" : what}?`;
    }
    case "approval": {
      const worded = notice.action !== null && ACTION_PHRASES[notice.action] !== undefined;
      // An API call heel has no words for: its tool is the path, an argument, so only the method.
      const what =
        !worded && notice.method !== null
          ? `make a ${notice.method} request`
          : actionPhrase(notice.action, notice.tool);
      const where = notice.action === "email.send" ? "from" : "on";
      return `${what.charAt(0).toUpperCase()}${what.slice(1)} ${where} ${notice.account}?`;
    }
  }
}

/** Who asked, and why in their own words when they said. */
function bodyOf(notice: Notice): string {
  const reason = oneLine(notice.reason);
  return reason === null ? `${notice.agent} is asking.` : `${notice.agent}: ${reason}`;
}

/** The agent's text on one line, without control or bidi characters, cut to fit. */
function oneLine(text: string | null): string | null {
  if (text === null) return null;
  const flat = text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes.
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (flat === "") return null;
  return flat.length <= REASON_CHARS ? flat : `${flat.slice(0, REASON_CHARS - 1).trimEnd()}…`;
}

/** The approval page link for a request, under the human plane's public URL. */
export function approvalUrl(publicUrl: URL, approvalId: string): string {
  return new URL(`/approvals/${encodeURIComponent(approvalId)}`, publicUrl).toString();
}

/** An agent request's page, under the human plane's public URL. */
export function requestUrl(publicUrl: URL, requestId: string): string {
  return new URL(`/requests/${encodeURIComponent(requestId)}`, publicUrl).toString();
}

/** A rule proposal's page, under the human plane's public URL. */
export function proposalUrl(publicUrl: URL, proposalId: string): string {
  return new URL(`/proposals/${encodeURIComponent(proposalId)}`, publicUrl).toString();
}

/**
 * How long to wait before each retry. After the last one, the delivery is
 * marked failed. The request itself stays pending and listed on the page
 * whatever happens here (spec: Fail-closed, "The notification channel fails").
 */
export const RETRY_DELAYS_MS: readonly number[] = [
  30_000, // 30 s
  2 * 60_000, // 2 min
  10 * 60_000, // 10 min
  30 * 60_000, // 30 min
  2 * 60 * 60_000, // 2 h
];

/** When to try again after `attempts` failed tries, or null to give up. */
export function nextAttemptAfter(attempts: number, now: Date): Date | null {
  const delay = RETRY_DELAYS_MS[attempts - 1];
  return delay === undefined ? null : new Date(now.getTime() + delay);
}
