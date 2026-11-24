import type { PauseScope } from "../../core/call.ts";
import { CEREMONY_SCRIPT } from "./ceremony.ts";
import { formatPauseScope, formatUtc, LOCAL_TIME_SCRIPT } from "./format.ts";
import { type Child, type Html, html, trusted } from "./html.ts";
import { LOGO_SVG } from "./logo.ts";
import { SELECT_SCRIPT } from "./select.ts";
import { STYLESHEET } from "./theme.ts";

/** The signed-in person, shown in the header. Sign-in screens have none. */
export interface Viewer {
  name: string;
  role: "admin" | "member";
  /** The session's CSRF token, for the header's sign-out form. */
  csrfToken: string;
}

/** A pause that covers what the page shows (spec: Pause). */
export interface PauseNotice {
  scope: PauseScope;
  /** The agent, account or provider paused; null for a global pause. */
  target: string | null;
  since: Date;
}

export type Tone = "ok" | "error" | "warn" | "info";

/** `light`/`dark` force a theme; `auto` follows the operating system. */
export type Theme = "auto" | "light" | "dark";

/**
 * Every page, and the section of the top menu it sits under. The menu shows
 * five sections; a section with more than one page shows them as tabs under
 * the header, so the top row stays short on a phone and on a desktop.
 */
export const NAV = [
  { id: "home", href: "/", label: "Home", section: "home" },
  { id: "approvals", href: "/approvals", label: "Approvals", section: "approvals" },
  { id: "activity", href: "/activity", label: "Activity", section: "activity" },
  { id: "rules", href: "/rules", label: "Rules", section: "activity" },
  { id: "rule-history", href: "/rules/history", label: "Rule history", section: "activity" },
  { id: "agents", href: "/agents", label: "Agents", section: "agents" },
  { id: "standing", href: "/standing", label: "Standing approvals", section: "agents" },
  { id: "grants", href: "/grants", label: "Grants", section: "agents" },
  { id: "connections", href: "/connections", label: "Connections", section: "connections" },
  { id: "pause", href: "/pause", label: "Pause", section: "settings" },
  { id: "devices", href: "/devices", label: "Devices", section: "settings" },
  { id: "people", href: "/people", label: "People", section: "settings" },
  { id: "modes", href: "/modes", label: "Modes", section: "settings" },
] as const;

/** The top menu: one entry per section, opening its first page. */
export const SECTIONS = [
  { id: "home", label: "Home" },
  { id: "approvals", label: "Approvals" },
  { id: "activity", label: "Activity" },
  { id: "agents", label: "Agents" },
  { id: "connections", label: "Connections" },
  { id: "settings", label: "Settings" },
] as const;

export type NavId = (typeof NAV)[number]["id"];

export interface PageProps {
  title: string;
  /** Null on sign-in screens: no navigation, and no pause banner (it isn't theirs to see). */
  viewer: Viewer | null;
  current?: NavId;
  pause?: PauseNotice | null;
  theme?: Theme;
  body: Html;
  /** Extra trusted script, e.g. the code that registers ceremony handlers. */
  script?: string;
  /** Requests waiting for this person, shown as a count beside Approvals. */
  waiting?: number;
  /**
   * A focus page (the agent consent screen): signed in, but no site header
   * or section tabs, the content centred and narrow, nothing else to click.
   */
  focus?: boolean;
}

/**
 * Where a plain form posts. Used only for actions that can stop or tighten
 * (pause, revoke, save a draft), never for a decision, which needs a passkey.
 */
export interface FormTarget {
  action: string;
  /** Echoed as a hidden field; the route that receives the post checks it. */
  csrfToken: string;
}

/** A one-button POST form carrying the CSRF token and any hidden fields. */
export function postForm(
  target: FormTarget,
  fields: Readonly<Record<string, string>>,
  button: Html,
): Html {
  const hidden = Object.entries(fields).map(
    ([name, value]) => html`<input type="hidden" name="${name}" value="${value}" />`,
  );
  return html`<form method="post" action="${target.action}">
    <input type="hidden" name="csrf" value="${target.csrfToken}" />
    ${hidden} ${button}
  </form>`;
}

/** A labelled status pill. The word carries the meaning; colour only repeats it. */
export function badge(label: string, tone: Tone | "muted"): Html {
  return html`<span class="badge" data-tone="${tone}">${label}</span>`;
}

/** A boxed message. `error` is announced to screen readers as an alert. */
/** lucide icons for each notice tone: circle-check, circle-x, triangle-alert, info. */
const NOTICE_ICONS: Record<Tone, string> = {
  ok: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  error: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  warn: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
};

