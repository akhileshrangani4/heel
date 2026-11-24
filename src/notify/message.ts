/**
 * What a notification says, and how often heel retries one.
 * Pure.
 *
 * A notification only tells someone that a request is waiting and where to
 * decide it (spec: Notifications, I-56). It names the agent, the action and
 * the account, and links to the approval page. It never carries the call's
 * arguments or any message content, because Slack and email would re-expose
 * data heel hides from agents. It never carries an approve action either:
 * replying to it changes nothing.
 */

import { describeProposal } from "../proposals/describe.ts";

export interface ApprovalNotice {
  kind: "approval";
  agent: string;
  /** The normalized action, e.g. `email.send`, or the raw tool name when there is none. */
  what: string;
  account: string;
  /** The approval page for this request. */
  url: string;
}

/**
 * A rule proposal waiting for its owner (roadmap 2.1). Like a request, it
 * names only the agent and how many rules, never the rules themselves: they
 * are the agent's words, and the page is where the owner reads them.
 */
export interface ProposalNotice {
  kind: "proposal";
  agent: string;
  rules: number;
  /** Hide entries proposed beside the rules. */
  hide: number;
  /** `heel run` directories the agent asks for. */
  workdirs: number;
  /** The proposal's page. */
  url: string;
}

/**
 * An agent asking for a connection (roadmap 2.5). Names the agent and heel's
 * own name for the service; the alias and the agent's why stay on the page.
 */
export interface ConnectionNotice {
  kind: "connection";
  agent: string;
  /** heel's words for the service: "Gmail", "the MCP server at mcp.example.com". */
  service: string;
  url: string;
}

export type Notice = ApprovalNotice | ProposalNotice | ConnectionNotice;

export interface NoticeText {
  title: string;
  body: string;
}

export function noticeText(notice: Notice): NoticeText {
  if (notice.kind === "connection") {
    return {
      title: `${notice.agent} wants to connect ${notice.service}`,
      body: "Open heel to decide.",
    };
  }
  if (notice.kind === "proposal") {
    return {
      title: `${notice.agent} wants to add ${describeProposal(notice.rules, notice.hide, notice.workdirs)}`,
      body: "Open heel to decide.",
    };
  }
  return {
    title: `${notice.agent} is asking to ${notice.what}`,
    body: `On ${notice.account}. Open heel to see the full call and decide.`,
  };
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
