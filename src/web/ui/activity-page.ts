import type { Suggestion } from "../../core/suggestions.ts";
import { TOKEN_WARNING_DAYS } from "../../gateway/agents.ts";
import type { ActivityRow, AgentActivity } from "../../store/activity.ts";
import { type Html, html } from "./html.ts";
import { badge, notice, scrollRegion, time } from "./layout.ts";

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
    <td class="mono">${row.action ?? row.tool}</td>
    <td>${row.rule === null ? html`<span class="muted">none</span>` : html`<span class="mono">${row.rule.name ?? `${row.rule.file}:${row.rule.line}`}</span>`}</td>
    <td class="muted">${row.reason ?? ""}</td>
  </tr>`;
}

export function activityPage(props: {
  rows: readonly ActivityRow[];
  agents: readonly { id: string; name: string }[];
  filter: { agent?: string | undefined; account?: string | undefined; kind?: string | undefined };
  nextBefore: number | null;
  hidden: Readonly<Record<string, number>> | null;
  suggestions: readonly Suggestion[];
}): Html {
  const latest = props.rows[0]?.id ?? 0;
  const params = (extra: Record<string, string>) =>
    new URLSearchParams(
      Object.entries({ ...props.filter, ...extra }).filter(
        (e): e is [string, string] => e[1] !== undefined,
      ),
    ).toString();
  return html`<h1>Activity</h1>
    <p class="muted">Every decision heel made, newest first. New rows appear as they happen.</p>
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
    <h2>Suggested rules</h2>
    <p class="muted">
      Drawn from shadow and record mode: calls your rules would have stopped, grouped by account and
      action. Suggestions are only text. Read them, edit them, and add the ones you want to your rules
      file. Sends are suggested as ask, never allow.
    </p>
    ${
      props.suggestions.length === 0
        ? html`<p class="muted">Nothing yet. Run in shadow or record mode for a while.</p>`
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
  /** Each agent's static token expiry: a date, "never", or null without one. */
  tokens?: ReadonlyMap<string, Date | "never" | null>;
  now?: Date;
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
  return html`<h1>Agents</h1>
    <p class="muted">Every agent you may see, and what it did in the last ${String(props.sinceHours)} hours.</p>
    ${
      expiring.length === 0
        ? ""
        : notice(
            "warn",
            html`<p>
              ${expiring.length === 1 ? "One agent's token" : `${String(expiring.length)} agents' tokens`}
              expire soon: ${expiring.map((a) => a.name).join(", ")}. Issue a new one with
              <code>heel agent rotate &lt;agent&gt;</code> and update the agent's configuration.
            </p>`,
          )
    }
    ${scrollRegion(
      "Agents",
      html`<table class="data">
        <caption>Agents</caption>
        <thead>
          <tr>
            <th scope="col">Agent</th>
            <th scope="col">Owner</th>
            <th scope="col">Last call</th>
            <th scope="col">Calls</th>
            <th scope="col">Allowed</th>
            <th scope="col">Denied</th>
            <th scope="col">Asked</th>
            <th scope="col">Would have stopped</th>
            <th scope="col">Accounts</th>
            <th scope="col">Token expires</th>
          </tr>
        </thead>
        <tbody>
          ${props.agents.map(
            (a) => html`<tr>
              <th scope="row"><a href="/activity?agent=${a.agentId}">${a.name}</a>${a.revoked ? html` ${badge("revoked", "muted")}` : ""}</th>
              <td>${a.owner}</td>
              <td>${a.lastCallAt === null ? html`<span class="muted">never</span>` : time(a.lastCallAt)}</td>
              <td>${String(a.calls)}</td>
              <td>${String(a.allowed)}</td>
              <td>${String(a.denied)}</td>
              <td>${String(a.asked)}</td>
              <td>${String(a.wouldHaveStopped)}</td>
              <td class="mono">${a.accounts.join(", ")}</td>
              <td>${a.revoked ? "" : tokenCell(props.tokens?.get(a.agentId), now)}</td>
            </tr>`,
          )}
        </tbody>
      </table>`,
    )}`;
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
