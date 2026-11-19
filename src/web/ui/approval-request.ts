import type { RuleRef, Surface } from "../../core/call.ts";
import type { ApprovalHints, HintTone } from "../../core/hints.ts";
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
import { badge, notice, type PauseNotice, scrollRegion, type Tone, time } from "./layout.ts";
import {
  argumentLines,
  type EmailPreview,
  groupByDomain,
  headline,
  homeDomain,
  type MergePreview,
} from "./summary.ts";

export type { EmailPreview, MergePreview } from "./summary.ts";

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
  /**
   * The agent's own reason (MCP `heel_reason`), or null. What the agent claims,
   * never what the call does: it's shown apart from heel's facts, as quoted words.
   */
  reason: string | null;
  /** The canonical, post-rewrite arguments: exactly what will run. */
  args: unknown;
  email: EmailPreview | null;
  /** The merge view, for `github.merge`; null for anything else. */
  merge: MergePreview | null;
  items: number;
  counts: readonly CountWindow[];
  createdAt: Date;
  /** Pending: 24 h after creation. Approved: 1 h after the decision (Q-A4). */
  expiresAt: Date;
  decision: { by: string; at: Date } | null;
  executedAt: Date | null;
  /**
   * What each approval adapter said (core/hints.ts), or `pending` while one
   * hasn't answered yet; empty when none are configured.
   */
  hints: readonly { adapter: string; result: ApprovalHints | { status: "pending" } }[];
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
  /** The viewer's remembered sections for this kind of request; none by default. */
  folds?: Folds;
}

