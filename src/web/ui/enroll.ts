import { ceremonyButton } from "./ceremony.ts";
import { type Html, html } from "./html.ts";
import { notice } from "./layout.ts";

export type EnrollProps =
  /** A live one-time link from `heel user enroll`. */
  | { kind: "open"; token: string; userName: string }
  /** The link is unknown, used, or past its 15 minutes. */
  | { kind: "invalid" };

/**
 * The page a one-time enrollment link opens (spec: Q-N2). It registers a
 * passkey for the person the link was made for. Enrollment never starts
 * from the human plane: only `heel user enroll` on the host makes a link.
 */
export function enrollPage(props: EnrollProps): Html {
  if (props.kind === "invalid") {
    return html`<div class="signin">
      <h1>Enroll a passkey</h1>
      ${notice(
        "error",
        html`<p><strong>This link can't be used.</strong> It was already used, or more than 15
            minutes have passed.</p>
          <p>On the heel host, run <code>heel user enroll &lt;user&gt;</code> for a new one.</p>`,
      )}
    </div>`;
  }
  return html`<div class="signin">
    <h1>Enroll a passkey</h1>
    <p id="enroll-help">
      This adds a passkey for <strong>${props.userName}</strong>. You'll use it to sign in and for
      every approve, deny and resume.
    </p>
    <div class="actions">
      ${ceremonyButton({
        callback: { handler: "enroll" },
        intent: "enroll",
        label: "Create a passkey",
        tone: "primary",
        binding: { token: props.token },
        describedBy: "enroll-help",
      })}
    </div>
  </div>`;
}
