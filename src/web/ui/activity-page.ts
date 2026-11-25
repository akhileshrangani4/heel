import { AUDIT_KINDS, type AuditKind } from "../../core/audit.ts";
import type { Suggestion } from "../../core/suggestions.ts";
import { TOKEN_WARNING_DAYS } from "../../gateway/agents.ts";
import type { ActivityRow, AgentActivity } from "../../store/activity.ts";
import { dialog, dialogTrigger } from "./dialog.ts";
import { formatRelative, formatUtc } from "./format.ts";
import { type Html, html, trusted } from "./html.ts";
import { CHEVRON_DOWN, X_ICON } from "./icons.ts";
import { badge, type FormTarget, notice, postForm, scrollRegion, time } from "./layout.ts";
import { addAgentForm, agentControls } from "./manage-agents.ts";
import { btn } from "./shadcn/button.ts";
import { actionPhrase } from "./summary.ts";

/**
 * The observability pages: what agents did, as heel decided it. Every
 * row here is an audit row; nothing is shown that the audit log doesn't
 * hold, and a person sees only their own agents' rows unless they're an
 * admin.
 */

const KIND_TONE: Record<string, "ok" | "warn" | "error" | "muted"> = {
  allow: "ok",
  executed: "ok",
  approved: "ok",
  deny: "error",
  approval_denied: "error",
  ask: "warn",
  paused: "warn",
  expired: "muted",
  would_allow: "muted",
  would_deny: "warn",
  would_ask: "warn",
};

/** Each decision in words, for its pill and the Decision filter. */
const KIND_LABEL: Record<AuditKind, string> = {
  allow: "allowed",
  deny: "denied",
  ask: "asked",
  paused: "paused",
  expired: "expired",
  approved: "approved",
  approval_denied: "you denied",
  executed: "ran",
  would_allow: "would allow",
  would_deny: "would deny",
  would_ask: "would ask",
};

/**
 * What happened, as a sentence built only from the audit row: who, the
 * action in heel's own words, and the account. Never the agent's text.
 */
export function activitySentence(row: ActivityRow, agent: string): string {
  const what = actionPhrase(row.action, row.tool);
  const on = `on ${row.account}`;
  switch (row.kind) {
    case "allow":
      return `${agent} was allowed to ${what} ${on}`;
    case "deny":
      return `${agent} was stopped from trying to ${what} ${on}`;
    case "ask":
      return `${agent} asked to ${what} ${on}`;
    case "paused":
      return `${agent} tried to ${what} ${on} while paused`;
    case "expired":
      return `${agent}'s request to ${what} ${on} expired`;
    case "approved":
      return `${agent}'s request to ${what} ${on} was approved`;
    case "approval_denied":
      return `${agent}'s request to ${what} ${on} was denied`;
    case "executed":
      return `${agent}'s approved request to ${what} ${on} ran`;
    case "would_allow":
      return `${agent} would have been allowed to ${what} ${on}`;
    case "would_deny":
      return `${agent} would have been stopped from trying to ${what} ${on}`;
    case "would_ask":
      return `${agent} would have had to ask to ${what} ${on}`;
  }
}

/** The UTC day a row falls on, as `YYYY-MM-DD`; headings and the live stream group by it. */
function dayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function dayLabel(day: string, now: Date): string {
  const today = dayKey(now);
  if (day === today) return "Today";
  if (day === dayKey(new Date(now.getTime() - 86_400_000))) return "Yesterday";
  const date = new Date(`${day}T00:00:00Z`);
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: date.getUTCFullYear() === now.getUTCFullYear() ? undefined : "numeric",
    timeZone: "UTC",
  });
}

const COLUMNS = 3;

