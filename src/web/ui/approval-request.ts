import type { RuleRef, Surface } from "../../core/call.ts";
import type { ApprovalOrigin, ApprovalStatus } from "../../store/schema.ts";
import { type CeremonyCallback, ceremonyButton } from "./ceremony.ts";
import {
  formatArguments,
  formatBytes,
  formatPauseScope,
  formatRelative,
  formatRule,
  plural,
} from "./format.ts";
import { flag, type Html, html } from "./html.ts";
import { badge, notice, type PauseNotice, type Tone, time } from "./layout.ts";

/** The rendered email view shown beside the raw arguments for `email.send`. */
export interface EmailPreview {
  from: string;
  to: readonly string[];
  cc: readonly string[];
  bcc: readonly string[];
  subject: string;
  /** Shown as text. An HTML body is shown as its source, never rendered. */
  body: string;
  bodyFormat: "text" | "html";
  /** Listed by name, type and size, never inlined (Q-N4). */
  attachments: readonly { name: string; type: string; size: number }[];
}

/** A count condition on the deciding rule, with this call's items included (I-24). */
export interface CountWindow {
  per: "run" | "hour";
  total: number;
  over: number;
}

export interface ApprovalRequestView {
  id: string;
  callHash: string;
  status: ApprovalStatus;
  /** `org` asks are approved once by an org admin and never stand (Q-A7). */
  origin: ApprovalOrigin;
  agent: string;
  runId: string | null;
  account: string;
  provider: string;
  surface: Surface;
  tool: string;
  action: string | null;
  rule: RuleRef;
  /** The canonical, post-rewrite arguments: exactly what will run. */
  args: unknown;
  email: EmailPreview | null;
  items: number;
  counts: readonly CountWindow[];
  createdAt: Date;
  /** Pending: 24 h after creation. Approved: 1 h after the decision (Q-A4). */
  expiresAt: Date;
  decision: { by: string; at: Date } | null;
  executedAt: Date | null;
}

