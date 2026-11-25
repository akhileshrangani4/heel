import { ceremonyButton, KEY_ICON } from "./ceremony.ts";
import { errorPage } from "./error-page.ts";
import { type Html, html } from "./html.ts";
import { notice, time } from "./layout.ts";
import { btn } from "./shadcn/button.ts";

/** lucide's link-2-off. */
const LINK_OFF_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 17H7A5 5 0 0 1 7 7"/><path d="M15 7h2a5 5 0 0 1 4 8"/><line x1="8" x2="12" y1="12" y2="12"/><line x1="2" x2="22" y1="2" y2="22"/></svg>`;

export type EnrollProps =
  /** A live one-time link from `heel user enroll`. */
  | { kind: "open"; token: string; userName: string }
  /** The link is unknown, used, or past its 15 minutes. */
  | { kind: "invalid" }
  /** A recovery link that works only from `until`. */
  | { kind: "waiting"; userName: string; until: Date };

/**
 * The page a one-time enrollment link opens. It registers a
 * passkey for the person the link was made for. Enrollment never starts
 * from the human plane: only `heel user enroll` on the host makes a link.
 */
export function enrollPage(props: EnrollProps): Html {
  if (props.kind === "invalid") {
    // The same page for an unknown, used or expired link: it never says which.
    return errorPage({
      title: html`This link can't be used`,
      message: html`It was already used, or more than 15 minutes have passed. Run this on the heel
        host for a new one.`,
      icon: LINK_OFF_ICON,
      more: html`<div class="signin-command">
        <code id="enroll-command">heel user enroll &lt;user&gt;</code>
        <button type="button" class="${btn("ghost", "sm")}" data-heel-copy="enroll-command">Copy</button>
      </div>`,
    });
  }
  if (props.kind === "waiting") {
    return html`<div class="signin">
      <h1>Recover access</h1>
      ${notice(
        "info",
        html`<p>
          <strong>This recovery link works from ${time(props.until)}.</strong> Come back to this link
          then.
        </p>`,
      )}
    </div>`;
  }
  return html`<div class="signin">
    <h1>Enroll a passkey</h1>
    <p id="enroll-help">This adds a passkey for <strong>${props.userName}</strong>.</p>
    <div class="actions">
      ${ceremonyButton({
        callback: { handler: "enroll" },
        intent: "enroll",
        label: "Create a passkey",
        tone: "primary",
        binding: { token: props.token },
        describedBy: "enroll-help",
        icon: KEY_ICON,
      })}
    </div>
  </div>`;
}
