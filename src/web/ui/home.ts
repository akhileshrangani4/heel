import { formatRelative, formatShort, middle } from "./format.ts";
import { type Html, html, trusted } from "./html.ts";
import { CHEVRON_RIGHT } from "./icons.ts";
import { badge, type Tone } from "./layout.ts";
import { serviceLogo } from "./logos.ts";
import { EXPIRY_SHOWN_WITHIN_MS, serviceIcon } from "./pending-list.ts";
import { btn } from "./shadcn/button.ts";
import { actionPhrase, type Headline } from "./summary.ts";

/**
 * The Home dashboard: what waits for you, listed, then a setup checklist
 * until setup is done, a strip of one tile per area (flagged only when
 * something needs you), the last week's calls and the latest decisions.
 * Every status is also spelled out in words, never colour alone.
 *
 * The waiting list only links to where each item is decided: like the
 * Approvals list, it has no approve or deny controls (I-56).
 */

/** One thing waiting for you, as Home lists it. */
export type WaitingItem = {
  href: string;
  at: Date;
  /** Shown only when it is close; null when it doesn't expire. */
  expiresAt: Date | null;
} & (
  | {
      kind: "call";
      headline: Headline;
      service: { action: string | null; tool: string; account: string };
    }
  | { kind: "connection"; agent: string; service: string; provider: string }
  | { kind: "rules"; agent: string; changes: number }
  | { kind: "recovery"; user: string }
);

/** What the waiting count is made of. */
export interface WaitingSummary {
  calls: number;
  requests: number;
  proposals: number;
  recoveries: number;
}

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
  /** What waits, counted and listed; the list shows the first few. */
  waiting: { counts: WaitingSummary; items: readonly WaitingItem[] };
  agents: { total: number; active: number; expiring: number };
  connections: { total: number; needsSignIn: number };
  rules: { loaded: boolean; count: number; stopped: number };
  setup: { passkey: boolean; notifications: boolean; account: boolean; agent: boolean };
  days: readonly DayCount[];
  recent: readonly RecentRow[];
}

const sentenceCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** What happened, in words, for the Recent list. */
const OUTCOME: Record<string, { word: string; tone: Tone | "muted" }> = {
  allow: { word: "Allowed", tone: "ok" },
  executed: { word: "Ran", tone: "ok" },
  approved: { word: "Approved", tone: "ok" },
  deny: { word: "Denied", tone: "error" },
  approval_denied: { word: "You denied", tone: "error" },
  ask: { word: "Asked you", tone: "warn" },
  paused: { word: "On hold", tone: "warn" },
  expired: { word: "Expired", tone: "muted" },
  would_allow: { word: "Would allow", tone: "muted" },
  would_deny: { word: "Would deny", tone: "warn" },
  would_ask: { word: "Would ask", tone: "warn" },
};

interface TileProps {
  href: string;
  title: string;
  big: number;
  /** Only when something needs you: the state, in a few words. */
  alert?: { line: string; tone: Tone };
}

/**
 * One stat tile: a label and a number, and a short state only when
 * something needs you. The whole tile links to its page.
 */
function tile(p: TileProps): Html {
  return html`<li>
    <a class="home-tile" href="${p.href}"${p.alert ? html` data-alert="${p.alert.tone}"` : ""}>
      <span class="home-tile-title">${p.title}</span>
      <strong class="home-tile-big">${String(p.big)}</strong>
      ${p.alert ? html`<span class="home-tile-line">${p.alert.line}</span>` : ""}
    </a>
  </li>`;
}

export function waitingTotal(c: WaitingSummary): number {
  return c.calls + c.requests + c.proposals + c.recoveries;
}

