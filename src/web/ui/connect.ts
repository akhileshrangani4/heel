import { ceremonyButton, KEY_ICON } from "./ceremony.ts";
import { type Html, html, trusted } from "./html.ts";
import { notice } from "./layout.ts";
import { LOGO_SVG } from "./logo.ts";
import { btn } from "./shadcn/button.ts";

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
      /** The agent this connection will act as: the name it will really have. */
      agentName: string;
      /** A new agent, rather than this app's existing one. */
      newAgent?: boolean;
      request: ConnectRequest;
      /** Sends the person back to the client with `access_denied`. */
      declineHref: string;
    }
  | { kind: "invalid"; message: string };

/**
 * The page an AI app's "connect" button opens. Connecting lets that app
 * call tools as one of the person's agents, so it takes a passkey, like
 * every other decision that lets calls through. Every call it then makes
 * goes through the person's rules.
 */
const svg = (paths: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
/** lucide's shield-check and circle-x. */
const SHIELD_CHECK = svg(
  '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
);
const CIRCLE_X = svg('<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>');

/** The app's self-chosen name as a letter tile: a claim, so never a logo it could fake. */
function appTile(name: string): Html {
  const letter = (name.trim()[0] ?? "?").toUpperCase();
  return html`<span class="consent-app" aria-hidden="true">${letter}</span>`;
}

export function connectPage(props: ConnectProps): Html {
  if (props.kind === "invalid") {
    return html`<div class="consent">
      <div class="signin-empty consent-invalid">
        <span class="signin-empty-icon">${trusted(CIRCLE_X)}</span>
        <h1>This connection request can't be used</h1>
        <p class="muted">${props.message}</p>
      </div>
    </div>`;
  }
  return html`<div class="consent">
    <div class="consent-pair">
      ${appTile(props.clientName)}
      <span class="consent-link" aria-hidden="true"><span class="consent-shield">${trusted(SHIELD_CHECK)}</span></span>
      <span class="consent-heel" aria-hidden="true">${trusted(LOGO_SVG)}</span>
    </div>
    <h1 class="consent-title">Connect ${props.clientName}?</h1>
    <p class="consent-sub" id="connect-help">
      An app calling itself <strong>${props.clientName}</strong>, returning to
      <strong class="mono">${props.redirectHost}</strong>, wants to use your accounts through heel
      as ${props.newAgent === false ? "its agent" : "a new agent"} <code>${props.agentName}</code>.
    </p>
    ${notice(
      "warn",
      html`<p>Only continue if you just started this sign-in yourself; an app on your own computer returns to localhost or 127.0.0.1.</p>`,
    )}
    <div class="consent-actions">
      <a class="${btn("outline")}" href="${props.declineHref}">Don't connect</a>
      ${ceremonyButton({
        callback: { handler: "connect" },
        intent: "connect",
        label: "Connect with a passkey",
        tone: "primary",
        binding: { ...props.request },
        describedBy: "connect-help",
        icon: KEY_ICON,
      })}
    </div>
  </div>`;
}
