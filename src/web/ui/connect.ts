import { ceremonyButton } from "./ceremony.ts";
import { type Html, html } from "./html.ts";
import { notice } from "./layout.ts";

/** The OAuth authorization request, as the consent page carries it into the passkey challenge. */
export interface ConnectRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  resource: string;
}

export type ConnectProps =
  | {
      kind: "ask";
      /** What the client calls itself. Shown as its claim, never as a verified name. */
      clientName: string;
      /** Where heel sends the person back; the host is the part to check. */
      redirectHost: string;
      /** The agent this connection will act as. */
      agentName: string;
      request: ConnectRequest;
      /** Sends the person back to the client with `access_denied`. */
      declineHref: string;
    }
  | { kind: "invalid"; message: string };

/**
 * The page an AI app's "connect" button opens (A2). Connecting lets that app
 * call tools as one of the person's agents, so it takes a passkey, like
 * every other decision that lets calls through. Every call it then makes
 * goes through the person's rules.
 */
export function connectPage(props: ConnectProps): Html {
  if (props.kind === "invalid") {
    return html`<div class="signin">
      <h1>Connect an app</h1>
      ${notice("error", html`<p><strong>This connection request can't be used.</strong> ${props.message}</p>`)}
    </div>`;
  }
  return html`<div class="signin">
    <h1>Connect ${props.clientName}?</h1>
    <p id="connect-help">
      An app that calls itself <strong>${props.clientName}</strong>, returning to
      <span class="mono">${props.redirectHost}</span>, wants to use your accounts through heel as the
      agent <strong class="mono">${props.agentName}</strong>.
    </p>
    <ul>
      <li>Every call it makes goes through your rules: some run, some wait for you, some are denied.</li>
      <li>It never sees your account credentials.</li>
      <li>You can pause it on the Pause page, or cut it off with <code>heel agent revoke ${props.agentName}</code>.</li>
    </ul>
    <div class="actions">
      ${ceremonyButton({
        callback: { handler: "connect" },
        intent: "connect",
        label: `Connect with a passkey`,
        tone: "primary",
        binding: { ...props.request },
        describedBy: "connect-help",
      })}
      <a class="btn btn-secondary" href="${props.declineHref}">Don't connect</a>
    </div>
  </div>`;
}
