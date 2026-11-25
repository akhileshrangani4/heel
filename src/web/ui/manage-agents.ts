import { TOKEN_WARNING_DAYS } from "../../gateway/agents.ts";
import type { AgentActivity } from "../../store/activity.ts";
import { ceremonyButton } from "./ceremony.ts";
import { dialog, dialogTrigger } from "./dialog.ts";
import { formatRelative, formatUtc } from "./format.ts";
import { type Html, html, trusted } from "./html.ts";
import { ELLIPSIS } from "./icons.ts";
import { badge, type FormTarget, notice, postForm, scrollRegion, time } from "./layout.ts";
import { btn } from "./shadcn/button.ts";

/**
 * The Agents page, and managing agents from it: adding one, a new token, a
 * revoke, workdirs. Adding and giving power ask for a passkey; taking it away
 * is a plain button.
 */

const DAYS = [
  { value: "90", label: "90 days" },
  { value: "30", label: "30 days" },
  { value: "365", label: "A year" },
  { value: "never", label: "Never expires" },
];

function daysSelect(id: string): Html {
  return html`<select id="${id}" name="days">
    ${DAYS.map((d) => html`<option value="${d.value}">${d.label}</option>`)}
  </select>`;
}

/** The form that adds an agent: its name, and how long its token lasts. Shown in the Add an agent dialog. */
export function addAgentForm(): Html {
  return html`<form id="add-agent-form" class="stack-form dialog-form" onsubmit="return false">
      <input type="hidden" name="op" value="add" />
      <div class="row">
        <label for="add-agent-name">Name</label>
        <input id="add-agent-name" name="name" maxlength="64" placeholder="claude-code" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
      </div>
      <div class="row">
        <label for="add-agent-days">Token lasts</label>
        ${daysSelect("add-agent-days")}
      </div>
      ${ceremonyButton({
        callback: { handler: "manageAgent" },
        intent: "manage-agent",
        label: "Add with your passkey",
        tone: "primary",
        binding: {},
        optionsFrom: "add-agent-form",
        statusId: "add-agent-status",
      })}
      <p id="add-agent-status" class="dialog-status" role="status" aria-live="polite"></p>
    </form>`;
}

/** One live agent's controls: a new token, workdirs, revoke. */
export function agentControls(props: {
  name: string;
  workRoots: readonly string[];
  csrfToken: string;
  /** The viewer's own agent: only then a new token or a new workdir (admins can only take away). */
  own: boolean;
}): Html {
  const key = props.name.replace(/[^A-Za-z0-9_-]/g, "-");
  return html`<details class="row-manage">
    <summary class="${btn("ghost", "icon-sm")}" title="Manage ${props.name}"><span class="visually-hidden">Manage ${props.name}</span>${trusted(ELLIPSIS)}</summary>
    <div class="row-manage-panel">
    ${
      props.own
        ? html`<form id="rotate-${key}" onsubmit="return false">
      <label for="rotate-${key}-days">New token lasts</label>
      ${daysSelect(`rotate-${key}-days`)}
      ${ceremonyButton({
        callback: { handler: "manageAgent" },
        intent: "manage-agent",
        label: "New token",
        tone: "secondary",
        binding: { op: "rotate", name: props.name },
        optionsFrom: `rotate-${key}`,
      })}
      <p class="muted">The old token stops working at once, and its running scripts stop.</p>
    </form>`
        : ""
    }
    <h3>Folders its heel run may work in</h3>
    ${
      props.workRoots.length === 0
        ? html`<p class="muted">None yet.</p>`
        : html`<ul class="workdirs">
            ${props.workRoots.map(
              (root) =>
                html`<li><code>${root}</code> ${postForm(
                  {
                    action: `/agents/${encodeURIComponent(props.name)}/workdirs/remove`,
                    csrfToken: props.csrfToken,
                  },
                  { path: root },
                  html`<button type="submit" class="${btn("outline")}">Remove</button>`,
                )}</li>`,
            )}
          </ul>`
    }
    ${
      props.own
        ? html`<form id="workdir-${key}" onsubmit="return false">
      <label for="workdir-${key}-path">Add a folder (an absolute path on heel's machine)</label>
      <input id="workdir-${key}-path" name="path" placeholder="/home/you/project" autocomplete="off" />
      ${ceremonyButton({
        callback: { handler: "manageAgent" },
        intent: "manage-agent",
        label: "Add with your passkey",
        tone: "secondary",
        binding: { op: "workdir", name: props.name },
        optionsFrom: `workdir-${key}`,
      })}
    </form>`
        : ""
    }
    ${postForm(
      { action: `/agents/${encodeURIComponent(props.name)}/revoke`, csrfToken: props.csrfToken },
      {},
      html`<button type="submit" class="${btn("danger")}" onclick="return confirm('Revoke ${props.name}? Its tokens stop working at once, and its name can\\'t be used again.')">Revoke ${props.name}</button>`,
    )}
    </div>
  </details>`;
}

/** A new token, shown once; or why it can't be shown. */
export function newTokenPage(
  view: { name: string; token: string; expiresAt: string | null; mcpUrl: string | null } | null,
): Html {
  if (view === null) {
    return html`<h1>New agent token</h1>
      ${notice(
        "info",
        html`<p>This token was already shown, or more than 5 minutes have passed. heel doesn't keep it.
          Give the agent another from <a href="/agents">Agents</a>.</p>`,
      )}`;
  }
  const command =
    view.mcpUrl === null
      ? null
      : `claude mcp add --scope user --transport http heel ${view.mcpUrl} --header "Authorization: Bearer ${view.token}"`;
  return html`<h1>${view.name}'s token</h1>
    ${notice(
      "warn",
      html`<p><strong>Copy it now: heel shows it only this once.</strong> Anyone with it can act as
        ${view.name} through heel, within your rules.</p>`,
    )}
    <p><label for="new-token">Token</label></p>
    <input id="new-token" class="mono" readonly value="${view.token}" onclick="this.select()" />
    <p class="muted">${view.expiresAt === null ? "It never expires." : html`It expires ${time(new Date(view.expiresAt))}.`}</p>
    ${
      view.mcpUrl === null
        ? ""
        : html`<h2>Add it to the agent</h2>
          <p>MCP address: <code>${view.mcpUrl}</code>, with the token as a bearer token.</p>
          <p>For Claude Code:</p>
          <input class="mono" readonly value="${command ?? ""}" onclick="this.select()" />`
    }
    <p><a class="${btn()}" href="/agents">Done</a></p>`;
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
