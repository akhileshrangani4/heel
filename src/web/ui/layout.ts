import type { PauseScope } from "../../core/call.ts";
import { CEREMONY_SCRIPT } from "./ceremony.ts";
import { formatPauseScope, formatUtc } from "./format.ts";
import { type Child, type Html, html, trusted } from "./html.ts";
import { LOGO_SVG } from "./logo.ts";
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
  { id: "approvals", href: "/approvals", label: "Approvals", section: "approvals" },
  { id: "activity", href: "/activity", label: "Activity", section: "activity" },
  { id: "rules", href: "/rules", label: "Rules", section: "activity" },
  { id: "rule-history", href: "/rules/history", label: "Rule history", section: "activity" },
  { id: "agents", href: "/agents", label: "Agents", section: "agents" },
  { id: "standing", href: "/standing", label: "Standing approvals", section: "agents" },
  { id: "grants", href: "/grants", label: "Grants", section: "agents" },
  { id: "connections", href: "/connections", label: "Connections", section: "connections" },
  { id: "pause", href: "/pause", label: "Pause", section: "settings" },
  { id: "modes", href: "/modes", label: "Modes", section: "settings" },
] as const;

/** The top menu: one entry per section, opening its first page. */
export const SECTIONS = [
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
export function notice(tone: Tone, content: Child): Html {
  const role = tone === "error" ? "alert" : "status";
  return html`<div class="notice" data-tone="${tone}" role="${role}">${content}</div>`;
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
  return html`<time datetime="${at.toISOString()}">${formatUtc(at)}</time>`;
}

export function pauseBanner(pause: PauseNotice): Html {
  return html`<div class="banner" role="status">
    Paused: ${formatPauseScope(pause.scope, pause.target)}, since ${time(pause.since)}. Calls in
    scope return “paused” and reach no upstream.
  </div>`;
}

function header(viewer: Viewer, current: NavId | undefined): Html {
  const section = NAV.find((item) => item.id === current)?.section;
  const links = SECTIONS.map((entry) => {
    const first = NAV.find((item) => item.section === entry.id);
    const here = entry.id === section;
    return html`<li>
      <a href="${first?.href ?? "/"}"${here ? trusted(' aria-current="page"') : ""}>${entry.label}</a>
    </li>`;
  });
  return html`<header class="site">
    <a class="brand" href="/approvals">${trusted(LOGO_SVG)}heel</a>
    <nav aria-label="Main"><ul>${links}</ul></nav>
    <div class="account">
      <span class="who">${viewer.name} · ${viewer.role}</span>
      ${postForm(
        { action: "/sign-out", csrfToken: viewer.csrfToken },
        {},
        html`<button type="submit" class="sign-out">Sign out</button>`,
      )}
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
  <body>
    <a class="skip" href="#main">Skip to content</a>
    ${props.viewer ? header(props.viewer, props.current) : ""}
    ${pause ? pauseBanner(pause) : ""}
    <main id="main" tabindex="-1">
      ${props.viewer ? sectionTabs(props.current) : ""}
      <p id="heel-ceremony-status" role="status" aria-live="polite"></p>
      ${props.viewer ? props.body : authShell(props.body)}
    </main>
    <script>${trusted(CEREMONY_SCRIPT)}</script>
    ${props.script ? html`<script>${trusted(props.script)}</script>` : ""}
  </body>
</html>`;
}
