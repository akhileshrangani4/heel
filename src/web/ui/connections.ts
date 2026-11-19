import type { SignInSetup } from "../../definitions/sign-in-setup.ts";
import type { AccountStatus } from "../../store/schema.ts";
import { type Html, html } from "./html.ts";
import { badge, type FormTarget, notice, postForm, scrollRegion } from "./layout.ts";

export interface ConnectionRow {
  alias: string;
  provider: string;
  status: AccountStatus;
  /** The server wants OAuth sign-in, done from this page. */
  signsIn: boolean;
  /** It signs in through an OAuth client heel.yaml doesn't have yet. */
  setup: SignInSetup | null;
}

export type ConnectionsOutcome =
  | { kind: "none" }
  | { kind: "connected"; alias: string }
  | { kind: "failed"; alias: string; message: string };

export interface ConnectionsProps {
  rows: readonly ConnectionRow[];
  outcome: ConnectionsOutcome;
  signInForm: FormTarget;
}

function outcomeNotice(outcome: ConnectionsOutcome): Html | "" {
  switch (outcome.kind) {
    case "none":
      return "";
    case "connected":
      return notice(
        "ok",
        html`<p>Signed in to <strong>${outcome.alias}</strong>. Agents can use it now.</p>`,
      );
    case "failed":
      return notice(
        "error",
        html`<p><strong>Signing in to ${outcome.alias} didn't work.</strong> ${outcome.message}</p>`,
      );
  }
}

/** Signing in needs the operator's own OAuth client first: say which key, and where the steps are. */
function setupNeeded(setup: SignInSetup): Html {
  return html`<span class="muted"
    >Needs your ${setup.label} OAuth client: set <code>${setup.configKey}</code> in heel.yaml and
    restart heel. <a href="${setup.docsUrl}" target="_blank" rel="noopener">How to set it up</a></span
  >`;
}

/**
 * The accounts a person owns, and sign-in for the ones whose server wants it
 * (D5c). Signing in happens on the server's own page; heel keeps the tokens
 * in its vault and never shows them.
 */
export function connectionsPage(props: ConnectionsProps): Html {
  return html`<h1>Connections</h1>
    <p class="muted">The accounts your agents use through heel. Credentials stay in heel's vault.</p>
    ${outcomeNotice(props.outcome)}
    ${scrollRegion(
      "Connections",
      html`<table class="data">
      <caption>Your accounts</caption>
      <thead>
        <tr>
          <th scope="col">Account</th>
          <th scope="col">Provider</th>
          <th scope="col">State</th>
          <th scope="col">Action</th>
        </tr>
      </thead>
      <tbody>
        ${props.rows.map(
          (row) => html`<tr>
            <th scope="row" class="mono">${row.alias}</th>
            <td class="mono">${row.provider}</td>
            <td>${row.status === "active" ? badge("Ready", "ok") : badge("Needs sign-in", "warn")}</td>
            <td>
              ${
                row.setup !== null
                  ? setupNeeded(row.setup)
                  : row.signsIn
                    ? postForm(
                        props.signInForm,
                        { alias: row.alias },
                        html`<button type="submit" class="btn btn-secondary">
                          ${row.status === "active" ? "Sign in again" : "Sign in"}
                        </button>`,
                      )
                    : html`<span class="muted">Set up with <code>heel connect</code></span>`
              }
            </td>
          </tr>`,
        )}
      </tbody>
    </table>`,
    )}`;
}