/** A slim alert with an icon for its tone. `error` is announced to screen readers as an alert. */
export function notice(tone: Tone, content: Child): Html {
  const role = tone === "error" ? "alert" : "status";
  return html`<div class="notice" data-tone="${tone}" role="${role}"><span class="notice-icon">${trusted(
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${NOTICE_ICONS[tone]}</svg>`,
  )}</span><div class="notice-body">${content}</div></div>`;
}

/**
 * Wraps a wide table so it scrolls on its own instead of pushing the page
 * sideways on a phone. Focusable and named so keyboard users can scroll it.
 */
export function scrollRegion(label: string, content: Html): Html {
  return html`<div class="table-scroll" role="region" aria-label="${label}" tabindex="0">${content}</div>`;
}

/** `<time>` with a machine-readable instant and a UTC label. */
export function time(at: Date): Html {
  return html`<time datetime="${at.toISOString()}" data-heel-local>${formatUtc(at)}</time>`;
}

/** lucide's circle-pause. */
const PAUSE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="10" x2="10" y1="15" y2="9"/><line x1="14" x2="14" y1="15" y2="9"/></svg>`;

/** A slim alert at the top of every page while a pause covers it, with the way to resume. */
export function pauseBanner(pause: PauseNotice): Html {
  return html`<div class="pause-alert" role="status">
    <span class="pause-alert-icon">${trusted(PAUSE_ICON)}</span>
    <span class="pause-alert-text"
      ><strong>Paused: ${formatPauseScope(pause.scope, pause.target)}</strong>, since
      ${time(pause.since)}. Calls in scope return “paused” and reach no upstream.</span
    >
    <a class="pause-alert-action" href="/pause">Resume</a>
  </div>`;
}

/** lucide icons for the menu, one per section, plus More. */
const NAV_ICONS: Record<string, string> = {
  home: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  approvals:
    '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  activity:
    '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  agents:
    '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  connections:
    '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
  settings:
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  signOut:
    '<path d="m16 17 5-5-5-5"/><path d="M21 12H9"/><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>',
};

function navIcon(name: string): Html {
  return trusted(
    `<span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${NAV_ICONS[name] ?? ""}</svg></span>`,
  );
}

/** Sections that sit under More in the phone's bottom bar. */
const UNDER_MORE: readonly string[] = ["connections", "settings"];

/**
 * The menu. On a wide screen it's the left sidebar; on a phone it's a bar
 * fixed to the bottom of the screen (Home, Approvals, Activity, Agents,
 * More), with Connections, Settings and Sign out under More.
 */
function header(viewer: Viewer, current: NavId | undefined, waiting: number): Html {
  const section = NAV.find((item) => item.id === current)?.section;
  const signOut = (className: string, label: Html) =>
    postForm(
      { action: "/sign-out", csrfToken: viewer.csrfToken },
      {},
      html`<button type="submit" class="${className}">${label}</button>`,
    );
  const links = SECTIONS.map((entry) => {
    const first = NAV.find((item) => item.section === entry.id);
    const here = entry.id === section;
    const count =
      entry.id === "approvals" && waiting > 0
        ? html` <span class="nav-count"><span class="visually-hidden">, </span>${String(waiting)}<span class="visually-hidden"> waiting</span></span>`
        : "";
    return html`<li${UNDER_MORE.includes(entry.id) ? trusted(' class="nav-wide"') : ""}>
      <a href="${first?.href ?? "/"}"${here ? trusted(' aria-current="page"') : ""}>${navIcon(entry.id)}<span class="nav-label">${entry.label}</span>${count}</a>
    </li>`;
  });
  const inMore = section !== undefined && UNDER_MORE.includes(section);
  const more = html`<li class="nav-more">
    <details>
      <summary${inMore ? trusted(' aria-current="page"') : ""}>${navIcon("more")}<span class="nav-label">More</span></summary>
      <div class="nav-more-panel">
        <p class="nav-more-who">${viewer.name} · ${viewer.role}</p>
        ${SECTIONS.filter((entry) => UNDER_MORE.includes(entry.id)).map((entry) => {
          const first = NAV.find((item) => item.section === entry.id);
          return html`<a href="${first?.href ?? "/"}"${entry.id === section ? trusted(' aria-current="page"') : ""}>${navIcon(entry.id)}${entry.label}</a>`;
        })}
        ${signOut("nav-more-signout", html`${navIcon("signOut")}Sign out`)}
      </div>
    </details>
  </li>`;
  return html`<header class="site">
    <a class="brand" href="/">${trusted(LOGO_SVG)}heel</a>
    <nav aria-label="Main"><ul>${links}${more}</ul></nav>
    <div class="account">
      <span class="who">${viewer.name} · ${viewer.role}</span>
      ${signOut("sign-out", html`Sign out`)}
    </div>
  </header>`;
}

