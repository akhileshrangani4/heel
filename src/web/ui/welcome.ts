import { type Html, html } from "./html.ts";
import { pushControl } from "./push-control.ts";

/**
 * Where a new passkey lands (roadmap 2.7): signed in, with one tap to get
 * approval notifications on this device. On an iPhone a browser tab can't
 * get them, so it says to add heel to the Home Screen first.
 */
export function welcomePage(props: { vapidPublicKey: string; devices: number }): Html {
  return html`<h1>Your passkey is ready</h1>
    <p>
      You're signed in. Every approve, deny and resume asks for this passkey, on this device or any
      other you add.
    </p>
    <section aria-labelledby="iphone-heading" class="card">
      <h2 id="iphone-heading">On an iPhone or iPad</h2>
      <p>
        Safari only shows notifications for a page on your Home Screen. Tap the Share button, choose
        <strong>Add to Home Screen</strong>, open heel from there, and sign in. Then turn on
        notifications below.
      </p>
    </section>
    ${pushControl({ vapidPublicKey: props.vapidPublicKey })}
    <p class="muted">
      ${props.devices === 0 ? "No device gets notifications yet." : props.devices === 1 ? "1 device gets notifications." : `${props.devices} devices get notifications.`}
    </p>
    <p><a class="btn btn-primary" href="/approvals">Go to Approvals</a></p>`;
}
