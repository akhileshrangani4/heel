import { type Html, html, trusted } from "./html.ts";
import { pushControl } from "./push-control.ts";
import { btn } from "./shadcn/button.ts";

/** lucide's circle-check. */
const CHECK_CIRCLE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>`;
/** lucide's square-plus, for Add to Home Screen. */
const ADD_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M8 12h8"/><path d="M12 8v8"/></svg>`;

/**
 * Where a new passkey lands (roadmap 2.7): signed in, with one tap to get
 * approval notifications on this device. On an iPhone a browser tab can't
 * get them, so it says to add heel to the Home Screen first.
 */
export function welcomePage(props: { vapidPublicKey: string; devices: number }): Html {
  return html`<div class="welcome">
    <div class="welcome-head">
      <span class="req-empty-icon">${trusted(CHECK_CIRCLE)}</span>
      <h1>Your passkey is ready</h1>
      <p class="muted">You're signed in. Every approve, deny and resume asks for this passkey.</p>
    </div>
    <section aria-labelledby="iphone-heading" class="settings-card">
      <div class="settings-row">
        <span class="welcome-step-icon">${trusted(ADD_ICON)}</span>
        <div class="settings-row-text">
          <h2 id="iphone-heading" class="settings-row-title">Add heel to your Home Screen</h2>
          <p class="muted">
            iPhone and iPad only. Safari only shows notifications for a page on your Home Screen. Tap
            the Share button, choose <strong>Add to Home Screen</strong>, open heel from there, and
            sign in. Then turn on notifications below.
          </p>
        </div>
      </div>
    </section>
    ${pushControl({ vapidPublicKey: props.vapidPublicKey })}
    <p class="muted welcome-count">
      ${props.devices === 0 ? "No device gets notifications yet." : props.devices === 1 ? "1 device gets notifications." : `${props.devices} devices get notifications.`}
    </p>
    <p class="welcome-go"><a class="${btn()}" href="/">Go to Home</a></p>
  </div>`;
}
