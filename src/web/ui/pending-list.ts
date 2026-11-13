import type { RuleRef } from "../../core/call.ts";
import type { ApprovalOrigin, ApprovalStatus } from "../../store/schema.ts";
import { approvalStatusBadge } from "./approval-request.ts";
import { formatPauseScope, formatRelative, formatRule } from "./format.ts";
import { type Html, html } from "./html.ts";
import { notice, type PauseNotice, time } from "./layout.ts";

export interface PendingRow {
  id: string;
  /** Where the full approval page lives. */
  href: string;
  status: ApprovalStatus;
  origin: ApprovalOrigin;
  agent: string;
  account: string;
  action: string | null;
  tool: string;
  rule: RuleRef;
  createdAt: Date;
  expiresAt: Date;
  /** Set when a pause covers this request: it can't be approved until resume (I-61). */
  pausedBy: PauseNotice | null;
}

export interface PendingListProps {
  now: Date;
  load: { ok: true; rows: readonly PendingRow[] } | { ok: false; message: string };
}

function stateNote(row: PendingRow, now: Date): Html {
  if (row.pausedBy) {
    return html`Paused (${formatPauseScope(row.pausedBy.scope, row.pausedBy.target)}): approve
    after resume`;
  }
  switch (row.status) {
    case "pending":
      return html`Expires ${formatRelative(row.expiresAt, now)}`;
    case "approved":
      return html`Runs when the agent re-sends; unused it expires
        ${formatRelative(row.expiresAt, now)}`;
    case "denied":
      return html`Re-sends return “denied” until ${time(row.expiresAt)}`;
    case "expired":
      return html`Expired ${formatRelative(row.expiresAt, now)}`;
    case "executed":
      return html`Ran once`;
  }
}

/**
 * Requests waiting on, or recently decided by, this approver. Each row links
 * to the full approval page; deciding happens only there (spec: The approval
 * page), so the list has no decision controls at all.
 */
export function pendingList(props: PendingListProps): Html {
  const heading = html`<h1>Approvals</h1>`;
  if (!props.load.ok) {
    return html`${heading}
      ${notice(
        "error",
        html`<p><strong>Requests couldn't be loaded.</strong> ${props.load.message}</p>
          <p>Nothing was decided. Pending requests keep their ids and expiry.</p>`,
      )}`;
  }
  const rows = props.load.rows;
  if (rows.length === 0) {
    return html`${heading}
      <p>Nothing is waiting for you. New requests appear here and in your notifications.</p>`;
  }
  return html`${heading}
    <table class="data">
      <caption>
        ${rows.length === 1 ? "1 request" : `${rows.length} requests`}
      </caption>
      <thead>
        <tr>
          <th scope="col">Request</th>
          <th scope="col">Agent</th>
          <th scope="col">Account</th>
          <th scope="col">Rule</th>
          <th scope="col">Requested</th>
          <th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(
          (row) =>
            html`<tr>
              <th scope="row">
                <a href="${row.href}">${row.action ?? row.tool}</a>
                <div class="muted mono">${row.id}</div>
              </th>
              <td>${row.agent}</td>
              <td>${row.account}</td>
              <td>
                ${formatRule(row.rule)}${row.origin === "org" ? html` <span class="muted">(org)</span>` : ""}
              </td>
              <td>${time(row.createdAt)}</td>
              <td>
                ${approvalStatusBadge(row.status)}
                <div class="muted">${stateNote(row, props.now)}</div>
              </td>
            </tr>`,
        )}
      </tbody>
    </table>`;
}
