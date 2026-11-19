import type { RuleRef } from "../../core/call.ts";
import type { StandingScope } from "../../store/schema.ts";
import { formatRelative, formatRule } from "./format.ts";
import { type Html, html } from "./html.ts";
import { badge, type FormTarget, notice, postForm, type Tone, time } from "./layout.ts";

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
        row.paused ? html`. Paused: calls in scope return “paused” anyway` : ""
      }`
    : row.state === "revoked" && row.revoked
      ? html`Revoked by ${row.revoked.by} at ${time(row.revoked.at)}`
      : row.state === "expired"
        ? html`Ended ${time(row.expiresAt)}`
        : html`Kept for the record; it no longer matches`;
}

/**
 * Standing approvals live in the store, never in YAML (spec: Standing
 * approvals). Each can only turn its parent rule's ask into allow; a deny
 * above it still wins.
 */
export function standingApprovalList(props: StandingApprovalListProps): Html {
  const heading = html`<h1>Standing approvals</h1>
    <p class="muted">
      Each one turns a single rule's ask into allow for one agent until it ends. It lapses when
      that rule is edited or deleted, and a deny above the rule still wins.
    </p>`;
  if (!props.load.ok) {
    return html`${heading}
      ${notice(
        "error",
        html`<p><strong>Standing approvals couldn't be loaded.</strong> ${props.load.message}</p>
          <p><code>heel approvals revoke &lt;id&gt;</code> on the heel host still works.</p>`,
      )}`;
  }
  const rows = props.load.rows;
  if (rows.length === 0) {
    return html`${heading}
      <p>No standing approvals. Approving a request as standing adds one here.</p>`;
  }
  return html`${heading}
    <p class="muted req-count">
      ${rows.length === 1 ? "1 standing approval" : `${rows.length} standing approvals`}
    </p>
    <ul class="req-list" aria-label="Standing approvals">
      ${rows.map(
        (row) => html`<li class="card req" data-status="${row.state}">
          <div class="ap-meta">
            ${stateBadge(row)}
            <span class="ap-agent">${row.agent}</span>
            <span class="muted">on ${row.account}</span>
            <span class="muted">by ${row.createdBy}, ${time(row.createdAt)}</span>
          </div>
          <h2 class="req-title">${scopeText(row)}</h2>
          <div class="req-foot-row">
            <p class="req-foot muted">
              ${stateDetail(row, props.now)} · Rule ${formatRule(row.rule)} ·
              <span class="mono">${row.id}</span>
            </p>
            ${
              row.state === "active"
                ? postForm(
                    props.revokeForm,
                    { id: row.id },
                    html`<button
                      type="submit"
                      class="btn btn-danger"
                      aria-label="Revoke ${row.id} for ${row.agent} on ${row.account}"
                    >
                      Revoke
                    </button>`,
                  )
                : ""
            }
          </div>
        </li>`,
      )}
    </ul>`;
}
