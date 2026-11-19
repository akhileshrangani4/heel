import type { RuleRef } from "../../core/call.ts";
import type { ApprovalOrigin, ApprovalStatus } from "../../store/schema.ts";
import { approvalStatusBadge } from "./approval-request.ts";
import { formatPauseScope, formatRelative, formatRule } from "./format.ts";
import { type Html, html } from "./html.ts";
import { notice, type PauseNotice, time } from "./layout.ts";
import { clientLabel, type Headline } from "./summary.ts";

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
  /** heel's own sentence for the call, the same one the request page leads with. */
  headline: Headline;
  /** The agent's MCP client, as it named itself; null when unknown. */
  client: string | null;
  /** The agent's own reason (`heel_reason`), or null. */
  reason: string | null;
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
 * Requests waiting on, or recently decided by, this approver, as cards that
 * lead with heel's own sentence for each call. Each links to the full
 * approval page; deciding happens only there (spec: The approval page), so
 * the list has no decision controls at all (I-56).
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
      <div class="card req-empty">
        <p><strong>Nothing is waiting for you.</strong></p>
        <p class="muted">New requests appear here and in your notifications.</p>
      </div>`;
  }
  const waiting = rows.filter((row) => row.status === "pending").length;
  return html`${heading}
    <p class="muted req-count">
      ${rows.length === 1 ? "1 request" : `${rows.length} requests`}${
        waiting > 0 && waiting < rows.length ? `, ${waiting} waiting for you` : ""
      }
    </p>
    <ul class="req-list" aria-label="Approval requests">
      ${rows.map((row) => requestCard(row, props.now))}
    </ul>`;
}

function requestCard(row: PendingRow, now: Date): Html {
  const said = row.headline;
  return html`<li class="card req" data-status="${row.status}">
    <div class="ap-meta">
      ${approvalStatusBadge(row.status)}
      <span class="ap-agent">${row.agent}</span>
      ${row.client === null ? "" : html`<span class="muted">via ${clientLabel(row.client)}</span>`}
      <span class="muted">on ${row.account}</span>
      <span class="muted">${formatRelative(row.createdAt, now)}</span>
    </div>
    <h2 class="req-title">
      <a href="${row.href}"
        >${said.agent} wants to <mark>${said.action}</mark> ${said.preposition}
        <mark>${said.place}</mark>${said.rest}</a
      >
    </h2>
    ${
      row.reason === null
        ? ""
        : html`<p class="req-reason"><span class="muted">${row.agent} says:</span> ${row.reason}</p>`
    }
    <p class="req-foot muted">
      ${stateNote(row, now)} · Rule
      ${formatRule(row.rule)}${row.origin === "org" ? " (org)" : ""} ·
      <span class="mono">${row.id}</span> · requested ${time(row.createdAt)}
    </p>
  </li>`;
}
