import { type CeremonyCallback, ceremonyButton } from "./ceremony.ts";
import { type Html, html } from "./html.ts";
import { notice } from "./layout.ts";

/** Why the sign-in screen is showing something other than the plain prompt. */
export type SignInNotice =
  | { kind: "none" }
  | { kind: "signed-out" }
  | { kind: "session-expired" }
  | { kind: "error"; message: string };

export interface OidcSignInProps {
  /** The IdP's display name from `heel.yaml`, e.g. "Acme SSO". */
  providerName: string;
  /** GET route that starts the authorization code flow with PKCE. */
  startHref: string;
  notice: SignInNotice;
}

export interface PasskeySignInProps {
  /** Starts the WebAuthn assertion for sign-in. */
  onSignIn: CeremonyCallback;
  /** The one-time challenge id the server issued for this page. */
  challengeId: string;
  /**
   * `false` before anyone has enrolled. Enrollment happens only over the
   * admin socket (`heel user enroll`), never from this page (Q-N2, I-58).
   */
  enrolled: boolean;
  notice: SignInNotice;
}

function signInNotice(n: SignInNotice): Html | "" {
  switch (n.kind) {
    case "none":
      return "";
    case "signed-out":
      return notice("ok", html`<p>You're signed out.</p>`);
    case "session-expired":
      return notice("info", html`<p>Your session ended. Sign in again to continue.</p>`);
    case "error":
      return notice("error", html`<p><strong>Sign-in didn't work.</strong> ${n.message}</p>`);
  }
}

const DECISIONS_NEED_PASSKEY = html`<p class="muted">
  Signing in lets you see requests. Every approve, deny or resume still asks for your passkey.
</p>`;

/** Team installs: sign in through the organization's OIDC provider. */
export function oidcSignIn(props: OidcSignInProps): Html {
  return html`<div class="signin">
    <h1>Sign in to heel</h1>
    ${signInNotice(props.notice)}
    <p>Use your organization account.</p>
    <div class="actions">
      <a class="btn btn-primary" href="${props.startHref}">Sign in with ${props.providerName}</a>
    </div>
    ${DECISIONS_NEED_PASSKEY}
  </div>`;
}

/** Single-user installs: passkey only. */
export function passkeySignIn(props: PasskeySignInProps): Html {
  if (!props.enrolled) {
    return html`<div class="signin">
      <h1>Sign in to heel</h1>
      ${signInNotice(props.notice)}
      ${notice(
        "info",
        html`<p><strong>No passkey is enrolled yet.</strong></p>
          <p>
            On the heel host, run <code>heel user enroll &lt;user&gt;</code> and open the one-time
            link it prints within 15 minutes. Enrollment can't start from this page.
          </p>`,
      )}
    </div>`;
  }
  return html`<div class="signin">
    <h1>Sign in to heel</h1>
    ${signInNotice(props.notice)}
    <p id="passkey-help">This install is single-user. Sign in with the passkey you enrolled.</p>
    <div class="actions">
      ${ceremonyButton({
        callback: props.onSignIn,
        intent: "sign-in",
        label: "Sign in with a passkey",
        tone: "primary",
        binding: { challengeId: props.challengeId },
        describedBy: "passkey-help",
      })}
    </div>
    <p class="muted">
      Lost your passkey? Run <code>heel user enroll &lt;user&gt;</code> on the heel host to add a
      new one.
    </p>
    ${DECISIONS_NEED_PASSKEY}
  </div>`;
}
