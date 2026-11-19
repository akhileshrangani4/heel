import { type Html, html } from "./html.ts";
import { type FormTarget, notice, postForm } from "./layout.ts";

/**
 * Turns on approval notifications for the device the page is open on (spec:
 * Notifications). A plain button, not a passkey ceremony: getting notified
 * can't decide anything. The page script (client.ts) does the work, and
 * explains when the browser can't receive push, such as an iPhone browser
 * tab, where heel has to be added to the Home Screen first.
 */
export function pushControl(props: {
  vapidPublicKey: string;
  /** How many of this person's devices get notifications now, and the form that turns them all off. */
  devices?: { count: number; turnOff: FormTarget; turnedOff: number | null };
}): Html {
  const devices = props.devices;
  return html`<section aria-labelledby="push-heading" class="push">
    <h2 id="push-heading">Notifications on this device</h2>
    <p class="muted">
      Get a notification here when an agent's call needs you. It names the agent, the action and
      the account, never the call's contents, and opening it brings you back to this page.
    </p>
    <div class="actions">
      <button type="button" class="btn btn-secondary" id="heel-push" data-key="${props.vapidPublicKey}">
        Turn on notifications
      </button>
    </div>
    <p id="heel-push-status" class="muted" role="status" aria-live="polite"></p>
    ${
      devices === undefined
        ? ""
        : html`${
            devices.turnedOff === null
              ? ""
              : notice(
                  "ok",
                  html`<p>Notifications are off on ${devices.turnedOff === 1 ? "1 device" : `${devices.turnedOff} devices`}.</p>`,
                )
          }
          <p class="muted">
            ${
              devices.count === 0
                ? "No device gets notifications yet."
                : `${devices.count === 1 ? "1 device gets" : `${devices.count} devices get`} notifications for you. If you don't recognize that many, turn them all off and turn this one back on.`
            }
          </p>
          ${
            devices.count === 0
              ? ""
              : postForm(
                  devices.turnOff,
                  {},
                  html`<button type="submit" class="btn btn-secondary">Turn off on all devices</button>`,
                )
          }`
    }
  </section>`;
}
