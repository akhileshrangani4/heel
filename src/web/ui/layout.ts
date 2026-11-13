import type { PauseScope } from "../../core/call.ts";
import { CEREMONY_SCRIPT } from "./ceremony.ts";
import { formatPauseScope, formatUtc } from "./format.ts";
import { type Child, type Html, html, trusted } from "./html.ts";
import { STYLESHEET } from "./theme.ts";

/** The signed-in person, shown in the header. Sign-in screens have none. */
export interface Viewer {
  name: string;
  role: "admin" | "member";
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

export const NAV = [
  { id: "approvals", href: "/approvals", label: "Approvals" },
  { id: "standing", href: "/standing", label: "Standing approvals" },
  { id: "rules", href: "/rules", label: "Rules" },
  { id: "pause", href: "/pause", label: "Pause" },
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
  const links = NAV.map(
    (item) =>
      html`<li>
        <a href="${item.href}"${item.id === current ? trusted(' aria-current="page"') : ""}
          >${item.label}</a
        >
      </li>`,
  );
  return html`<header class="site">
    <a class="brand" href="/approvals">heel</a>
    <nav aria-label="Main"><ul>${links}</ul></nav>
    <span class="who">${viewer.name} · ${viewer.role}</span>
  </header>`;
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
    <title>${props.title} · heel</title>
    <style>${trusted(STYLESHEET)}</style>
  </head>
  <body>
    <a class="skip" href="#main">Skip to content</a>
    ${props.viewer ? header(props.viewer, props.current) : ""}
    ${pause ? pauseBanner(pause) : ""}
    <main id="main" tabindex="-1">
      <p id="heel-ceremony-status" role="status" aria-live="polite"></p>
      ${props.body}
    </main>
    <script>${trusted(CEREMONY_SCRIPT)}</script>
    ${props.script ? html`<script>${trusted(props.script)}</script>` : ""}
  </body>
</html>`;
}
