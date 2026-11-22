import type { Suggestion } from "../../core/suggestions.ts";
import { TOKEN_WARNING_DAYS } from "../../gateway/agents.ts";
import type { ActivityRow, AgentActivity } from "../../store/activity.ts";
import { type Html, html } from "./html.ts";
import { badge, type FormTarget, notice, postForm, scrollRegion, time } from "./layout.ts";
import { addAgentForm, agentControls } from "./manage-agents.ts";

/**
 * The observability pages (A5): what agents did, as heel decided it. Every
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

export function activityRow(row: ActivityRow): Html {
  return html`<tr data-id="${String(row.id)}">
    <td>${time(row.at)}</td>
    <td>${badge(row.kind.replaceAll("_", " "), KIND_TONE[row.kind] ?? "muted")}${
      row.mode === null || row.mode === "enforce" ? "" : html` <span class="muted">(watch)</span>`
    }</td>
    <td class="mono">${row.account}</td>
    <td><span class="mono">${row.action ?? row.tool}</span>${
      row.scriptId === null
        ? ""
        : html` <a class="muted" href="/activity?script=${encodeURIComponent(row.scriptId)}" title="This script's calls">script</a>`
    }</td>
    <td>${row.rule === null ? html`<span class="muted">none</span>` : html`<span class="mono">${row.rule.name ?? `${row.rule.file}:${row.rule.line}`}</span>`}</td>
    <td class="muted">${row.reason ?? ""}</td>
  </tr>`;
}

export function activityPage(props: {
  rows: readonly ActivityRow[];
  agents: readonly { id: string; name: string }[];
  filter: {
    agent?: string | undefined;
    account?: string | undefined;
    kind?: string | undefined;
    /** One code-mode script's calls (C3). */
    script?: string | undefined;
  };
  nextBefore: number | null;
  hidden: Readonly<Record<string, number>> | null;
  suggestions: readonly Suggestion[];
  /** Rules suggested from what the viewer decided (2.10), as cards. */
  learned?: Html | "";
}): Html {
  const latest = props.rows[0]?.id ?? 0;
  const params = (extra: Record<string, string>) =>
    new URLSearchParams(
      Object.entries({ ...props.filter, ...extra }).filter(
        (e): e is [string, string] => e[1] !== undefined,
      ),
    ).toString();
  return html`<h1>Activity</h1>
    ${
      props.filter.script === undefined
        ? html`<p class="muted">Every decision heel made, newest first. New rows appear as they happen. Changes to the rules themselves are in the <a href="/rules/history">rule history</a>.</p>`
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
    <form method="get" action="/activity" class="filters">
      <label for="f-agent">Agent</label>
      <select id="f-agent" name="agent">
        <option value="">Any</option>
        ${props.agents.map((a) => html`<option value="${a.id}"${a.id === props.filter.agent ? html` selected` : ""}>${a.name}</option>`)}
      </select>
      <label for="f-account">Account</label>
      <input id="f-account" name="account" value="${props.filter.account ?? ""}" />
      <label for="f-kind">Decision</label>
      <input id="f-kind" name="kind" value="${props.filter.kind ?? ""}" placeholder="deny, would_deny, …" />
      <button type="submit" class="btn btn-secondary">Filter</button>
    </form>
    ${scrollRegion(
      "Decisions",
      html`<table class="data" id="activity" data-latest="${String(latest)}" data-filter="${params({})}">
        <caption>Decisions</caption>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Decision</th>
            <th scope="col">Account</th>
            <th scope="col">Action or tool</th>
            <th scope="col">Rule</th>
            <th scope="col">Reason</th>
          </tr>
        </thead>
        <tbody>
          ${props.rows.map(activityRow)}
        </tbody>
      </table>`,
    )}
    ${props.nextBefore === null ? "" : html`<p><a href="/activity?${params({ before: String(props.nextBefore) })}">Older</a></p>`}
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
  /** Managing agents here (2.9): who may, their workdirs, and what just happened. */
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
  /** Background scripts running or parked (C6), each with the form that stops it. */
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
      : html`<section class="card" aria-label="Background scripts">
          <h2 class="section-title">Running scripts</h2>
          <p class="muted">
            Code-mode scripts your agents run in the background. Every call in them is still checked
            by your rules. Stopping one needs no passkey.
          </p>
          <ul class="req-list">
            ${scripts.map(
              (s) => html`<li class="card">
                <p>
                  <span class="ap-agent">${s.agentName}</span>
                  ${badge(s.status === "parked" ? "waiting for approval" : "running", s.status === "parked" ? "warn" : "info")}
                  <span class="muted">started ${time(s.startedAt)}, ${String(s.calls)} ${s.calls === 1 ? "call" : "calls"} so far</span>
                  <a class="muted" href="/activity?script=${encodeURIComponent(s.id)}">its calls</a>
                  ${s.approvalId === null ? "" : html`<a href="/approvals/${encodeURIComponent(s.approvalId)}">the approval it waits on</a>`}
                </p>
                ${postForm(s.stop, {}, html`<button type="submit" class="btn btn-secondary">Stop</button>`)}
              </li>`,
            )}
          </ul>
        </section>`;
  return html`<h1>Agents</h1>
    <p class="muted">Every agent you may see, and what it did in the last ${String(props.sinceHours)} hours.</p>
    ${props.stopped === true ? notice("info", html`<p>Stopped. The script won't carry on.</p>`) : ""}
    ${props.manage?.done === null || props.manage?.done === undefined ? "" : notice("ok", html`<p>${props.manage.done}</p>`)}
    ${props.manage === undefined ? "" : addAgentForm()}
    ${running}
    ${
      expiring.length === 0
        ? ""
        : notice(
            "warn",
            html`<p>
              ${expiring.length === 1 ? "One agent's token" : `${String(expiring.length)} agents' tokens`}
              expire soon: ${expiring.map((a) => a.name).join(", ")}. Issue a new one with
              <code>heel agent rotate &lt;agent&gt;</code>, or under Manage below, and update the agent's configuration.
            </p>`,
          )
    }
    ${
      props.agents.length === 0
        ? html`<div class="card req-empty">
            <p><strong>No agents yet.</strong></p>
            <p class="muted">Add one above, or from the command line: <code>heel agent add &lt;name&gt;</code></p>
          </div>`
        : html`<ul class="conn-list agent-list" aria-label="Agents">
            ${props.agents.map((a) => agentCard(a, props.tokens?.get(a.agentId), now, props.manage))}
          </ul>`
    }`;
}

/** One agent: who owns it, its token, and what it did in the window. */
function agentCard(
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
        })
      : "";
  const stat = (label: string, value: number) =>
    html`<li><strong>${String(value)}</strong><span>${label}</span></li>`;
  return html`<li class="card conn" data-agent="${a.name}">
    <div class="conn-head">
      <div>
        <h2 class="conn-name mono"><a href="/activity?agent=${a.agentId}">${a.name}</a></h2>
        <p class="muted conn-kind">
          ${a.owner} · last call
          ${a.lastCallAt === null ? "never" : time(a.lastCallAt)}
        </p>
      </div>
      ${a.revoked ? badge("revoked", "muted") : ""}
    </div>
    <ul class="agent-stats" aria-label="${a.name} in this window">
      ${stat("calls", a.calls)} ${stat("allowed", a.allowed)} ${stat("denied", a.denied)}
      ${stat("asked", a.asked)} ${stat("would stop", a.wouldHaveStopped)}
    </ul>
    <p class="muted agent-foot">
      ${a.accounts.length === 0 ? "No accounts used" : html`Accounts: <span class="mono">${a.accounts.join(", ")}</span>`}
      ${a.revoked ? "" : html` · Token expires: ${tokenCell(token, now)}`}
    </p>
    ${controls}
  </li>`;
}

/** The live stream: appends rows the server sends to the explorer table. */
export const ACTIVITY_SCRIPT = `
(() => {
  const table = document.getElementById("activity");
  if (!table || !window.EventSource) return;
  const filter = table.dataset.filter;
  const source = new EventSource("/activity/stream?after=" + table.dataset.latest + (filter ? "&" + filter : ""));
  source.addEventListener("row", (event) => {
    const body = table.querySelector("tbody");
    body.insertAdjacentHTML("afterbegin", event.data);
  });
})();
`;