/** The pages of the current section, as tabs, when it has more than one. */
function sectionTabs(current: NavId | undefined): Html | "" {
  const section = NAV.find((item) => item.id === current)?.section;
  const pages = NAV.filter((item) => item.section === section);
  if (pages.length < 2) return "";
  return html`<nav class="subnav" aria-label="Section"><ul>
    ${pages.map(
      (item) => html`<li>
        <a href="${item.href}"${item.id === current ? trusted(' aria-current="page"') : ""}>${item.label}</a>
      </li>`,
    )}
  </ul></nav>`;
}

/** heel's logo dog written in the word heel: the same drawing as behind useheel.dev's wordmark. */
const DOG = `                          :+heelheelh*-
                       .+eelheelheelheel+
                      +heelheelheelheelhee=.
                     lheelheelheelheelheelheelheelh-
                    eelheelheelheelheelheelheelheelh
                   =eelheelhe*elheelheelheelheelheel
                   heelheelhe**elheelheelheelheelhe=
                   elheelheelh:eelheelheelheelheel=
                  .heelheelhee:*lheelheelheelhe+-
                   elheelheelh.=eelheelhe+:
                   -elheelheel heelheelh
                    :*eelhee= +lheelhee.
                     *==--::=lheelheelh
                    +eelheelheelheelhee
                  :lheel**heelheelheelh.
                .*eelheelheelhe*******e:
              -lheelheelheelheelheelheel
           .+heelheelheelheelheelheelhee
         -lheelheelheelheelheelheelheelh:
       =eelheelheelheelheelheelheelheelh-
     -eelheelheelheelheelheelheelheelhee=
    lheelheelheelheelheelheelheelheelhee-
  :lheelheelheelheelheelheelheelheelheel:
 .heelheelheelheelheelheelheelheelheelhe
 elheelheelheelheelheelheelheelheelheelh
+eelheelheelheelheelheelheelheelheelhee*
lheelheelheelheelheelheelheelheelheelhe-
elheelheelheelheelheelheelheelheelheelh.
eelheelheelheelheelheelheelheelheelheel
heelheelheelheelheelheelheelheelheelhee*
:lheelheelheelheelheelheelheelheelheelhee*.
 =lheelheelheelheelheelheelheelheelheelheel-
  .*heelheelheelheelheelheelheelheelheelhee*
     -*lheelheelheelheelheelheelheelheelhe*`;

/**
 * Sign-in, enrollment and consent: heel's brand as on useheel.dev, the dog,
 * the wordmark and its line, around the page's own card.
 */
function authShell(body: Html): Html {
  return html`<div class="auth">
    <span class="sticker sticker-allow" aria-hidden="true">allow</span>
    <span class="sticker sticker-deny" aria-hidden="true">deny</span>
    <span class="sticker sticker-ask" aria-hidden="true">ask</span>
    <pre class="auth-dog" aria-hidden="true">${DOG}</pre>
    <p class="auth-word">heel</p>
    <p class="auth-tag">access control for your ai agents</p>
    ${body}
    <p class="auth-foot">open source · self-hosted</p>
  </div>`;
}

/** The document every human-plane page renders into. */
export function page(props: PageProps): Html {
  const theme = props.theme ?? "auto";
  // Sign-in screens never reveal pause state to someone who isn't signed in.
  const pause = props.viewer !== null ? (props.pause ?? null) : null;
  return html`<!doctype html>
<html lang="en"${theme === "auto" ? "" : html` data-theme="${theme}"`}>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <meta name="theme-color" content="#16181D" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="icon" href="/icon-180.png" />
    <link rel="apple-touch-icon" href="/icon-180.png" />
    <title>${props.title} · heel</title>
    <style>${trusted(STYLESHEET)}</style>
  </head>
  <body${props.viewer ? html` class="${props.focus ? "focus" : "app"}"` : ""}>
    <a class="skip" href="#main">Skip to content</a>
    ${props.viewer && !props.focus ? header(props.viewer, props.current, props.waiting ?? 0) : ""}
    <main id="main" tabindex="-1">
      ${pause ? pauseBanner(pause) : ""}
      ${props.viewer && !props.focus ? sectionTabs(props.current) : ""}
      <p id="heel-ceremony-status" role="status" aria-live="polite"></p>
      ${props.viewer ? props.body : authShell(props.body)}
    </main>
    <script>${trusted(CEREMONY_SCRIPT)}</script>
    <script>${trusted(SELECT_SCRIPT)}</script>
    <script>${trusted(LOCAL_TIME_SCRIPT)}</script>
    ${props.script ? html`<script>${trusted(props.script)}</script>` : ""}
  </body>
</html>`;
}
