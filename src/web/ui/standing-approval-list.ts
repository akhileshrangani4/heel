import type { RuleRef } from "../../core/call.ts";
import type { StandingScope } from "../../store/schema.ts";
import { formatRelative, formatRule } from "./format.ts";
import { type Html, html, trusted } from "./html.ts";
import {
  badge,
  type FormTarget,
  notice,
  postForm,
  scrollRegion,
  type Tone,
  time,
} from "./layout.ts";
import { btn } from "./shadcn/button.ts";

/**
 * Where a standing approval stands. `lapsed` means its parent rule was edited
 * or deleted: it stays visible for the record but no longer matches.
 */
export type StandingState = "active" | "expired" | "revoked" | "lapsed";

export interface StandingRow {
  id: string;
  agent: string;
  account: string;
  scope: StandingScope;
  /** The parent rule it sits just above. */
  rule: RuleRef;
  /** For `exact_call`: the action or tool it covers. For `run`: the run id. */
  covers: string | null;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
  state: StandingState;
  revoked: { by: string; at: Date } | null;
  /** Set when a pause covers this approval's agent or account. */
  paused: boolean;
}

export interface StandingApprovalListProps {
  now: Date;
  load: { ok: true; rows: readonly StandingRow[] } | { ok: false; message: string };
  /** Revoking only tightens, so it is a plain form post with no passkey. */
  revokeForm: FormTarget;
}

const STATE_BADGE: Record<StandingState, { label: string; tone: Tone | "muted" }> = {
  active: { label: "Active", tone: "ok" },
  expired: { label: "Expired", tone: "muted" },
  revoked: { label: "Revoked", tone: "error" },
  lapsed: { label: "Lapsed: rule changed", tone: "warn" },
};

function scopeText(row: StandingRow): Html {
  switch (row.scope) {
    case "exact_call":
      return html`This exact call${row.covers ? html` (<span class="mono">${row.covers}</span>)` : ""}`;
    case "run":
      return html`Everything the rule asks about, in run <span class="mono">${row.covers ?? ""}</span>`;
    case "rule":
      return html`Everything the rule asks about`;
  }
}

/** The state as a pill, for the card's top line. */
function stateBadge(row: StandingRow): Html {
  const { label, tone } = STATE_BADGE[row.state];
  return badge(label, tone);
}

/** When it ends, or how it ended, for the card's footer. */
function stateDetail(row: StandingRow, now: Date): Html {
  return row.state === "active"
    ? html`Ends ${time(row.expiresAt)} (${formatRelative(row.expiresAt, now)})${
        row.paused ? html`. On hold until you resume` : ""
      }`
    : row.state === "revoked" && row.revoked
      ? html`Revoked by ${row.revoked.by} at ${time(row.revoked.at)}`
      : row.state === "expired"
        ? html`Ended ${time(row.expiresAt)}`
        : html`Kept for the record; it no longer matches`;
}

/**
 * Standing approvals live in the store, never in YAML. Each can only turn
 * its parent rule's ask into allow; a deny above it still wins.
 */
export function standingApprovalList(props: StandingApprovalListProps): Html {
  const heading = html`<h1>Standing approvals</h1>`;
  if (!props.load.ok) {
    return html`${heading}
      ${notice(
        "error",
        html`<p><strong>Standing approvals couldn't be loaded.</strong> ${props.load.message}</p>`,
      )}`;
  }
  const rows = props.load.rows;
  if (rows.length === 0) {
    return html`${heading}
      <div class="req-empty">
        <span class="req-empty-icon agents-empty-icon">${trusted(CLOCK_CHECK)}</span>
        <p class="req-empty-title">No standing approvals</p>
      </div>`;
  }
  return html`${heading}
    ${scrollRegion(
      "Standing approvals",
      html`<table class="data rows-table">
        <caption class="visually-hidden">Standing approvals</caption>
        <thead>
          <tr><th scope="col">Covers</th><th scope="col">Rule</th><th scope="col">State</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr>
        </thead>
        <tbody>
          ${rows.map(
            (row) => html`<tr data-status="${row.state}">
              <td><strong>${scopeText(row)}</strong>
                <span class="cell-sub">${row.agent} on ${row.account} · by ${row.createdBy}, ${time(row.createdAt)}</span></td>
              <td class="muted">${formatRule(row.rule)}<span class="cell-sub mono">${row.id}</span></td>
              <td>${stateBadge(row)}<span class="cell-sub">${stateDetail(row, props.now)}</span></td>
              <td class="cell-actions">${
                row.state === "active"
                  ? postForm(
                      props.revokeForm,
                      { id: row.id },
                      html`<button type="submit" class="${btn("ghost", "sm", "text-destructive")}" aria-label="Revoke ${row.id} for ${row.agent} on ${row.account}">Revoke</button>`,
                    )
                  : ""
              }</td>
            </tr>`,
          )}
        </tbody>
      </table>`,
    )}`;
}

/** lucide's calendar-check. */
const CLOCK_CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="m9 16 2 2 4-4"/></svg>`;
