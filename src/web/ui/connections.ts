import type { SignInSetup } from "../../definitions/sign-in-setup.ts";
import type { AccountStatus } from "../../store/schema.ts";
import { ceremonyButton } from "./ceremony.ts";
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
  /** It holds an API key (not a sign-in), which can be replaced here (2.9). */
  holdsKey?: boolean;
  /** Who else may use it, and who decides its asks (D13b), by name. */
  sharing?: {
    sharedWith: readonly { user?: string; group?: string }[];
    approvers: readonly { user?: string; group?: string; repo?: string }[];
  };
}

export type ConnectionsOutcome =
  | { kind: "none" }
  | { kind: "connected"; alias: string }
  | { kind: "failed"; alias: string; message: string }
  | { kind: "added" | "rekeyed" | "removed" | "sharing"; alias: string; unchecked: boolean };

export interface ConnectionsProps {
  rows: readonly ConnectionRow[];
  outcome: ConnectionsOutcome;
  signInForm: FormTarget;
  /** Connecting, replacing a key and removing from here (2.9). */
  manage?: {
    csrfToken: string;
    /** Everyone else on this heel, by name: who an account can be shared with. */
    people?: readonly string[];
    /** People sign in with an IdP, so its groups can be named. */
    groups?: boolean;
  };
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
    case "added":
    case "rekeyed": {
      const said =
        outcome.kind === "added"
          ? html`Connected <strong>${outcome.alias}</strong>. If it signs in, sign in below; otherwise agents can use it now.`
          : html`Replaced <strong>${outcome.alias}</strong>'s key. Agents use the new one from now on.`;
      return notice(
        "ok",
        html`<p>${said}${outcome.unchecked ? " heel couldn't check the key with the service, so it was stored unchecked." : ""}</p>`,
      );
    }
    case "sharing":
      return notice(
        "ok",
        html`<p>Changed who can use <strong>${outcome.alias}</strong> and who approves its requests.</p>`,
      );
    case "removed":
      return notice(
        "info",
        html`<p>Removed <strong>${outcome.alias}</strong> and its stored key.</p>`,
      );
  }
}

const SERVICE_CHOICES = [
  ["github", "GitHub (a token)"],
  ["slack", "Slack (a bot token)"],
  ["linear", "Linear (an API key)"],
  ["notion", "Notion (an integration token)"],
  ["stripe", "Stripe (a restricted key)"],
  ["gmail", "Gmail (sign in after)"],
  ["google-calendar", "Google Calendar (sign in after)"],
  ["outlook", "Outlook (sign in after)"],
  ["mcp", "A remote MCP server (its URL; sign in after if it asks)"],
] as const;

/** Services you sign in to after connecting: no key to paste. */
const SIGN_IN_SERVICES = ["gmail", "google-calendar", "outlook"];

/** Which fields a service needs: a key, a URL (MCP servers), or neither (it signs in after). */
const SHOW_FIELDS = `const f=this.closest('.stack-form'),v=this.value,need=v==='mcp'?'mcp':${JSON.stringify(SIGN_IN_SERVICES).replace(/"/g, "'")}.includes(v)?'signin':'key';for(const r of f.querySelectorAll('[data-for]'))r.hidden=r.dataset.for!==need`;

