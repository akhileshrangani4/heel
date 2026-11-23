import { type CeremonyCallback, ceremonyButton, KEY_ICON } from "./ceremony.ts";
import { type Html, html, trusted } from "./html.ts";
import { notice } from "./layout.ts";
import { btn } from "./shadcn/button.ts";

/** Why the sign-in screen is showing something other than the plain prompt. */
export type SignInNotice =
  | { kind: "none" }
  | { kind: "signed-out" }
  /** A passkey was just enrolled from a one-time link. */
  | { kind: "enrolled" }
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
    case "enrolled":
      return notice("ok", html`<p>Your passkey is enrolled. Sign in with it.</p>`);
    case "session-expired":
      return notice("info", html`<p>Your session ended. Sign in again to continue.</p>`);
    case "error":
      // Shown in the status line above the button instead (signInStatus).
      return "";
  }
}

/** lucide's circle-alert. */
const ALERT_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>`;

/**
 * The quiet line right above the button: a sign-in error from the server,
 * then the passkey check's progress and outcome as the page script writes them.
 */
function signInStatus(n: SignInNotice): Html {
  const role = n.kind === "error" ? "alert" : "status";
  return html`<p id="signin-status" class="signin-status" role="${role}" aria-live="polite">${
    n.kind === "error"
      ? html`<span class="signin-status-icon">${trusted(ALERT_ICON)}</span><span><strong>Sign-in didn't work.</strong> ${n.message}</span>`
      : ""
  }</p>`;
}

/** lucide's log-in, for the team sign-in button. */
const LOG_IN_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/></svg>`;

/** Team installs: sign in through the organization's OIDC provider. */
export function oidcSignIn(props: OidcSignInProps): Html {
  return html`<div class="signin">
    <h1>Sign in</h1>
    ${signInNotice(props.notice)}
    <p>Use your organization account.</p>
    ${signInStatus(props.notice)}
    <div class="actions">
      <a class="${btn()}" href="${props.startHref}">${trusted(LOG_IN_ICON)}Sign in with ${props.providerName}</a>
    </div>
  </div>`;
}

/** Single-user installs: passkey only. */
export function passkeySignIn(props: PasskeySignInProps): Html {
  if (!props.enrolled) {
    return html`<div class="signin">
      ${signInNotice(props.notice)}
      <div class="signin-empty">
        <span class="signin-empty-icon">${trusted(KEY_ICON)}</span>
        <h1>No passkey yet</h1>
        <p class="muted">
          Enrollment starts on the heel host, never from this page. Run this there and open the
          one-time link it prints within 15 minutes.
        </p>
      </div>
      <div class="signin-command">
        <code id="enroll-command">heel user enroll &lt;user&gt;</code>
        <button type="button" class="${btn("ghost", "sm")}" data-heel-copy="enroll-command">Copy</button>
      </div>
    </div>`;
  }
  return html`<div class="signin">
    <h1>Sign in</h1>
    ${signInNotice(props.notice)}
    <p id="passkey-help">This install is single-user. Sign in with the passkey you enrolled.</p>
    ${signInStatus(props.notice)}
    <div class="actions">
      ${ceremonyButton({
        callback: props.onSignIn,
        intent: "sign-in",
        label: "Sign in with a passkey",
        tone: "primary",
        binding: { challengeId: props.challengeId },
        describedBy: "passkey-help",
        statusId: "signin-status",
        icon: KEY_ICON,
      })}
    </div>
    <details class="signin-help">
      <summary>Lost your passkey?</summary>
      <p class="muted">
        Run <code>heel user enroll &lt;user&gt;</code> on the heel host to add a new one.
      </p>
    </details>
  </div>`;
}