/** lucide's download. */
const DOWNLOAD_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>`;

function dayRow(day: string, now: Date, count: number): Html {
  return html`<tr class="day" data-day="${day}"><th colspan="${String(COLUMNS)}" scope="colgroup">${dayLabel(day, now)} <span class="day-count">${String(count)}</span></th></tr>`;
}

/** The time of day, `HH:MM` UTC; the full instant is in the tooltip, the datetime and Details. */
function timeOfDay(at: Date): Html {
  return html`<time datetime="${at.toISOString()}" title="${formatUtc(at)}">${at.toISOString().slice(11, 16)}</time>`;
}

function ruleText(row: ActivityRow): string | null {
  if (row.rule === null) return null;
  return row.rule.name ?? `${row.rule.file}:${row.rule.line}`;
}

export function activityRow(row: ActivityRow, agentName?: string): Html {
  const watch = row.mode !== null && row.mode !== "enforce";
  const rule = ruleText(row);
  return html`<tr data-id="${String(row.id)}" data-day="${dayKey(row.at)}">
    <td class="act-kind">${badge(KIND_LABEL[row.kind] ?? row.kind.replaceAll("_", " "), KIND_TONE[row.kind] ?? "muted")}${
      watch ? html`<span class="muted act-watch">watch</span>` : ""
    }</td>
    <td class="act-what">
      <p class="act-sentence">${activitySentence(row, agentName ?? "An agent")}</p>
      <p class="act-meta">
        <code class="act-chip">${row.action ?? row.tool}</code>
        ${rule === null ? html`<span class="muted">no rule matched</span>` : html`<span class="muted">rule <span class="mono">${rule}</span></span>`}
        ${row.reason === null ? "" : html`<span class="muted act-reason">${row.reason}</span>`}
      </p>
      <details class="act-details">
        <summary>Details${trusted(CHEVRON_DOWN)}</summary>
        <dl class="facts">
          <dt>Account</dt><dd class="mono">${row.account} <span class="muted">(${row.provider})</span></dd>
          <dt>When</dt><dd>${time(row.at)}</dd>
          <dt>Tool</dt><dd class="mono">${row.tool}</dd>
          <dt>Rule</dt><dd>${row.rule === null ? html`<span class="muted">none</span>` : html`<span class="mono">${row.rule.name ?? ""} ${row.rule.file}:${String(row.rule.line)}</span>`}</dd>
          ${row.reason === null ? "" : html`<dt>Reason</dt><dd>${row.reason}</dd>`}
          ${watch ? html`<dt>Mode</dt><dd>${row.mode ?? ""} (the call ran; this is what your rules would have done)</dd>` : ""}
          ${row.approvalId === null ? "" : html`<dt>Approval</dt><dd><a class="mono" href="/approvals/${encodeURIComponent(row.approvalId)}">${row.approvalId}</a></dd>`}
          ${row.scriptId === null ? "" : html`<dt>Script</dt><dd><a href="/activity?script=${encodeURIComponent(row.scriptId)}">This script's calls</a></dd>`}
        </dl>
      </details>
    </td>
    <td class="act-when">${timeOfDay(row.at)}</td>
  </tr>`;
}

/** Rows with a heading before each new day, newest first. */
function rowsByDay(
  rows: readonly ActivityRow[],
  names: ReadonlyMap<string, string>,
  now: Date,
): Html[] {
  const out: Html[] = [];
  const perDay = new Map<string, number>();
  for (const row of rows) perDay.set(dayKey(row.at), (perDay.get(dayKey(row.at)) ?? 0) + 1);
  let current: string | null = null;
  for (const row of rows) {
    const day = dayKey(row.at);
    if (day !== current) {
      out.push(dayRow(day, now, perDay.get(day) ?? 0));
      current = day;
    }
    out.push(activityRow(row, names.get(row.agentId)));
  }
  return out;
}

type ActivityFilter = {
  agent?: string | undefined;
  account?: string | undefined;
  kind?: string | undefined;
  script?: string | undefined;
};

/** lucide's list-filter. */
const FILTER_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M7 12h10"/><path d="M10 18h4"/></svg>`;
/** lucide's check, shown on the chosen option. */
const OPTION_CHECK = `<svg class="act-option-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;

/** `/activity` with the filter's params, minus `drop`. */
function activityHref(filter: ActivityFilter, drop?: keyof ActivityFilter): string {
  const query = new URLSearchParams(
    Object.entries(filter).filter(
      (e): e is [string, string] => e[1] !== undefined && e[0] !== drop,
    ),
  ).toString();
  return query === "" ? "/activity" : `/activity?${query}`;
}

function option(name: string, value: string, label: string, checked: boolean): Html {
  return html`<label class="act-option"><input type="radio" name="${name}" value="${value}"${checked ? html` checked` : ""} /><span>${label}</span>${trusted(OPTION_CHECK)}</label>`;
}

/**
 * One Filter button that opens a panel with agent, account and decision as
 * lists of choices; Apply submits it as a plain GET form, so it works with no
 * script. The live stream reads the same params from the table.
 */
function filterMenu(
  filter: ActivityFilter,
  agents: readonly { id: string; name: string }[],
  accounts: readonly string[],
): Html {
  const accountChoices =
    filter.account !== undefined && !accounts.includes(filter.account)
      ? [filter.account, ...accounts]
      : accounts;
  return html`<details class="act-filter">
    <summary class="${btn("outline", "sm")}">${trusted(FILTER_ICON)}Filter</summary>
    <form method="get" action="/activity" class="act-filter-panel">
      ${filter.script === undefined ? "" : html`<input type="hidden" name="script" value="${filter.script}" />`}
      <div class="act-filter-groups">
        <fieldset class="act-filter-group">
          <legend>Agent</legend>
          ${option("agent", "", "Any agent", filter.agent === undefined)}
          ${agents.map((a) => option("agent", a.id, a.name, a.id === filter.agent))}
        </fieldset>
        <fieldset class="act-filter-group">
          <legend>Account</legend>
          ${
            accountChoices.length === 0
              ? html`<label class="visually-hidden" for="f-account">Account</label><input id="f-account" name="account" placeholder="Any account" value="${filter.account ?? ""}" />`
              : html`${option("account", "", "Any account", filter.account === undefined)}${accountChoices.map((name) => option("account", name, name, name === filter.account))}`
          }
        </fieldset>
        <fieldset class="act-filter-group">
          <legend>Decision</legend>
          ${option("kind", "", "Any decision", filter.kind === undefined)}
          ${AUDIT_KINDS.map((kind) => option("kind", kind, KIND_LABEL[kind], kind === filter.kind))}
        </fieldset>
      </div>
      <div class="act-filter-actions">
        <a class="${btn("ghost", "sm")}" href="${filter.script === undefined ? "/activity" : `/activity?script=${encodeURIComponent(filter.script)}`}">Clear</a>
        <button type="submit" class="${btn("default", "sm")}">Apply</button>
      </div>
    </form>
  </details>`;
}

/** The filters in force, each with an x that drops it. */
function filterChips(filter: ActivityFilter, names: ReadonlyMap<string, string>): Html | "" {
  const chips: Html[] = [];
  const chip = (label: string, value: string, key: keyof ActivityFilter) =>
    chips.push(
      html`<span class="act-chip-filter">${label}: <strong>${value}</strong><a href="${activityHref(filter, key)}" aria-label="Remove the ${label.toLowerCase()} filter">${trusted(X_ICON)}</a></span>`,
    );
  if (filter.agent !== undefined) chip("Agent", names.get(filter.agent) ?? filter.agent, "agent");
  if (filter.account !== undefined) chip("Account", filter.account, "account");
  if (filter.kind !== undefined)
    chip("Decision", KIND_LABEL[filter.kind as AuditKind] ?? filter.kind, "kind");
  return chips.length === 0 ? "" : html`${chips}`;
}

export function activityPage(props: {
  rows: readonly ActivityRow[];
  agents: readonly { id: string; name: string }[];
  /** Account names seen in the audit log, for the filter; a text box without them. */
  accounts?: readonly string[];
  now?: Date;
  filter: {
    agent?: string | undefined;
    account?: string | undefined;
    kind?: string | undefined;
    /** One code-mode script's calls. */
    script?: string | undefined;
  };
  nextBefore: number | null;
  /** True on an older page (the URL carried `before`), so "Newer" goes back to the latest. */
  paged?: boolean;
  hidden: Readonly<Record<string, number>> | null;
  suggestions: readonly Suggestion[];
  /** Rules suggested from what the viewer decided, as cards. */
  learned?: Html | "";
  /** An admin: they may download the whole audit log. */
  canExport?: boolean;
}): Html {
  const now = props.now ?? new Date();
  const latest = props.rows[0]?.id ?? 0;
  const names = new Map(props.agents.map((a) => [a.id, a.name]));
  const params = (extra: Record<string, string>) =>
    new URLSearchParams(
      Object.entries({ ...props.filter, ...extra }).filter(
        (e): e is [string, string] => e[1] !== undefined,
      ),
    ).toString();
  const filtered =
    props.filter.agent !== undefined ||
    props.filter.account !== undefined ||
    props.filter.kind !== undefined;
  const accounts = props.accounts ?? [];
  return html`<h1>Activity</h1>
    ${
      props.filter.script === undefined
        ? html`<p class="muted">Every decision heel made, newest first. New ones appear as they happen.</p>`
        : html`<p>
            One script's calls, newest first, including those made after it was parked and
            resumed. <a href="/activity">All activity</a>
          </p>`
    }
    ${
      props.hidden === null
        ? ""
        : html`<p class="muted">
            Hidden from agents since heel started: ${String(props.hidden["matched"] ?? 0)} by a hide
            entry, ${String(props.hidden["uncertain"] ?? 0)} because looks_like wasn't sure,
            ${String(props.hidden["unparseable"] ?? 0)} because an address didn't parse.
          </p>`
    }
    <div class="act-toolbar">
      <div class="act-filter-bar">${filterMenu(props.filter, props.agents, accounts)} ${filterChips(props.filter, names)}</div>
      ${
        props.canExport === true
          ? html`<details class="audit-export">
          <summary class="${btn("outline", "icon-sm")}" title="Download the audit log"><span class="visually-hidden">Download the audit log</span>${trusted(DOWNLOAD_ICON)}</summary>
          <div class="audit-export-panel">
            <p class="audit-export-title">Download the audit log</p>
            <p class="muted">Every decision for everyone on this heel, one JSON object per line, as <code>heel audit export</code> writes it. Leave the days empty for all of it.</p>
            <form method="get" action="/activity/export" class="stack-form">
              <div class="row">
                <label for="export-since">From (day)</label>
                <input id="export-since" name="since" type="date" />
              </div>
              <div class="row">
                <label for="export-until">To (day, included)</label>
                <input id="export-until" name="until" type="date" />
              </div>
              <button type="submit" class="${btn("outline")}">Download (.jsonl)</button>
            </form>
          </div>
        </details>`
          : ""
      }
    </div>
    ${
      props.paged === true
        ? ""
        : html`<p class="act-live-note" id="activity-live-note" role="status" hidden>Signed out. <a href="/sign-in?next=${encodeURIComponent(activityHref(props.filter))}">Sign in</a> to see new activity.</p>`
    }
    ${
      props.rows.length === 0
        ? html`<div class="card req-empty">
            <p><strong>${filtered ? "Nothing matches these filters." : "No decisions yet."}</strong></p>
            <p class="muted">${filtered ? "Try another agent, account or decision, or clear the filters." : "Calls your agents make through heel show up here as they happen."}</p>
          </div>`
        : ""
    }
    ${scrollRegion(
      "Decisions",
      html`<table class="data act-table" id="activity" data-latest="${String(latest)}" data-today="${dayKey(now)}" data-filter="${params({})}"${props.paged === true ? "" : html` data-live`}${props.rows.length === 0 ? html` hidden` : ""}>
        <caption class="visually-hidden">Decisions</caption>
        <thead class="visually-hidden">
          <tr>
            <th scope="col">Decision</th>
            <th scope="col">What happened</th>
            <th scope="col">When</th>
          </tr>
        </thead>
        <tbody>
          ${rowsByDay(props.rows, names, now)}
        </tbody>
      </table>`,
    )}
    ${
      props.rows.length === 0 || (props.nextBefore === null && props.paged !== true)
        ? ""
        : html`<nav class="act-pages" aria-label="Pages">
            <span class="muted">Showing ${String(props.rows.length)} ${props.paged === true ? "older " : ""}${props.rows.length === 1 ? "decision" : "decisions"}</span>
            <span class="act-pages-buttons">
              ${
                props.paged === true
                  ? html`<a class="${btn("outline", "sm")}" href="/activity${params({}) ? `?${params({})}` : ""}">Newer</a>`
                  : html`<span class="${btn("outline", "sm")}" aria-disabled="true">Newer</span>`
              }
              ${
                props.nextBefore === null
                  ? html`<span class="${btn("outline", "sm")}" aria-disabled="true">Older</span>`
                  : html`<a class="${btn("outline", "sm")}" href="/activity?${params({ before: String(props.nextBefore) })}">Older</a>`
              }
            </span>
          </nav>`
    }
    ${props.learned ?? ""}
    <h2>Suggested from Watch mode</h2>
    <p class="muted">
      Drawn from Watch mode: calls your rules would have stopped, grouped by account and
      action. Suggestions are only text. Read them, edit them, and add the ones you want to your rules
      file. Sends are suggested as ask, never allow.
    </p>
    ${
      props.suggestions.length === 0
        ? html`<p class="muted">Nothing yet. Run in Watch mode for a while.</p>`
        : html`<pre class="mono">${props.suggestions.map((s) => s.yaml).join("\n")}</pre>`
    }`;
}

/** A token's expiry for the Agents page: a date (warned within 14 days), never, or none. */
function tokenCell(expiry: Date | "never" | null | undefined, now: Date): Html {
  if (expiry === null || expiry === undefined) return html`<span class="muted">none</span>`;
  if (expiry === "never") return html`<span class="muted">never</span>`;
  const days = Math.ceil((expiry.getTime() - now.getTime()) / 86_400_000);
  if (days <= 0) return badge("expired", "error");
  if (days <= TOKEN_WARNING_DAYS) return html`${time(expiry)} ${badge(`in ${days}d`, "warn")}`;
  return time(expiry);
}

export function agentsPage(props: {
  agents: readonly AgentActivity[];
  sinceHours: number;
  /** Managing agents here: who may, their workdirs, and what just happened. */
  manage?: {
    csrfToken: string;
    viewerId: string;
    admin: boolean;
    workRoots: ReadonlyMap<string, readonly string[]>;
    done: string | null;
  };
  /** Each agent's static token expiry: a date, "never", or null without one. */
  tokens?: ReadonlyMap<string, Date | "never" | null>;
  now?: Date;
  /** Background scripts running or parked, each with the form that stops it. */
  scripts?: readonly {
    id: string;
    agentName: string;
    status: string;
    approvalId: string | null;
    calls: number;
    startedAt: Date;
    stop: FormTarget;
  }[];
  /** True right after the viewer stopped one. */
  stopped?: boolean;
}): Html {
  const now = props.now ?? new Date();
  const expiring = props.agents.filter((a) => {
    const t = props.tokens?.get(a.agentId);
    return (
      !a.revoked &&
      t instanceof Date &&
      t.getTime() - now.getTime() <= TOKEN_WARNING_DAYS * 86_400_000
    );
  });
  const scripts = props.scripts ?? [];
  const running =
    scripts.length === 0
      ? ""
      : html`<section aria-labelledby="scripts-heading" class="agents-section">
          <h2 id="scripts-heading">Running scripts</h2>
          <p class="muted">
            Code-mode scripts your agents run in the background. Every call in them is still checked
            by your rules. Stopping one needs no passkey.
          </p>
          ${scrollRegion(
            "Running scripts",
            html`<table class="data rows-table">
              <caption class="visually-hidden">Running scripts</caption>
              <thead>
                <tr><th scope="col">Agent</th><th scope="col">Status</th><th scope="col">Started</th><th scope="col">Calls</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr>
              </thead>
              <tbody>
                ${scripts.map(
                  (s) => html`<tr>
                    <td><strong>${s.agentName}</strong>
                      <span class="cell-sub"><a href="/activity?script=${encodeURIComponent(s.id)}">Its calls</a>${s.approvalId === null ? "" : html` · <a href="/approvals/${encodeURIComponent(s.approvalId)}">The approval it waits on</a>`}</span></td>
                    <td>${badge(s.status === "parked" ? "waiting for approval" : "running", s.status === "parked" ? "warn" : "info")}</td>
                    <td class="muted">${relative(s.startedAt, now)}</td>
                    <td>${String(s.calls)}</td>
                    <td class="cell-actions">${postForm(s.stop, {}, html`<button type="submit" class="${btn("outline", "sm")}">Stop</button>`)}</td>
                  </tr>`,
                )}
              </tbody>
            </table>`,
          )}
        </section>`;
  return html`<div class="page-head">
      <div>
        <h1>Agents</h1>
        <p class="muted">Every agent you may see, and what it did in the last ${String(props.sinceHours)} hours.</p>
      </div>
      ${props.manage === undefined ? "" : dialogTrigger({ dialogId: "add-agent-dialog", label: html`<span aria-hidden="true">+</span> Add agent`, className: btn("default", "sm") })}
    </div>
    ${
      props.manage === undefined
        ? ""
        : dialog({
            id: "add-agent-dialog",
            title: "Add an agent",
            description:
              "Its token is shown once, on the next page. Copy it into the agent's MCP settings.",
            body: addAgentForm(),
          })
    }
    ${props.stopped === true ? notice("info", html`<p>Stopped. The script won't carry on.</p>`) : ""}
    ${props.manage?.done === null || props.manage?.done === undefined ? "" : notice("ok", html`<p>${props.manage.done}</p>`)}
    ${
      expiring.length === 0
        ? ""
        : notice(
            "warn",
            html`<p>
              ${expiring.length === 1 ? "One agent's token expires" : `${String(expiring.length)} agents' tokens expire`}
              soon: ${expiring.map((a) => a.name).join(", ")}. Give it a new one with
              <code>heel agent rotate &lt;agent&gt;</code>, or from its ⋯ menu, and update the agent's configuration.
            </p>`,
          )
    }
    ${running}
    ${
      props.agents.length === 0
        ? html`<div class="req-empty">
            <span class="req-empty-icon agents-empty-icon">${trusted(BOT_ICON)}</span>
            <p class="req-empty-title">No agents yet</p>
            <p class="muted">${props.manage === undefined ? "" : "Add one with Add agent, or "}from the command line: <code>heel agent add &lt;name&gt;</code></p>
          </div>`
        : scrollRegion(
            "Agents",
            html`<table class="data rows-table agents-table">
              <caption class="visually-hidden">Agents</caption>
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  <th scope="col">Last call</th>
                  <th scope="col">Last ${String(props.sinceHours)}h</th>
                  <th scope="col">Token</th>
                  <th scope="col">Status</th>
                  <th scope="col"><span class="visually-hidden">Manage</span></th>
                </tr>
              </thead>
              <tbody>
                ${props.agents.map((a) => agentRow(a, props.tokens?.get(a.agentId), now, props.manage))}
              </tbody>
            </table>`,
          )
    }`;
}

/** lucide's bot. */
const BOT_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>`;

/** A relative time, with the full UTC instant in the tooltip and the datetime. */
function relative(at: Date, now: Date): Html {
  return html`<time datetime="${at.toISOString()}" title="${formatUtc(at)}">${formatRelative(at, now)}</time>`;
}

/** What an agent did in the window, as one line of words. */
function windowLine(a: AgentActivity): string {
  const parts = [`${String(a.calls)} ${a.calls === 1 ? "call" : "calls"}`];
  if (a.denied > 0) parts.push(`${String(a.denied)} denied`);
  if (a.asked > 0) parts.push(`${String(a.asked)} asked`);
  if (a.wouldHaveStopped > 0) parts.push(`would stop ${String(a.wouldHaveStopped)}`);
  return parts.join(" · ");
}

/** One agent: who owns it, its last call, what it did in the window, its token, and its controls. */
function agentRow(
  a: AgentActivity,
  token: Date | "never" | null | undefined,
  now: Date,
  manage?: {
    csrfToken: string;
    viewerId: string;
    admin: boolean;
    workRoots: ReadonlyMap<string, readonly string[]>;
  },
): Html {
  const controls =
    manage !== undefined && !a.revoked && (manage.admin || a.ownerId === manage.viewerId)
      ? agentControls({
          name: a.name,
          workRoots: manage.workRoots.get(a.agentId) ?? [],
          csrfToken: manage.csrfToken,
          own: a.ownerId === manage.viewerId,
        })
      : "";
  return html`<tr data-agent="${a.name}"${a.revoked ? html` data-revoked` : ""}>
    <td>
      <a class="agent-name" href="/activity?agent=${a.agentId}">${a.name}</a>
      <span class="cell-sub">${a.owner}${a.accounts.length === 0 ? "" : html` · <span class="mono">${a.accounts.join(", ")}</span>`}</span>
    </td>
    <td class="muted">${a.lastCallAt === null ? "never" : relative(a.lastCallAt, now)}</td>
    <td class="muted">${windowLine(a)}</td>
    <td>${a.revoked ? html`<span class="muted">none</span>` : tokenCell(token, now)}</td>
    <td>${a.revoked ? badge("revoked", "muted") : badge("active", "ok")}</td>
    <td class="cell-actions">${controls}</td>
  </tr>`;
}

/**
 * The Filter and Download panels: Escape or a click outside closes them (on
 * a phone the filter sheet covers its own button), and opening one closes
 * the other.
 */
export const ACTIVITY_PANELS_SCRIPT = `
(() => {
  const panels = [...document.querySelectorAll("details.act-filter, details.audit-export")];
  for (const panel of panels) {
    panel.addEventListener("toggle", () => {
      if (panel.open) for (const other of panels) if (other !== panel) other.open = false;
    });
  }
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    for (const panel of panels) {
      if (!panel.open) continue;
      panel.open = false;
      panel.querySelector("summary").focus();
    }
  });
  document.addEventListener("click", (event) => {
    for (const panel of panels) if (panel.open && !panel.contains(event.target)) panel.open = false;
  });
})();
`;

/**
 * The live stream: puts each row the server sends under its day's heading,
 * adding "Today" (or the day, in words as the server writes it) when the
 * newest heading is another day.
 */
export const ACTIVITY_SCRIPT = `${ACTIVITY_PANELS_SCRIPT}
(() => {
  const table = document.getElementById("activity");
  // An older page doesn't take live rows: they belong on the newest page.
  if (!table || !table.hasAttribute("data-live") || !window.EventSource) return;
  const filter = table.dataset.filter;
  const source = new EventSource("/activity/stream?after=" + table.dataset.latest + (filter ? "&" + filter : ""));
  const dayName = (day) =>
    day === table.dataset.today
      ? "Today"
      : new Date(day + "T00:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
  source.addEventListener("row", (event) => {
    const body = table.querySelector("tbody");
    const holder = document.createElement("tbody");
    holder.innerHTML = event.data;
    const row = holder.firstElementChild;
    if (!row) return;
    const day = row.dataset.day;
    let head = body.querySelector("tr.day");
    if (!head || head.dataset.day !== day) {
      head = document.createElement("tr");
      head.className = "day";
      head.dataset.day = day;
      const cell = document.createElement("th");
      cell.colSpan = ${String(COLUMNS)};
      cell.scope = "colgroup";
      cell.textContent = dayName(day) + " ";
      const count = document.createElement("span");
      count.className = "day-count";
      count.textContent = "0";
      cell.appendChild(count);
      head.appendChild(cell);
      body.insertBefore(head, body.firstChild);
    }
    const count = head.querySelector(".day-count");
    if (count) count.textContent = String(Number(count.textContent || "0") + 1);
    head.after(row);
    table.hidden = false;
    const empty = table.closest(".table-scroll")?.previousElementSibling;
    if (empty && empty.classList.contains("req-empty")) empty.remove();
  });
  // A dropped connection or the server's own 10-minute end leaves the source
  // CONNECTING, and it resumes by itself. CLOSED means heel answered with
  // something other than a stream: if a session check now gets 401, the
  // session ended, so say so and offer sign-in. Rows on screen stay.
  source.addEventListener("error", async () => {
    if (source.readyState !== EventSource.CLOSED) return;
    try {
      const check = await fetch("/activity", { method: "HEAD", redirect: "manual" });
      if (check.status !== 401) return;
    } catch { return; }
    const note = document.getElementById("activity-live-note");
    if (note) note.hidden = false;
  });
})();
`;