/** The areas. The Waiting tile steps aside when Home lists what waits above it. */
function tiles(p: HomeProps): Html {
  const g = p.agents;
  const c = p.connections;
  const r = p.rules;
  const waiting = waitingTotal(p.waiting.counts);
  const listed = p.waiting.items.length > 0;
  const all = [
    listed ? "" : tile({ href: "/approvals", title: "Waiting", big: waiting }),
    tile({
      href: "/agents",
      title: "Agents",
      big: g.total,
      ...(g.expiring > 0
        ? { alert: { line: `${String(g.expiring)} expiring`, tone: "warn" as const } }
        : {}),
    }),
    tile({
      href: "/connections",
      title: "Connections",
      big: c.total,
      ...(c.needsSignIn > 0
        ? { alert: { line: `${String(c.needsSignIn)} to sign in`, tone: "warn" as const } }
        : {}),
    }),
    tile({
      href: "/rules",
      title: "Rules",
      big: r.count,
      ...(r.loaded ? {} : { alert: { line: "Didn't load", tone: "error" as const } }),
    }),
  ];
  return html`<ul class="home-tiles" aria-label="Areas" data-count="${listed ? "3" : "4"}">${all}</ul>`;
}

/** lucide's check. */
const CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;

function setup(p: HomeProps): Html | "" {
  const s = p.setup;
  const steps = [
    {
      done: s.passkey,
      label: "Add a passkey",
      href: "/devices#device-heading",
    },
    {
      done: s.notifications,
      label: "Turn on notifications",
      href: "/devices#push-heading",
    },
    {
      done: s.account,
      label: "Connect an account",
      href: "/connections",
    },
    {
      done: s.agent,
      label: "Connect an agent",
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
      <div class="home-week-head"><h2 id="week-heading">This week</h2></div>
      <div class="home-empty">
        <span class="home-empty-icon">${trusted(CHART_ICON)}</span>
        <p class="home-empty-title">No calls yet</p>
        ${p.setup.agent ? "" : html`<a class="${btn("outline", "sm")}" href="/agents">Connect an agent</a>`}
      </div>
    </section>`;
  }
  return html`<section class="card home-week" aria-labelledby="week-heading">
    <div class="home-week-head">
      <h2 id="week-heading">This week</h2>
      <strong class="home-week-total">${String(total)}</strong>
    </div>
    <svg class="home-spark" viewBox="0 0 ${String(7 * w + 6 * gap)} ${String(h)}" role="img" aria-label="Calls per day: ${label}. ${String(sum("allowed"))} allowed, ${String(sum("denied"))} denied, ${String(sum("asked"))} asked you.">
      ${bars}
    </svg>
    <div class="home-spark-days muted" aria-hidden="true">
      ${days.map((d) => html`<span>${DAY_NAMES[d.day.getUTCDay()]}</span>`)}
    </div>
  </section>`;
}

function recent(p: HomeProps): Html {
  return html`<section class="card home-recent" aria-labelledby="recent-heading">
    <div class="home-week-head">
      <h2 id="recent-heading"><a class="home-more" href="/activity">Recent <span aria-hidden="true">→</span></a></h2>
    </div>
    ${
      p.recent.length === 0
        ? html`<p class="muted">No calls yet.</p>`
        : html`<ul class="home-recent-list">
            ${p.recent.slice(0, HOME_RECENT_LIMIT).map((row) => {
              const outcome = OUTCOME[row.kind] ?? {
                word: sentenceCase(row.kind.replaceAll("_", " ")),
                tone: "muted" as const,
              };
              return html`<li>
                <span class="home-recent-text"
                  ><strong title="${row.agent}">${middle(row.agent)}</strong> ${actionPhrase(row.action, row.tool)}</span
                >
                <span class="home-recent-meta">
                  ${badge(outcome.word, outcome.tone)}
                  <time class="muted" datetime="${row.at.toISOString()}" title="${formatRelative(row.at, p.now)}">${formatShort(p.now.getTime() - row.at.getTime())}</time>
                </span>
              </li>`;
            })}
          </ul>`
    }
  </section>`;
}

/** How many recent decisions Home shows; Activity has the rest. */
const HOME_RECENT_LIMIT = 3;

/** How many waiting items Home lists before "View all". */
export const HOME_WAITING_LIMIT = 5;

/** lucide's scroll-text and key-round, for rule changes and recovery links. */
const RULES_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 12h-5"/><path d="M15 8h-5"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/></svg>`;
const KEY_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/></svg>`;

function glyph(svg: string): Html {
  return html`<span class="req-icon"><span class="svc-logo svc-letter" aria-hidden="true">${trusted(svg)}</span></span>`;
}

function waitingIcon(item: WaitingItem): Html {
  switch (item.kind) {
    case "call":
      return serviceIcon(item.service);
    case "connection":
      return html`<span class="req-icon">${serviceLogo(item.provider, item.service)}</span>`;
    case "rules":
      return glyph(RULES_ICON);
    case "recovery":
      return glyph(KEY_ICON);
  }
}

const changes = (n: number) => (n === 1 ? "a rule change" : `${String(n)} rule changes`);

/** heel's sentence for the item, the words the page it links to leads with. */
function waitingText(item: WaitingItem): Html {
  switch (item.kind) {
    case "call":
      return html`${sentenceCase(item.headline.action)}`;
    case "connection":
      return html`Connect ${middle(item.service)}`;
    case "rules":
      return html`${sentenceCase(changes(item.changes))}`;
    case "recovery":
      return html`Recovery link`;
  }
}

/** Who asked (or who it's for), as the line under the item. */
function waitingWho(item: WaitingItem): string {
  switch (item.kind) {
    case "call":
      return item.headline.agent;
    case "connection":
    case "rules":
      return item.agent;
    case "recovery":
      return item.user;
  }
}

/** "inbox-bot · 12m", and the expiry only when it is close. */
function waitingWhen(item: WaitingItem, now: Date): Html {
  const ends = item.expiresAt;
  const soon = ends !== null && ends.getTime() - now.getTime() <= EXPIRY_SHOWN_WITHIN_MS;
  const who = waitingWho(item);
  return html`<span title="${who}">${middle(who)}</span> · <time datetime="${item.at.toISOString()}" title="${formatRelative(item.at, now)}">${formatShort(now.getTime() - item.at.getTime())}</time>${
    soon && ends !== null
      ? html` · <span class="home-wait-soon">${formatShort(ends.getTime() - now.getTime())} left</span>`
      : ""
  }`;
}

/**
 * What waits for you, listed: each row is one link to the page where it is
 * decided. Nothing here decides anything (I-56).
 */
function waitingList(p: HomeProps): Html | "" {
  const items = p.waiting.items;
  if (items.length === 0) return "";
  const total = waitingTotal(p.waiting.counts);
  const shown = items.slice(0, HOME_WAITING_LIMIT);
  return html`<section class="card home-wait" aria-labelledby="wait-heading">
    <div class="home-week-head">
      <h2 id="wait-heading">Needs you <span class="req-section-count">${String(total)}</span></h2>
      ${
        total > shown.length
          ? html`<a class="home-more" href="/approvals">View all <span aria-hidden="true">→</span></a>`
          : ""
      }
    </div>
    <ul class="home-wait-list">
      ${shown.map(
        (item) => html`<li>
          <a class="home-wait-row" href="${item.href}" data-kind="${item.kind}">
            ${waitingIcon(item)}
            <span class="home-wait-body">
              <span class="home-wait-text">${waitingText(item)}</span>
              <span class="home-wait-when muted">${waitingWhen(item, p.now)}</span>
            </span>
            <span class="req-go" aria-hidden="true">${trusted(CHEVRON_RIGHT)}</span>
          </a>
        </li>`,
      )}
    </ul>
  </section>`;
}

export function homePage(p: HomeProps): Html {
  return html`<div class="home">
    <h1>Home</h1>
    ${waitingList(p)} ${setup(p)} ${tiles(p)}
    <div class="home-split">${week(p)} ${p.waiting.items.length > 0 ? "" : recent(p)}</div>
  </div>`;
}
