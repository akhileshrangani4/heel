import { type Html, html } from "./html.ts";
import { type FormTarget, notice, postForm } from "./layout.ts";
import { btn } from "./shadcn/button.ts";
import { switchFace } from "./switch.ts";

/**
 * Turns approval notifications on or off for the device the page is open on:
 * one switch, which the page script (client.ts) turns
 * on when this browser is already subscribed. A plain button, not a passkey ceremony: getting notified can't
 * decide anything. The script explains when the browser can't receive push,
 * such as an iPhone browser tab, where heel has to be added to the Home
 * Screen first. Turning off every device is a quieter link under the count.
 */
export function pushControl(props: {
  vapidPublicKey: string;
  /** How many of this person's devices get notifications now, and the form that turns them all off. */
  devices?: { count: number; turnOff: FormTarget; turnedOff: number | null };
}): Html {
  const devices = props.devices;
  return html`<section aria-labelledby="push-heading" class="settings-card push">
    <div class="settings-row">
      <div class="settings-row-text">
        <h2 id="push-heading" class="settings-row-title">Notifications on this device</h2>
      </div>
      <button type="button" class="ui-switch" role="switch" aria-checked="false" aria-label="Turn on notifications" id="heel-push" data-key="${props.vapidPublicKey}">${switchFace(false, "Off")}</button>
    </div>
    <p id="heel-push-status" class="muted settings-row-status" role="status" aria-live="polite"></p>
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
          <div class="settings-row-foot">
            <span class="muted">${
              devices.count === 0
                ? "No device gets notifications yet."
                : `${devices.count === 1 ? "1 device gets" : `${devices.count} devices get`} notifications.`
            }</span>
            ${
              devices.count === 0
                ? ""
                : postForm(
                    devices.turnOff,
                    {},
                    html`<button type="submit" class="${btn("link", "sm", "px-0 text-muted-foreground")}">Turn off on all devices</button>`,
                  )
            }
          </div>`
    }
  </section>`;
}
