import { type Child, type Html, html, trusted } from "./html.ts";
import { btn } from "./shadcn/button.ts";

/** lucide's circle-alert. */
const ALERT_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>`;

/**
 * A page for a request heel couldn't serve (not found, a stale form, an
 * error). Installed to a Home Screen heel has no browser back button, so the
 * page always has a way back. It names no internals: the message is fixed
 * text chosen by the caller.
 */
export function errorPage(props: {
  title: Child;
  message: Child;
  /** Shown under the message, e.g. the command that makes a new link. */
  more?: Html;
  /** An icon in place of the alert circle (trusted SVG). */
  icon?: string;
}): Html {
  return html`<div class="signin">
    <div class="signin-empty">
      <span class="signin-empty-icon">${trusted(props.icon ?? ALERT_ICON)}</span>
      <h1>${props.title}</h1>
      <p class="muted">${props.message}</p>
    </div>
    ${props.more ?? ""}
    <div class="actions">
      <a class="${btn()}" href="/">Go to Home</a>
    </div>
  </div>`;
}
