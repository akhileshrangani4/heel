import { ceremonyButton } from "./ceremony.ts";
import { formatRelative } from "./format.ts";
import { type Html, html } from "./html.ts";
import { type FormTarget, notice, postForm, time } from "./layout.ts";

/** A recovery link someone made from the command line, waiting out its delay. */
export interface RecoveryNotice {
  id: string;
  userName: string;
  createdAt: Date;
  activeFrom: Date;
}

/**
 * Recovery links waiting to work, each with a way to cancel it. Shown on the
 * approval page so a link an agent made with `heel user enroll` is seen
 * before it can add a passkey. Cancelling only removes a link: a plain form.
 */
export function recoveryNotices(
  recoveries: readonly RecoveryNotice[],
  now: Date,
  cancel: FormTarget,
): Html {
  return html`${recoveries.map((r) =>
    notice(
      "warn",
      html`<p>
          <strong>A recovery link for ${r.userName} was made ${formatRelative(r.createdAt, now)}.</strong>
          It can add a passkey from ${time(r.activeFrom)}. If nobody you trust ran
          <code>heel user enroll</code>, cancel it: an agent with access to the heel host could
          have.
        </p>
        ${postForm(
          cancel,
          { id: r.id },
          html`<button type="submit" class="btn btn-secondary">Cancel this link</button>`,
        )}`,
    ),
  )}`;
}

/**
 * Adds a passkey on another device right away: the person confirms with a
 * passkey they already have, and gets a one-time link to open there.
 */
export function addDeviceControl(): Html {
  return html`<section aria-labelledby="device-heading" class="push">
    <h2 id="device-heading">Add another device</h2>
    <p class="muted" id="device-help">
      Confirm with this passkey to get a one-time link. Open it within 15 minutes on the device you
      want to add, such as your phone.
    </p>
    <div class="actions">
      ${ceremonyButton({
        callback: { handler: "addDevice" },
        intent: "add-device",
        label: "Add another device",
        tone: "secondary",
        binding: {},
        describedBy: "device-help",
      })}
    </div>
  </section>`;
}
