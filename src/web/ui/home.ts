import { formatRelative } from "./format.ts";
import { type Html, html, trusted } from "./html.ts";
import { CHEVRON_RIGHT } from "./icons.ts";
import { badge, type Tone } from "./layout.ts";
import { btn } from "./shadcn/button.ts";
import { actionPhrase } from "./summary.ts";

/**
 * The Home dashboard: a setup checklist until setup is done, a strip of one
 * tile per area (flagged only when something needs you), the last week's
 * calls and the latest decisions. Every status is also spelled out in words, never colour alone.
 */

export interface DayCount {
  /** Midnight UTC of the day. */
  day: Date;
  calls: number;
  allowed: number;
  denied: number;
  asked: number;
}

export interface RecentRow {
  at: Date;
  agent: string;
  kind: string;
  action: string | null;
  tool: string;
  account: string;
}

export interface HomeProps {
  now: Date;
  approvals: { waiting: number; decided: number };
  agents: { total: number; active: number; expiring: number };
  connections: { total: number; needsSignIn: number };
  rules: { loaded: boolean; count: number; stopped: number };
  setup: { passkey: boolean; notifications: boolean; account: boolean; agent: boolean };
  days: readonly DayCount[];
  recent: readonly RecentRow[];
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** What happened, in words, for the Recent list. */
const OUTCOME: Record<string, { word: string; tone: Tone | "muted" }> = {
  allow: { word: "allowed", tone: "ok" },
  executed: { word: "ran", tone: "ok" },
  approved: { word: "approved", tone: "ok" },
  deny: { word: "denied", tone: "error" },
  approval_denied: { word: "you denied", tone: "error" },
  ask: { word: "asked you", tone: "warn" },
  paused: { word: "paused", tone: "warn" },
  expired: { word: "expired", tone: "muted" },
  would_allow: { word: "would allow", tone: "muted" },
  would_deny: { word: "would deny", tone: "warn" },
  would_ask: { word: "would ask", tone: "warn" },
};

interface TileProps {
  href: string;
  title: string;
  big: number;
  /** One muted line under the number. */
  line: string;
  /** Shown only when something needs you, spelled out in words. */
  alert?: { word: string; tone: Tone };
}

/** One stat tile: label, big number, one line; the whole tile links to its page. */
function tile(p: TileProps): Html {
  return html`<li>
    <a class="home-tile" href="${p.href}"${p.alert ? html` data-alert="${p.alert.tone}"` : ""}>
      <span class="home-tile-head">
        <span class="home-tile-title">${p.title}</span>
        ${p.alert ? badge(p.alert.word, p.alert.tone) : ""}
      </span>
      <strong class="home-tile-big">${String(p.big)}</strong>
      <span class="home-tile-line">${p.line}</span>
    </a>
  </li>`;
}

function tiles(p: HomeProps): Html {
  const a = p.approvals;
  const g = p.agents;
  const c = p.connections;
  const r = p.rules;
  return html`<ul class="home-tiles" aria-label="What needs you">
    ${tile({
      href: "/approvals",
      title: "Waiting for you",
      big: a.waiting,
      line: `${String(a.decided)} decided in the last 24 hours`,
      ...(a.waiting > 0 ? { alert: { word: "needs you", tone: "warn" as const } } : {}),
    })}
    ${tile({
      href: "/agents",
      title: "Agents",
      big: g.total,
      line:
        g.expiring > 0
          ? `${String(g.expiring)} ${plural(g.expiring, "token expires", "tokens expire")} soon`
          : `${String(g.active)} active this week`,
      ...(g.expiring > 0 ? { alert: { word: "token expiring", tone: "warn" as const } } : {}),
    })}
    ${tile({
      href: "/connections",
      title: "Connections",
      big: c.total,
      line:
        c.needsSignIn > 0
          ? `${String(c.needsSignIn)} ${plural(c.needsSignIn, "needs", "need")} you to sign in again`
          : c.total === 0
            ? "None connected yet"
            : "All ready",
      ...(c.needsSignIn > 0 ? { alert: { word: "sign in again", tone: "warn" as const } } : {}),
    })}
    ${tile({
      href: "/rules",
      title: "Rules",
      big: r.count,
      line: r.loaded
        ? `${String(r.stopped)} ${plural(r.stopped, "call", "calls")} watch mode would stop this week`
        : "Didn't load: heel denies every call until they do",
      ...(r.loaded ? {} : { alert: { word: "didn't load", tone: "error" as const } }),
    })}
  </ul>`;
}

/** lucide's check. */
const CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;

function setup(p: HomeProps): Html | "" {
  const s = p.setup;
  const steps = [
    {
      done: s.passkey,
      label: "Add a passkey",
      line: "Sign in and decide with your face, fingerprint or security key.",
      href: "/devices#device-heading",
    },
    {
      done: s.notifications,
      label: "Turn on notifications",
      line: "Hear about a request the moment an agent's call needs you.",
      href: "/devices#push-heading",
    },
    {
      done: s.account,
      label: "Connect an account",
      line: "Gmail, Calendar, GitHub or any API your agents should reach through heel.",
      href: "/connections",
    },
    {
      done: s.agent,
      label: "Connect an agent",
      line: "Give an agent a token so its calls go through your rules.",
      href: "/agents",
    },
  ];
  const done = steps.filter((step) => step.done).length;
  if (done === steps.length) return "";
  const pct = Math.round((done / steps.length) * 100);
  return html`<section class="card home-setup" aria-labelledby="setup-heading">
    <div class="home-setup-head">
      <h2 id="setup-heading">Get set up</h2>
      <span class="home-setup-progress">
        <span class="muted">${String(done)} of ${String(steps.length)} done</span>
        <span class="home-setup-bar" role="progressbar" aria-label="Setup" aria-valuemin="0" aria-valuemax="${String(steps.length)}" aria-valuenow="${String(done)}"><span style="width:${String(pct)}%"></span></span>
      </span>
    </div>
    <ol class="home-steps">
      ${steps.map(
        (step) => html`<li data-done="${step.done ? "yes" : "no"}">
          <a href="${step.href}">
            <span class="home-step-mark" aria-hidden="true">${step.done ? trusted(CHECK) : ""}</span>
            <span class="home-step-text">
              <span class="home-step-label">${step.label}${step.done ? html`<span class="visually-hidden"> (done)</span>` : ""}</span>
              <span class="home-step-line">${step.line}</span>
            </span>
            <span class="home-step-go">${trusted(CHEVRON_RIGHT)}</span>
          </a>
        </li>`,
      )}
    </ol>
  </section>`;
}

/** lucide's chart-column. */
const CHART_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>`;

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function week(p: HomeProps): Html {
  const days = p.days;
  const max = Math.max(1, ...days.map((d) => d.calls));
  const total = days.reduce((n, d) => n + d.calls, 0);
  const sum = (key: "allowed" | "denied" | "asked") => days.reduce((n, d) => n + d[key], 0);
  const w = 14;
  const gap = 6;
  const h = 48;
  const bars = days.map((d, i) => {
    const bh = d.calls === 0 ? 2 : Math.max(4, Math.round((d.calls / max) * h));
    return html`<rect x="${String(i * (w + gap))}" y="${String(h - bh)}" width="${String(w)}" height="${String(bh)}" rx="3"${d.calls === 0 ? html` class="empty"` : ""}></rect>`;
  });
  const label = days.map((d) => `${DAY_NAMES[d.day.getUTCDay()]} ${String(d.calls)}`).join(", ");
  if (total === 0) {
    return html`<section class="card home-week" aria-labelledby="week-heading">
      <div class="home-week-head"><h2 id="week-heading">Calls in the last 7 days</h2></div>
      <div class="home-empty">
        <span class="home-empty-icon">${trusted(CHART_ICON)}</span>
        <p class="home-empty-title">No calls yet</p>
        <p class="muted">Calls your agents make through heel show up here, day by day.</p>
        ${p.setup.agent ? "" : html`<a class="${btn("outline", "sm")}" href="/agents">Connect an agent</a>`}
      </div>
    </section>`;
  }
  return html`<section class="card home-week" aria-labelledby="week-heading">
    <div class="home-week-head">
      <h2 id="week-heading">Calls in the last 7 days</h2>
      <strong class="home-week-total">${String(total)}</strong>
    </div>
    <svg class="home-spark" viewBox="0 0 ${String(7 * w + 6 * gap)} ${String(h)}" role="img" aria-label="Calls per day: ${label}">
      ${bars}
    </svg>
    <div class="home-spark-days muted" aria-hidden="true">
      ${days.map((d) => html`<span>${DAY_NAMES[d.day.getUTCDay()]}</span>`)}
    </div>
    <ul class="home-totals">
      <li>${badge("allowed", "ok")} ${String(sum("allowed"))}</li>
      <li>${badge("denied", "error")} ${String(sum("denied"))}</li>
      <li>${badge("asked", "warn")} ${String(sum("asked"))}</li>
    </ul>
  </section>`;
}

function recent(p: HomeProps): Html {
  return html`<section class="card home-recent" aria-labelledby="recent-heading">
    <div class="home-week-head">
      <h2 id="recent-heading">Recent</h2>
      <a class="home-more" href="/activity">View all <span aria-hidden="true">→</span></a>
    </div>
    ${
      p.recent.length === 0
        ? html`<p class="muted">No calls yet. They show up here as your agents work.</p>`
        : html`<ul class="home-recent-list">
            ${p.recent.map((row) => {
              const outcome = OUTCOME[row.kind] ?? {
                word: row.kind.replaceAll("_", " "),
                tone: "muted" as const,
              };
              return html`<li>
                <span class="home-recent-text"
                  ><strong>${row.agent}</strong> wanted to ${actionPhrase(row.action, row.tool)} on
                  <span class="mono">${row.account}</span></span
                >
                <span class="home-recent-meta">
                  ${badge(outcome.word, outcome.tone)}
                  <time class="muted" datetime="${row.at.toISOString()}">${formatRelative(row.at, p.now)}</time>
                </span>
              </li>`;
            })}
          </ul>`
    }
  </section>`;
}

export function homePage(p: HomeProps): Html {
  return html`<div class="home">
    <h1>Home</h1>
    <p class="muted home-lede">What needs you across heel, and what your agents did this week.</p>
    ${setup(p)} ${tiles(p)}
    <div class="home-split">${week(p)} ${recent(p)}</div>
  </div>`;
}
