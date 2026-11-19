import type { SignInSetup } from "../../definitions/sign-in-setup.ts";
import type { AccountStatus } from "../../store/schema.ts";
import { type Html, html } from "./html.ts";
import { badge, type FormTarget, notice, postForm } from "./layout.ts";

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
        html`<p><strong>Signing in${outcome.alias === "" ? "" : html` to ${outcome.alias}`} didn't work.</strong> ${outcome.message}</p>`,
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

/** A provider as people say it: "Gmail", "GitHub", "MCP server". */
export function providerLabel(provider: string): string {
  const known: Record<string, string> = {
    gmail: "Gmail",
    "google-calendar": "Google Calendar",
    outlook: "Outlook",
    github: "GitHub",
    slack: "Slack",
    linear: "Linear",
    notion: "Notion",
    stripe: "Stripe",
    mcp: "MCP server",
    http: "HTTP API",
    "cli:gh": "gh CLI",
  };
  const prefix = provider.split(":")[0] ?? provider;
  return known[provider] ?? (prefix === "cli" ? "CLI" : (known[prefix] ?? provider));
}

/** The one next step a card shows, or nothing when the account is ready and needs none. */
function nextStep(row: ConnectionRow, signInForm: FormTarget): Html | "" {
  const ready = row.status === "active";
  // A client to configure matters only to an account that still has to sign in.
  if (row.setup !== null && !ready) return setupNeeded(row.setup);
  if (row.signsIn && row.setup === null) {
    return postForm(
      signInForm,
      { alias: row.alias },
      html`<button type="submit" class="btn ${ready ? "btn-secondary" : "btn-primary"}">
        ${ready ? "Sign in again" : "Sign in"}
      </button>`,
    );
  }
  if (!ready) {
    return html`<span class="muted"
      >Give heel a new key: <code>heel account set ${row.alias} --credential-stdin</code></span
    >`;
  }
  return "";
}

/**
 * The accounts a person owns, and sign-in for the ones whose server wants it
 * (D5c). Signing in happens on the server's own page; heel keeps the tokens
 * in its vault and never shows them.
 */
export function connectionsPage(props: ConnectionsProps): Html {
  const waiting = props.rows.filter((row) => row.status !== "active").length;
  return html`<h1>Connections</h1>
    <p class="muted">
      The accounts your agents use through heel. Credentials stay in heel's vault; agents never see
      them.
    </p>
    ${outcomeNotice(props.outcome)}
    ${
      props.rows.length === 0
        ? html`<div class="card req-empty">
            <p><strong>No accounts yet.</strong></p>
            <p class="muted">Connect one from the command line: <code>heel connect &lt;service&gt; --as &lt;name&gt;</code></p>
          </div>`
        : html`<p class="muted req-count">
              ${props.rows.length === 1 ? "1 account" : `${props.rows.length} accounts`}${
                waiting === 0 ? "" : `, ${waiting} need${waiting === 1 ? "s" : ""} you`
              }
            </p>
            <ul class="conn-list" aria-label="Your accounts">
              ${props.rows.map((row) => {
                const step = nextStep(row, props.signInForm);
                return html`<li class="card conn" data-alias="${row.alias}">
                  <div class="conn-head">
                    <div>
                      <h2 class="conn-name mono">${row.alias}</h2>
                      <p class="muted conn-kind">${providerLabel(row.provider)}</p>
                    </div>
                    ${row.status === "active" ? badge("Ready", "ok") : badge("Needs sign-in", "warn")}
                  </div>
                  ${step === "" ? "" : html`<div class="conn-step">${step}</div>`}
                </li>`;
              })}
            </ul>`
    }
    <div class="card conn-add">
      <h2>Connect another account</h2>
      <p class="muted">From the machine heel runs on. heel asks for the key on stdin, or for Gmail,
        Calendar and Outlook, you sign in here afterwards.</p>
      <pre class="args">heel connect github --as github --credential-stdin
heel connect gmail --as gmail-work
heel connect mcp --as notes --url https://notes.example.com/mcp --oauth</pre>
    </div>`;
}