/** What remembered folds are keyed by: the action, or `provider:tool` without one. */
export function foldKind(
  request: Pick<ApprovalRequestView, "action" | "provider" | "tool">,
): string {
  return request.action ?? `${request.provider}:${request.tool}`;
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

function lineCount(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}

/** Sections the person opened or closed before on this kind of request (store/folds.ts). */
export type Folds = ReadonlyMap<string, boolean>;

/**
 * A collapsible section the page remembers per kind of request. The client
 * script posts a toggle; the server renders the remembered state next time.
 */
function fold(
  folds: Folds,
  section: string,
  openByDefault: boolean,
  summary: Html,
  content: Html,
  className = "ap-fold",
): Html {
  const open = folds.get(section) ?? openByDefault;
  return html`<details class="${className}" data-heel-fold="${section}"${flag("open", open)}>
    <summary>${summary}</summary>
    ${content}
  </details>`;
}

/** Recipients by domain: every domain named, outsiders marked, every address on the page. */
function recipients(
  field: string,
  addresses: readonly string[],
  home: string | null,
  folds: Folds,
): Html {
  if (addresses.length === 0) return html`<span class="muted">none</span>`;
  return html`<ul class="ap-domains">
    ${groupByDomain(addresses, home).map((group) => {
      const outside = group.outside ? html` <span class="ap-outside">outside</span>` : "";
      if (group.addresses.length <= 3) {
        return html`<li>
          ${group.addresses.map((a) => html`<span class="ap-chip${group.outside ? " is-outside" : ""}">${a}</span> `)}${outside}
        </li>`;
      }
      // Only groups of four or more fold, and the domain stays in the summary.
      return html`<li>
        ${fold(
          folds,
          `${field}:${group.domain}`,
          false,
          html`<strong>${group.addresses.length} people</strong> at
            <span class="mono">${group.domain}</span>${outside}`,
          html`<ul class="ap-addresses mono">
            ${group.addresses.map((a) => html`<li>${a}</li>`)}
          </ul>`,
        )}
      </li>`;
    })}
  </ul>`;
}

function emailView(email: EmailPreview, headingId: string, folds: Folds): Html {
  const home = homeDomain(email.from);
  const attachments =
    email.attachments.length === 0
      ? ""
      : html`<div class="ap-row">
          <span class="ap-key">Files</span>
          ${scrollRegion(
            "Attachments",
            html`<table class="data">
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
            </table>`,
          )}
        </div>`;
  const forwarded =
    email.forwarded === undefined
      ? ""
      : html`<div class="ap-row">
          <span class="ap-key">Forwards</span>
          <div>
            ${fold(
              folds,
              "forwarded",
              true,
              html`${plural(lineCount(email.forwarded.text), "line")}`,
              html`<pre class="body">${email.forwarded.text}</pre>`,
            )}
            ${
              email.forwarded.attachments.length === 0
                ? ""
                : html`<p class="muted">
                    With ${email.forwarded.attachments.join(", ")} (not opened by heel)
                  </p>`
            }
          </div>
        </div>`;
  return html`<section class="card ap-card" aria-labelledby="${headingId}">
    <div class="ap-card-head">
      <h2 id="${headingId}">The email</h2>
      <span class="muted">exactly what will be sent</span>
    </div>
    <div class="ap-row"><span class="ap-key">From</span><span class="mono">${email.from}</span></div>
    <div class="ap-row"><span class="ap-key">To</span>${recipients("to", email.to, home, folds)}</div>
    <div class="ap-row"><span class="ap-key">Cc</span>${recipients("cc", email.cc, home, folds)}</div>
    <div class="ap-row"><span class="ap-key">Bcc</span>${recipients("bcc", email.bcc, home, folds)}</div>
    <div class="ap-row"><span class="ap-key">Subject</span><strong>${email.subject}</strong></div>
    <div class="ap-row">
      <span class="ap-key">Body</span>
      <div>
        ${email.bodyFormat === "html" ? html`<p class="muted">HTML source, not rendered</p>` : ""}
        ${fold(
          folds,
          "body",
          true,
          html`${plural(lineCount(email.body), "line")}`,
          html`<pre class="body">${email.body}</pre>`,
        )}
      </div>
    </div>
    ${forwarded} ${attachments}
  </section>`;
}

function mergeView(merge: MergePreview, headingId: string): Html {
  return html`<section class="card ap-card" aria-labelledby="${headingId}">
    <div class="ap-card-head"><h2 id="${headingId}">The merge</h2></div>
    <div class="ap-row"><span class="ap-key">Repo</span><span class="mono">${merge.repo}</span></div>
    <div class="ap-row"><span class="ap-key">Pull request</span><span>#${merge.number}</span></div>
    ${merge.base === null ? "" : html`<div class="ap-row"><span class="ap-key">Into</span><span class="mono">${merge.base}</span></div>`}
    ${merge.method === null ? "" : html`<div class="ap-row"><span class="ap-key">Method</span><span>${merge.method}</span></div>`}
    ${
      merge.sha === null
        ? ""
        : html`<div class="ap-row">
            <span class="ap-key">Commit</span>
            <span><span class="mono">${merge.sha}</span>
              <span class="muted">: GitHub refuses the merge if the branch moved past it</span></span>
          </div>`
    }
  </section>`;
}

/** Every top-level argument as a readable row, for tools without their own view. */
function argumentsView(request: ApprovalRequestView, headingId: string): Html {
  return html`<section class="card ap-card" aria-labelledby="${headingId}">
    <div class="ap-card-head">
      <h2 id="${headingId}">What it will run</h2>
      <span class="mono muted">${request.tool}</span>
    </div>
    ${argumentLines(request.args).map(
      (line) =>
        html`<div class="ap-row">
          <span class="ap-key mono">${line.name}</span>
          ${line.block ? html`<pre class="body">${line.value}</pre>` : html`<span class="mono">${line.value}</span>`}
        </div>`,
    )}
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

/** The agent's reason, quoted and attributed: the agent wrote it, heel didn't check it. */
function reasonView(request: ApprovalRequestView): Html | "" {
  if (request.reason === null) return "";
  return html`<figure class="reason">
    <figcaption>${request.agent} says (its own words; heel didn't check them)</figcaption>
    <blockquote>${request.reason}</blockquote>
  </figure>`;
}

/** What the request's status means for the approver, in one notice. */
const HINT_TONE: Record<HintTone, Tone> = { warn: "warn", note: "info", ok: "ok" };
const HINT_LABEL: Record<HintTone, string> = { warn: "check", note: "note", ok: "ok" };

/** Approval adapters' advice. Shown as advice: the person still decides. */
function hintsView(request: ApprovalRequestView): Html | "" {
  if (request.hints.length === 0) return "";
  const id = `hints-${request.id}`;
  return html`<section class="card ap-card" aria-labelledby="${id}">
    <div class="ap-card-head"><h2 id="${id}">Hints</h2></div>
    <p class="muted">Advice from ${request.hints.map((h) => h.adapter).join(", ")}. It can't approve or deny anything: you decide.</p>
    ${request.hints.map(({ adapter, result }) =>
      result.status === "pending"
        ? html`<p class="muted">Hints from ${adapter} are on the way. Reload in a few seconds.</p>`
        : result.status === "unavailable"
          ? html`<p class="muted">Hints from ${adapter} are unavailable for this request.</p>`
          : result.hints.length === 0
            ? html`<p class="muted">${adapter} has nothing to point out.</p>`
            : html`<ul class="hints">
              ${result.hints.map(
                (hint) =>
                  html`<li>${badge(HINT_LABEL[hint.tone], HINT_TONE[hint.tone])} ${hint.text}</li>`,
              )}
            </ul>`,
    )}
  </section>`;
}

function statusNotice(request: ApprovalRequestView, now: Date): Html {
  const decided = request.decision;
  switch (request.status) {
    case "pending":
      // The header carries the expiry and the decision bar says what approving does.
      return html``;
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
    ${
      request.runId === null
        ? ""
        : html`<div class="choice">
            <input type="radio" id="${fieldsetId}-run" name="scope" value="run" />
            <label for="${fieldsetId}-run"
              >Everything rule ${formatRule(request.rule)} asks about, for calls naming run
              <span class="mono">${request.runId}</span>, for at most a day. The agent names its own
              run, so it can reuse this id until then.</label
            >
          </div>`
    }
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
  // DOM order is approve once, approve as standing, deny; CSS puts deny first on the bar.
  return html`<section class="ap-decide" aria-labelledby="decide-${request.id}">
    <h2 id="decide-${request.id}" class="visually-hidden">Decide</h2>
    ${lockNote}
    <div class="ap-bar">
      ${ceremonyButton({
        callback: onDecide,
        intent: "approve-once",
        label: "Approve once",
        tone: "primary",
        binding,
        disabled: approveLocked,
        describedBy: helpId,
      })}
      ${ceremonyButton({
        callback: onDecide,
        intent: "deny",
        label: "Deny",
        tone: "danger",
        binding,
        disabled: expired,
        describedBy: helpId,
      })}
      <p id="${helpId}" class="ap-note">
        Every decision asks for your passkey. Nothing runs until you approve and the agent sends
        the same call again.
      </p>
    </div>
    ${
      request.origin === "org"
        ? standingOptions(request, fieldsetId, approveLocked)
        : html`<details class="ap-more">
            <summary>Approve for longer</summary>
            ${standingOptions(request, fieldsetId, approveLocked)}
            <div class="actions">
              ${ceremonyButton({
                callback: onDecide,
                intent: "approve-standing",
                label: "Approve as standing",
                tone: "secondary",
                binding,
                disabled: approveLocked,
                describedBy: helpId,
                optionsFrom: fieldsetId,
              })}
            </div>
          </details>`
    }
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
  const folds: Folds = props.folds ?? new Map();
  const said = headline(request);
  const view =
    request.email !== null
      ? emailView(request.email, `email-${request.id}`, folds)
      : request.merge !== null
        ? mergeView(request.merge, `merge-${request.id}`)
        : argumentsView(request, `what-${request.id}`);
  const windows = request.counts.map(
    (w) =>
      html`<li class="ap-fact">
        <span>This ${w.per}</span><strong>${plural(w.total, "item")}</strong>
      </li>`,
  );
  return html`<article class="ap" data-heel-fold-kind="${foldKind(request)}">
    <header class="card ap-head">
      <div class="ap-meta">
        <span class="ap-agent">${request.agent}</span>
        <span class="muted">on ${request.account}</span>
        <span class="muted">${request.runId === null ? "no run id" : html`run <span class="mono">${request.runId}</span>`}</span>
        <span class="muted">${formatRelative(request.createdAt, props.now)}</span>
        ${approvalStatusBadge(request.status)}
      </div>
      <h1 class="ap-title">
        ${said.agent} wants to <mark>${said.action}</mark> ${said.preposition}
        <mark>${said.place}</mark>${said.rest}
      </h1>
      ${reasonView(request)}
      <ul class="ap-facts">
        <li class="ap-fact">
          <span>Asked by rule</span><strong>${request.rule.name ?? formatRule(request.rule)}</strong>
        </li>
        ${windows}
        <li class="ap-fact">
          <span>${request.status === "pending" ? "Expires" : "Requested"}</span>
          <strong>${formatRelative(request.status === "pending" ? request.expiresAt : request.createdAt, props.now)}</strong>
        </li>
      </ul>
    </header>
    ${statusNotice(request, props.now)}
    ${view}
    ${hintsView(request)}
    <section class="card ap-card ap-details" aria-label="Details">
      ${fold(
        folds,
        "details",
        false,
        html`Rule and call details`,
        html`<dl class="facts">
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
          <dt>Request</dt>
          <dd class="mono">${request.id}</dd>
        </dl>`,
        "",
      )}
      ${fold(
        folds,
        "args",
        false,
        html`<span id="args-${request.id}">Full arguments, exactly what runs</span>`,
        html`<p class="muted">After heel's own rewrites. Nothing is shortened.</p>
          <pre class="args" tabindex="0" aria-labelledby="args-${request.id}">${formatArguments(
            request.args,
          )}</pre>`,
        "",
      )}
    </section>
    ${decisionControls(request, props.pause, props.onDecide)}
  </article>`;
}