function connectForm(): Html {
  // A div, not a form: nothing here can ever submit, so the key can't end up in a URL.
  return html`<div id="connect-form" class="stack-form">
    <input type="hidden" name="op" value="connect" />
    <div class="row">
      <label for="connect-service">Service</label>
      <select id="connect-service" name="service" onchange="${SHOW_FIELDS}">
        ${SERVICE_CHOICES.map(([value, label]) => html`<option value="${value}">${label}</option>`)}
      </select>
    </div>
    <div class="row">
      <label for="connect-alias">Name</label>
      <input id="connect-alias" name="alias" maxlength="64" autocomplete="off" placeholder="github-work" />
    </div>
    <div class="row" data-for="mcp" hidden>
      <label for="connect-url">Server URL</label>
      <input id="connect-url" name="url" placeholder="https://notes.example.com/mcp" autocomplete="off" />
    </div>
    <div class="row" data-for="mcp" hidden>
      <label for="connect-oauth">Signs in with OAuth?</label>
      <select id="connect-oauth" name="oauth">
        <option value="yes">Yes (most do): sign in after</option>
        <option value="no">No: it needs no sign-in</option>
      </select>
    </div>
    <div class="row" data-for="key">
      <label for="connect-key">Key or token</label>
      <input id="connect-key" name="key" type="password" autocomplete="off" />
    </div>
    <p class="muted" data-for="signin" hidden>You sign in right after, on this page.</p>
    <p class="muted">The name is how rules and tools call it. A key goes only to heel's vault, checked with the service first.</p>
    ${ceremonyButton({
      callback: { handler: "manageAccount" },
      intent: "manage-account",
      label: "Connect with your passkey",
      tone: "primary",
      binding: {},
      optionsFrom: "connect-form",
    })}
  </div>`;
}

type Manage = NonNullable<ConnectionsProps["manage"]>;

function principalName(p: { user?: string; group?: string }): string {
  return p.user ?? `the ${p.group ?? "?"} group`;
}

/** Who else may use an account, and who decides its asks (D13b). */
function sharingControls(row: ConnectionRow, manage: Manage, key: string): Html {
  const people = manage.people ?? [];
  const sharing = row.sharing ?? { sharedWith: [], approvers: [] };
  if (people.length === 0 && manage.groups !== true && sharing.sharedWith.length === 0) {
    return html`<p class="muted">Only you can use it. Once other people use this heel, you can share it here.</p>`;
  }
  const general = sharing.approvers.filter((a) => a.repo === undefined);
  const byRepo = sharing.approvers.filter((a) => a.repo !== undefined);
  const isGitHub = row.provider === "github" || row.provider === "cli:gh";
  return html`<h3>Who can use it</h3>
    <ul class="plain-list">
      <li>You (it's yours)</li>
      ${sharing.sharedWith.map(
        (p) => html`<li>${principalName(p)}
          ${postForm(
            {
              action: `/connections/${encodeURIComponent(row.alias)}/unshare`,
              csrfToken: manage.csrfToken,
            },
            { kind: p.group === undefined ? "user" : "group", name: p.user ?? p.group ?? "" },
            html`<button type="submit" class="btn btn-secondary btn-small">Stop sharing</button>`,
          )}
        </li>`,
      )}
    </ul>
    <div id="share-${key}" class="stack-form">
      <input type="hidden" name="op" value="share" />
      ${
        manage.groups === true
          ? html`<div class="row">
              <label for="share-${key}-kind">Share with</label>
              <select id="share-${key}-kind" name="kind">
                <option value="user">a person</option>
                <option value="group">a group</option>
              </select>
            </div>
            <div class="row">
              <label for="share-${key}-group">Group (if a group)</label>
              <input id="share-${key}-group" name="group" maxlength="256" autocomplete="off" />
            </div>`
          : html`<input type="hidden" name="kind" value="user" />`
      }
      <div class="row">
        <label for="share-${key}-person">Person</label>
        <select id="share-${key}-person" name="person">
          ${people.map((name) => html`<option value="${name}">${name}</option>`)}
        </select>
      </div>
      ${ceremonyButton({
        callback: { handler: "manageAccount" },
        intent: "manage-account",
        label: "Share with your passkey",
        tone: "secondary",
        binding: { alias: row.alias },
        optionsFrom: `share-${key}`,
      })}
    </div>
    <h3>Who approves its requests</h3>
    <p class="muted">${
      general.length === 0 ? "You do." : `${general.map(principalName).join(", ")}, instead of you.`
    }${byRepo.length === 0 ? "" : ` For ${[...new Set(byRepo.map((a) => a.repo))].join(", ")}: ${byRepo.map((a) => `${principalName(a)} (${a.repo})`).join(", ")}.`}</p>
    <div id="approvers-${key}" class="stack-form">
      <input type="hidden" name="op" value="approvers" />
      ${people.map(
        (name, i) => html`<div class="row">
          <label for="approvers-${key}-${String(i)}">${name}</label>
          <input id="approvers-${key}-${String(i)}" type="checkbox" name="user:${name}"${general.some((a) => a.user === name) ? " checked" : ""} />
        </div>`,
      )}
      ${
        manage.groups === true
          ? html`<div class="row">
              <label for="approvers-${key}-groups">Groups (comma between)</label>
              <input id="approvers-${key}-groups" name="groups" autocomplete="off" />
            </div>`
          : ""
      }
      ${
        isGitHub
          ? html`<div class="row">
              <label for="approvers-${key}-repo">Only for repo (optional)</label>
              <input id="approvers-${key}-repo" name="repo" placeholder="owner/name" autocomplete="off" />
            </div>`
          : ""
      }
      <p class="muted">Nobody ticked means you decide again.</p>
      ${ceremonyButton({
        callback: { handler: "manageAccount" },
        intent: "manage-account",
        label: "Save approvers with your passkey",
        tone: "secondary",
        binding: { alias: row.alias },
        optionsFrom: `approvers-${key}`,
      })}
    </div>`;
}

