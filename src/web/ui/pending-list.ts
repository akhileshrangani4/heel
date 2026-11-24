import type { RuleRef } from "../../core/call.ts";
import type { ApprovalOrigin, ApprovalStatus } from "../../store/schema.ts";
import { approvalStatusBadge } from "./approval-request.ts";
import { formatPauseScope, formatRelative, formatShort } from "./format.ts";
import { type Html, html, trusted } from "./html.ts";
import { CHEVRON_RIGHT } from "./icons.ts";
import { notice, type PauseNotice, time } from "./layout.ts";
import { serviceLogo } from "./logos.ts";
import type { Headline } from "./summary.ts";

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
  /** Rule changes waiting below the list, so an empty list doesn't say nothing is waiting. */
  ruleChangesWaiting?: number;
  load: { ok: true; rows: readonly PendingRow[] } | { ok: false; message: string };
}

/** A waiting request's expiry shows only inside this window, when it is worth acting on. */
export const EXPIRY_SHOWN_WITHIN_MS = 60 * 60_000;

/** The one line under a row's title, or nothing: a waiting request far from expiry needs no note. */
function stateNote(row: PendingRow, now: Date): Html | "" {
  if (row.pausedBy) {
    return html`Paused (${formatPauseScope(row.pausedBy.scope, row.pausedBy.target)}): approve
    after resume`;
  }
  switch (row.status) {
    case "pending":
      return row.expiresAt.getTime() - now.getTime() <= EXPIRY_SHOWN_WITHIN_MS
        ? html`<span class="req-soon">Expires in ${formatShort(row.expiresAt.getTime() - now.getTime())}</span>`
        : "";
    case "approved":
      return html`Runs when the agent sends it again; unused it expires
        ${formatRelative(row.expiresAt, now)}`;
    case "denied":
      return html`Re-sends return “denied” until ${time(row.expiresAt)}`;
    case "expired":
      return html`Expired ${formatRelative(row.expiresAt, now)}`;
    case "executed":
      return html`Ran once`;
  }
}

/** The kind of service a request is for, read from its action or tool and account names. */
export type ServiceKind = "mail" | "calendar" | "github" | "http" | "other";

export function serviceKind(row: Pick<PendingRow, "action" | "tool" | "account">): ServiceKind {
  const action = row.action ?? "";
  const hay = `${action} ${row.tool} ${row.account}`.toLowerCase();
  if (action.startsWith("email.") || /\b(gmail|outlook|mail)\b/.test(hay)) return "mail";
  if (action.startsWith("calendar.") || hay.includes("calendar")) return "calendar";
  if (action.startsWith("github.") || hay.includes("github")) return "github";
  if (/^(get|put|post|patch|delete) \//i.test(row.tool) || action.startsWith("http."))
    return "http";
  return "other";
}

const KIND_LABEL: Record<ServiceKind, string> = {
  mail: "Email",
  calendar: "Calendar",
  github: "GitHub",
  http: "HTTP API",
  other: "Service",
};

/** The provider whose mark stands for a request, from its action and account name. */
function providerOf(row: Pick<PendingRow, "action" | "tool" | "account">): string {
  const kind = serviceKind(row);
  const microsoft = /outlook|microsoft|office/i.test(row.account);
  if (kind === "mail") return microsoft ? "outlook" : "gmail";
  if (kind === "calendar") return microsoft ? "outlook" : "google-calendar";
  if (kind === "github") return "github";
  if (kind === "http") return "http";
  return row.account;
}

/** The service's mark; decorative, since the title names the account. */
export function serviceIcon(row: Pick<PendingRow, "action" | "tool" | "account">): Html {
  const kind = serviceKind(row);
  return html`<span class="req-icon" data-kind="${kind}" title="${KIND_LABEL[kind]}"
    >${serviceLogo(providerOf(row), row.account)}</span
  >`;
}

const SECTIONS = [
  { id: "waiting", title: "Needs you", statuses: ["pending"] },
  { id: "decided", title: "Decided in the last day", statuses: ["approved", "denied", "executed"] },
  { id: "expired", title: "Expired", statuses: ["expired"] },
] as const;

/**
 * Requests waiting on, or recently decided by, this approver, grouped into
 * what needs you, what was decided, and what expired. Each row leads with
 * heel's own sentence and links to the full approval page; deciding happens
 * only there (spec: The approval page), so the list has no decision
 * controls at all (I-56).
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
    const changes = props.ruleChangesWaiting ?? 0;
    if (changes > 0) {
      return html`${heading}
        <p class="muted req-count">No calls waiting. ${changes === 1 ? "1 other request" : `${changes} other requests`} below.</p>`;
    }
    return html`${heading}
      <div class="req-empty">
        <span class="req-empty-icon">${trusted(CHECK_CIRCLE)}</span>
        <p class="req-empty-title">You're all caught up</p>
        <p class="muted">Nothing is waiting for you. New requests show up here and in your notifications.</p>
      </div>`;
  }
  // Each section heading carries its own count, so the list needs no count line.
  return html`${heading}
    ${SECTIONS.map((section, _i, all) => {
      // With one section the page title says it; its heading stays for screen readers.
      const only =
        all.filter((s) =>
          rows.some((row) => (s.statuses as readonly ApprovalStatus[]).includes(row.status)),
        ).length === 1;
      const these = rows.filter((row) =>
        (section.statuses as readonly ApprovalStatus[]).includes(row.status),
      );
      if (these.length === 0) return "";
      const headingId = `req-${section.id}`;
      return html`<section class="req-section" aria-labelledby="${headingId}">
        <h2 id="${headingId}" class="req-section-title${only ? " visually-hidden" : ""}">
          ${section.title} <span class="req-section-count">${String(these.length)}</span>
        </h2>
        <ul class="req-group" aria-label="${section.title}">
          ${these.map((row) => requestRow(row, props.now, section.id !== "waiting"))}
        </ul>
      </section>`;
    })}`;
}

/** lucide's circle-check. */
const CHECK_CIRCLE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>`;

/**
 * One request: the whole row is the link to its page. It says who, what and
 * when: heel's sentence (which names the agent), how long ago, and a note
 * only when one matters (expiring soon, paused, decided). The client, the
 * agent's reason and the rule wait on the request page. "Review" shows on
 * hover and focus on wide screens; a chevron says the row opens.
 */
function requestRow(row: PendingRow, now: Date, showStatus: boolean): Html {
  const said = row.headline;
  const note = stateNote(row, now);
  return html`<li class="req" data-status="${row.status}">
    <a class="req-row" href="${row.href}">
      ${serviceIcon(row)}
      <span class="req-body">
        <span class="req-title"
          >${said.agent} wants to <mark>${said.action}</mark> ${said.preposition}
          <mark>${said.place}</mark>${said.rest}</span
        >
        <span class="ap-meta">
          <time class="muted" datetime="${row.createdAt.toISOString()}" title="${formatRelative(row.createdAt, now)}">${formatShort(now.getTime() - row.createdAt.getTime())}</time>
          ${showStatus ? approvalStatusBadge(row.status) : ""}
          ${note === "" ? "" : html`<span class="req-foot muted">${note}</span>`}
        </span>
      </span>
      <span class="req-review" aria-hidden="true">Review</span>
      <span class="req-go" aria-hidden="true">${trusted(CHEVRON_RIGHT)}</span>
    </a>
  </li>`;
}