/** Standing approval lengths offered to the approver; 90 days is the hard cap (Q-A6). */
export const STANDING_DURATIONS = [
  { value: "1h", label: "1 hour" },
  { value: "1d", label: "1 day" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
] as const;
export const STANDING_CAP_DAYS = 90;

export interface ApprovalRequestProps {
  now: Date;
  /** The request, or why it couldn't be loaded. */
  load: { ok: true; request: ApprovalRequestView } | { ok: false; message: string };
  /** A pause covering this request's agent, account or provider. */
  pause: PauseNotice | null;
  /** Starts the passkey ceremony for approve, approve-as-standing and deny (I-56). */
  onDecide: CeremonyCallback;
}

const STATUS_BADGE: Record<ApprovalStatus, { label: string; tone: Tone | "muted" }> = {
  pending: { label: "Pending", tone: "warn" },
  approved: { label: "Approved", tone: "ok" },
  denied: { label: "Denied", tone: "error" },
  expired: { label: "Expired", tone: "muted" },
  executed: { label: "Ran once", tone: "info" },
};

export function approvalStatusBadge(status: ApprovalStatus): Html {
  const { label, tone } = STATUS_BADGE[status];
  return badge(label, tone);
}

function addressList(addresses: readonly string[]): Html {
  if (addresses.length === 0) return html`<span class="muted">none</span>`;
  return html`<ul class="mono">
    ${addresses.map((address) => html`<li>${address}</li>`)}
  </ul>`;
}

function emailView(email: EmailPreview, headingId: string): Html {
  const attachments =
    email.attachments.length === 0
      ? html`<p class="muted">No attachments.</p>`
      : html`<table class="data">
          <caption>
            Attachments (not opened by heel)
          </caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Type</th>
              <th scope="col">Size</th>
            </tr>
          </thead>
          <tbody>
            ${email.attachments.map(
              (a) =>
                html`<tr>
                  <td class="mono">${a.name}</td>
                  <td class="mono">${a.type}</td>
                  <td>${formatBytes(a.size)}</td>
                </tr>`,
            )}
          </tbody>
        </table>`;
  return html`<section class="card" aria-labelledby="${headingId}">
    <h2 id="${headingId}">Email</h2>
    <dl class="facts">
      <dt>From</dt>
      <dd class="mono">${email.from}</dd>
      <dt>To</dt>
      <dd>${addressList(email.to)}</dd>
      <dt>Cc</dt>
      <dd>${addressList(email.cc)}</dd>
      <dt>Bcc</dt>
      <dd>${addressList(email.bcc)}</dd>
      <dt>Subject</dt>
      <dd>${email.subject}</dd>
    </dl>
    <h3>Body${email.bodyFormat === "html" ? " (HTML source, not rendered)" : ""}</h3>
    <pre class="body">${email.body}</pre>
    ${attachments}
  </section>`;
}

function countsView(request: ApprovalRequestView): Html {
  const windows = request.counts.map(
    (w) =>
      html`<li>
        ${plural(w.total, "item")} this ${w.per}, including this call (the rule asks over
        ${w.over})
      </li>`,
  );
  return html`<ul>
    <li>${plural(request.items, "item")} in this call</li>
    ${windows}
  </ul>`;
}

/** What the request's status means for the approver, in one notice. */
function statusNotice(request: ApprovalRequestView, now: Date): Html {
  const decided = request.decision;
  switch (request.status) {
    case "pending":
      return notice(
        "info",
        html`<p>
          Waiting for a decision. Expires ${time(request.expiresAt)}
          (${formatRelative(request.expiresAt, now)}). Nothing runs until the agent re-sends the
          identical call after you approve.
        </p>`,
      );
    case "approved":
      return notice(
        "ok",
        html`<p>
          Approved${decided ? html` by ${decided.by} at ${time(decided.at)}` : ""}. It runs once
          when the agent re-sends the identical call, after the rules are checked again. Unused,
          it expires ${time(request.expiresAt)} (${formatRelative(request.expiresAt, now)}).
        </p>`,
      );
    case "denied":
      return notice(
        "error",
        html`<p>
          Denied${decided ? html` by ${decided.by} at ${time(decided.at)}` : ""}. Re-sends of
          this call return “denied” until ${time(request.expiresAt)}.
        </p>`,
      );
    case "expired":
      return notice(
        "warn",
        html`<p>
          Expired ${time(request.expiresAt)}. It can no longer be decided; the agent's next
          identical call starts a new request.
        </p>`,
      );
    case "executed":
      return notice(
        "info",
        html`<p>
          Ran once${request.executedAt ? html` at ${time(request.executedAt)}` : ""}. Another
          identical call is evaluated as a new call.
        </p>`,
      );
  }
}

function standingOptions(request: ApprovalRequestView, fieldsetId: string, locked: boolean): Html {
  if (request.origin === "org") {
    return html`<p class="muted">
      An org rule asked, so this can only be approved once, by an org admin. Org asks never stand.
    </p>`;
  }
  const durations = STANDING_DURATIONS.map(
    (d) =>
      html`<option value="${d.value}"${flag("selected", d.value === "1d")}>${d.label}</option>`,
  );
  return html`<fieldset id="${fieldsetId}"${flag("disabled", locked)}>
    <legend>Standing approval</legend>
    <p class="muted" id="${fieldsetId}-help">
      Approving as standing turns this rule's ask into allow for ${request.agent} until it ends,
      at most ${STANDING_CAP_DAYS} days. It lapses if the rule is edited or deleted.
    </p>
    <div class="choice">
      <input type="radio" id="${fieldsetId}-exact" name="scope" value="exact_call" checked />
      <label for="${fieldsetId}-exact">This exact call: same account, tool and arguments</label>
    </div>
    <div class="choice">
      <input type="radio" id="${fieldsetId}-rule" name="scope" value="rule" />
      <label for="${fieldsetId}-rule"
        >Everything rule ${formatRule(request.rule)} asks about, for this agent</label
      >
    </div>
    <div class="choice">
      <label for="${fieldsetId}-duration">Lasts</label>
      <select id="${fieldsetId}-duration" name="duration">
        ${durations}
      </select>
    </div>
  </fieldset>`;
}

function decisionControls(
  request: ApprovalRequestView,
  pause: PauseNotice | null,
  onDecide: CeremonyCallback,
): Html {
  if (request.status !== "pending" && request.status !== "expired") return html``;
  // An expired request can't be decided at all (I-55). Approving in a paused
  // scope is refused (I-61); denying only tightens, so it stays open.
  const expired = request.status === "expired";
  const approveLocked = expired || pause !== null;
  const fieldsetId = `standing-${request.id}`;
  const helpId = `decide-help-${request.id}`;
  const binding = { approvalId: request.id, callHash: request.callHash };
  const lockNote = expired
    ? html`<p>
        <strong>This request expired, so it can't be approved or denied.</strong> The agent's
        next identical call starts a new request.
      </p>`
    : pause
      ? html`<p>
        <strong
          >Approving is unavailable while ${formatPauseScope(pause.scope, pause.target)} is
          paused.</strong
        >
        Resume first; you can still deny.
      </p>`
      : "";
  return html`<section aria-labelledby="decide-${request.id}">
    <h2 id="decide-${request.id}">Decide</h2>
    ${lockNote}
    <p id="${helpId}" class="muted">
      Every decision asks for your passkey. The page never decides on a click alone.
    </p>
    ${standingOptions(request, fieldsetId, approveLocked)}
    <div class="actions">
      ${ceremonyButton({
        callback: onDecide,
        intent: "approve-once",
        label: "Approve once",
        tone: "primary",
        binding,
        disabled: approveLocked,
        describedBy: helpId,
      })}
      ${
        request.origin === "org"
          ? ""
          : ceremonyButton({
              callback: onDecide,
              intent: "approve-standing",
              label: "Approve as standing",
              tone: "secondary",
              binding,
              disabled: approveLocked,
              describedBy: helpId,
              optionsFrom: fieldsetId,
            })
      }
      ${ceremonyButton({
        callback: onDecide,
        intent: "deny",
        label: "Deny",
        tone: "danger",
        binding,
        disabled: expired,
        describedBy: helpId,
      })}
    </div>
  </section>`;
}

/**
 * The approval page body (spec: The approval page). Everything a rule could
 * match on is shown in full, and the arguments are never truncated (I-57).
 */
export function approvalRequest(props: ApprovalRequestProps): Html {
  if (!props.load.ok) {
    return html`<h1>Approval request</h1>
      ${notice(
        "error",
        html`<p><strong>This request couldn't be loaded.</strong> ${props.load.message}</p>
          <p>Nothing was decided.</p>`,
      )}`;
  }
  const request = props.load.request;
  return html`<h1>
      ${request.action ?? request.tool} on ${request.account} ${approvalStatusBadge(request.status)}
    </h1>
    <p class="muted mono">${request.id}</p>
    ${statusNotice(request, props.now)}
    <section class="card" aria-labelledby="call-${request.id}">
      <h2 id="call-${request.id}">Call</h2>
      <dl class="facts">
        <dt>Agent</dt>
        <dd>${request.agent}</dd>
        <dt>Run</dt>
        <dd class="mono">${request.runId ?? html`<span class="muted">none</span>`}</dd>
        <dt>Account</dt>
        <dd>${request.account} <span class="muted">(${request.provider})</span></dd>
        <dt>Action</dt>
        <dd class="mono">${request.action ?? html`<span class="muted">none</span>`}</dd>
        <dt>Tool</dt>
        <dd class="mono">${request.tool} <span class="muted">via ${request.surface}</span></dd>
        <dt>Rule</dt>
        <dd>
          ${formatRule(request.rule)}
          <span class="muted">(${request.origin === "org" ? "org rules" : "owner's rules"})</span>
        </dd>
        <dt>Counts</dt>
        <dd>${countsView(request)}</dd>
        <dt>Requested</dt>
        <dd>${time(request.createdAt)}</dd>
        <dt>Expires</dt>
        <dd>${time(request.expiresAt)} (${formatRelative(request.expiresAt, props.now)})</dd>
      </dl>
    </section>
    ${request.email ? emailView(request.email, `email-${request.id}`) : ""}
    <section aria-labelledby="args-${request.id}">
      <h2 id="args-${request.id}">Full arguments</h2>
      <p class="muted">Exactly what runs, after heel's own rewrites. Nothing is shortened.</p>
      <pre class="args" tabindex="0" aria-labelledby="args-${request.id}">${formatArguments(
        request.args,
      )}</pre>
    </section>
    ${decisionControls(request, props.pause, props.onDecide)}`;
}