function rowControls(row: ConnectionRow, manage: Manage, index: number): Html {
  const { csrfToken } = manage;
  // By row, not by name: no two names can make the same id.
  const key = `row${String(index)}`;
  return html`<details class="conn-manage">
    <summary>Manage ${row.alias}</summary>
    ${
      row.holdsKey === true
        ? html`<div id="rekey-${key}" class="stack-form">
            <div class="row">
              <label for="rekey-${key}-key">New key</label>
              <input id="rekey-${key}-key" name="key" type="password" autocomplete="off" />
            </div>
            ${ceremonyButton({
              callback: { handler: "manageAccount" },
              intent: "manage-account",
              label: "Replace with your passkey",
              tone: "secondary",
              binding: { op: "rekey", alias: row.alias },
              optionsFrom: `rekey-${key}`,
            })}
          </div>`
        : ""
    }
    ${sharingControls(row, manage, key)}
    <h3>Remove it</h3>
    ${postForm(
      { action: `/connections/${encodeURIComponent(row.alias)}/remove`, csrfToken },
      {},
      html`<button type="submit" class="btn btn-danger" onclick="return confirm('Remove ${row.alias}? Its stored key goes, and agents can no longer use it.')">Remove ${row.alias}</button>`,
    )}
  </details>`;
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
            <p class="muted">Connect one below, or from the command line: <code>heel connect &lt;service&gt; --as &lt;name&gt;</code></p>
          </div>`
        : html`<p class="muted req-count">
              ${props.rows.length === 1 ? "1 account" : `${props.rows.length} accounts`}${
                waiting === 0 ? "" : `, ${waiting} need${waiting === 1 ? "s" : ""} you`
              }
            </p>
            <ul class="conn-list" aria-label="Your accounts">
              ${props.rows.map((row, index) => {
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
                  ${props.manage === undefined ? "" : rowControls(row, props.manage, index)}
                </li>`;
              })}
            </ul>`
    }
    <div class="card conn-add">
      <h2>Connect another account</h2>
      ${props.manage === undefined ? "" : connectForm()}
      <p class="muted">Or from the machine heel runs on. heel asks for the key on stdin, or for Gmail,
        Calendar and Outlook, you sign in here afterwards.</p>
      <pre class="args">heel connect github --as github --credential-stdin
heel connect gmail --as gmail-work
heel connect mcp --as notes --url https://notes.example.com/mcp --oauth</pre>
    </div>`;
}
