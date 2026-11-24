import type { SignInSetup } from "../../definitions/sign-in-setup.ts";
import type { AccountStatus } from "../../store/schema.ts";
import { ceremonyButton } from "./ceremony.ts";
import { dialog, dialogTrigger } from "./dialog.ts";
import { formatRelative, middle } from "./format.ts";
import { type Html, html, trusted } from "./html.ts";
import { CHEVRON_DOWN, ELLIPSIS } from "./icons.ts";
import { badge, type FormTarget, notice, postForm, time } from "./layout.ts";
import { serviceLogo } from "./logos.ts";
import {
  LIST_AFTER,
  OTHER_CHOICES,
  type ServiceChoice,
  serviceChoices,
} from "./service-choices.ts";
import { btn } from "./shadcn/button.ts";

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
  /** When heel last decided a call on it, from the audit log; null if never. */
  lastUsedAt?: Date | null;
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
  /** For "last used 3 h ago"; defaults to the time of rendering. */
  now?: Date;
  /** Connecting, replacing a key and removing from here (2.9). */
  manage?: {
    csrfToken: string;
    /** Everyone else on this heel, by name: who an account can be shared with. */
    people?: readonly string[];
    /** People sign in with an IdP, so its groups can be named. */
    groups?: boolean;
    /** Admins name approvers (spec: Teams); owners see who they are. */
    admin?: boolean;
  };
  /** The add-a-connection dialog open on load, optionally with a service picked (preview states). */
  connect?: {
    open?: boolean;
    picked?: string;
    /** Preview only: a longer list of services than heel has, to show the list layout. */
    choices?: readonly ServiceChoice[];
    /** Preview only: what's typed in search. */
    query?: string;
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

/** lucide's chevron-left and chevron-right, for Back and the list rows. */
const CHEVRON_LEFT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>`;
const CHEVRON_RIGHT_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`;
/** lucide's terminal, for Any CLI. */
const TERMINAL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19h8"/><path d="m4 17 6-6-6-6"/></svg>`;

/**
 * Step 1's behaviour, in one small script that runs once per dialog:
 * - Search filters the rows by name and other words ("mail" finds Gmail).
 * - Arrow keys move through the visible rows without picking; Enter or
 *   Space picks. From the search field, Down goes to the first row and
 *   Enter picks the first match. Escape closes the dialog (the browser's own).
 * - Picking fills in the name (until you type your own) and the key's help
 *   line. With a mouse it focuses the name; on a touch screen it doesn't,
 *   so the keyboard can't cover the Connect button.
 * - On open, with a mouse, focus lands in search; on touch it doesn't, so
 *   the keyboard doesn't cover the list.
 */
const CONNECT_SCRIPT = `(() => {
  const form = document.currentScript.previousElementSibling;
  const dialog = form.closest("dialog");
  const search = form.querySelector(".connect-search");
  const empty = form.querySelector(".svc-empty");
  const fine = () => matchMedia("(pointer: fine)").matches;
  const rows = () => [...form.querySelectorAll(".svc-tile")].filter((t) => !t.hidden);
  const radios = () => rows().map((t) => t.querySelector(".svc-radio"));
  const filter = () => {
    const words = search.value.toLowerCase().trim().split(/\\s+/).filter(Boolean);
    for (const tile of form.querySelectorAll(".svc-tile")) {
      const hay = tile.dataset.find;
      tile.hidden = !words.every((w) => hay.includes(w));
    }
    for (const group of form.querySelectorAll(".svc-list")) {
      const label = group.previousElementSibling;
      const any = [...group.children].some((t) => !t.hidden);
      group.hidden = !any;
      if (label && label.classList.contains("svc-group")) label.hidden = !any;
    }
    empty.hidden = rows().length > 0;
  };
  const pick = (radio) => {
    radio.checked = true;
    radio.dispatchEvent(new Event("change", { bubbles: true }));
  };
  search.addEventListener("input", filter);
  search.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") { event.preventDefault(); radios()[0]?.focus(); }
    if (event.key === "Enter") { event.preventDefault(); const first = radios()[0]; if (first) pick(first); }
  });
  form.querySelector(".svc-grid").addEventListener("keydown", (event) => {
    const radio = event.target.closest(".svc-radio");
    if (!radio) return;
    const list = radios();
    const at = list.indexOf(radio);
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
    if (step !== undefined) {
      event.preventDefault();
      const next = list[at + step];
      if (next) next.focus();
      else if (step < 0) search.focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(radio);
    }
  });
  empty.querySelector("button").addEventListener("click", () => {
    const mcp = form.querySelector('.svc-radio[value="mcp"]');
    search.value = "";
    filter();
    pick(mcp);
  });
  form.querySelector(".svc-grid").addEventListener("change", (event) => {
    const radio = event.target.closest(".svc-radio");
    const name = document.getElementById("connect-alias");
    if (!radio || !name) return;
    if (!name.value || name.dataset.auto === "1") { name.value = radio.dataset.alias || ""; name.dataset.auto = name.value ? "1" : ""; }
    const help = document.getElementById("connect-help");
    help.textContent = radio.dataset.help ? radio.dataset.help + ". " : "";
    if (radio.dataset.keyPage) {
      const link = document.createElement("a");
      link.href = radio.dataset.keyPage;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Get one";
      help.append(link);
    }
    const panel = form.closest(".ui-dialog-panel");
    if (panel) panel.scrollTop = 0;
    if (fine() && radio.dataset.need !== "cli") name.focus();
  });
  form.querySelector(".connect-back").addEventListener("click", () => {
    const was = form.querySelector(".svc-radio:checked");
    for (const r of form.querySelectorAll(".svc-radio")) r.checked = false;
    (was || radios()[0])?.focus();
  });
  if (dialog) {
    new MutationObserver(() => {
      if (dialog.open && fine() && !form.querySelector(".svc-radio:checked")) search.focus();
    }).observe(dialog, { attributes: true, attributeFilter: ["open"] });
  }
  if (search.value) filter();
})();`;

function serviceRow(c: ServiceChoice, picked: string | null): Html {
  const logo =
    c.need === "cli"
      ? html`<span class="svc-logo svc-letter" aria-hidden="true">${trusted(TERMINAL)}</span>`
      : serviceLogo(c.value, c.name);
  const find = `${c.name} ${c.value} ${c.terms ?? ""}`.toLowerCase();
  return html`<label class="svc-tile" data-find="${find}">
    <input type="radio" class="svc-radio" name="service" value="${c.value}" data-need="${c.need}" data-alias="${c.alias}"${c.help ? html` data-help="${c.help}"` : ""}${c.keyPage ? html` data-key-page="${c.keyPage}"` : ""}${c.value === picked ? trusted(" checked") : ""} />
    ${logo}
    <span class="svc-tile-name">${c.name}</span>
    <span class="svc-tile-go" aria-hidden="true">${trusted(CHEVRON_RIGHT_SVG)}</span>
  </label>`;
}

/**
 * The add-a-connection form, in its dialog, in two steps. Step 1: a search
 * field and the services, as tiles while there are few and as a one-column
 * list past `LIST_AFTER`, scrolling under the search field, with MCP server
 * and Any CLI always last under Other. Picking one is step 2: Back and the
 * service as a chip, the name, the key or URL it needs, and the Connect
 * button pinned to the bottom of the dialog. Which step shows follows the
 * picked radio in CSS (`:has`). A div, not a form: nothing here can ever
 * submit, so the key can't end up in a URL. The connect ceremony reads
 * every field in it.
 */
function connectForm(
  picked: string | null,
  choices: readonly ServiceChoice[],
  query: string,
): Html {
  const all = [...choices, ...OTHER_CHOICES];
  const chosen = all.find((c) => c.value === picked);
  const layout = choices.length > LIST_AFTER ? "list" : "grid";
  return html`<div id="connect-form" class="connect-form" data-layout="${layout}">
    <input type="hidden" name="op" value="connect" />
    <input type="search" class="connect-search" aria-label="Search services" placeholder="Search" autocomplete="off" spellcheck="false" value="${query}" />
    <fieldset class="svc-grid">
      <legend class="visually-hidden">Service</legend>
      <button type="button" class="connect-back">${trusted(CHEVRON_LEFT)}Back</button>
      <div class="svc-scroll">
        <div class="svc-list">${choices.map((c) => serviceRow(c, picked))}</div>
        <p class="svc-group">Other</p>
        <div class="svc-list svc-other">${OTHER_CHOICES.map((c) => serviceRow(c, picked))}</div>
        <p class="svc-empty muted" hidden>No match. Try <button type="button" class="svc-empty-mcp">MCP server</button> for anything else.</p>
      </div>
    </fieldset>
    <div id="connect-fields" class="connect-fields">
      <div class="connect-field connect-name">
        <label for="connect-alias">Name</label>
        <input id="connect-alias" name="alias" maxlength="64" autocomplete="off" placeholder="notes" autocapitalize="off" autocorrect="off" spellcheck="false" value="${chosen?.alias ?? ""}" oninput="this.dataset.auto=''"${chosen?.alias ? trusted(' data-auto="1"') : ""} />
        <p class="muted">How rules and tools call it.</p>
      </div>
      <div class="connect-field" data-for="mcp">
        <label for="connect-url">Server URL</label>
        <input id="connect-url" name="url" placeholder="https://notes.example.com/mcp" autocomplete="off" />
      </div>
      <div class="connect-field" data-for="mcp">
        <label for="connect-oauth">Signs in with OAuth?</label>
        <select id="connect-oauth" name="oauth">
          <option value="yes">Yes (most do): sign in after</option>
          <option value="no">No: it needs no sign-in</option>
        </select>
      </div>
      <div class="connect-field" data-for="key">
        <label for="connect-key">Key or token</label>
        <input id="connect-key" name="key" type="password" autocomplete="off" />
        <p id="connect-help" class="muted">${chosen?.help ? `${chosen.help}. ` : ""}${
          chosen?.keyPage
            ? html`<a href="${chosen.keyPage}" target="_blank" rel="noopener noreferrer">Get one</a>`
            : ""
        }</p>
      </div>
      <p class="muted" data-for="signin">You sign in right after, on this page.</p>
      <div class="connect-field" data-for="cli">
        <p class="muted">Run this on heel's host:</p>
        <pre class="args">heel connect cli gh --as gh --bin /usr/bin/gh --credential-stdin</pre>
      </div>
      <div class="connect-go">
        <p id="connect-status" class="connect-status" role="status" aria-live="polite"></p>
        ${ceremonyButton({
          callback: { handler: "manageAccount" },
          intent: "manage-account",
          label: "Connect with your passkey",
          tone: "primary",
          binding: {},
          optionsFrom: "connect-form",
          statusId: "connect-status",
        })}
      </div>
    </div>
  </div>
  <script>${trusted(CONNECT_SCRIPT)}</script>`;
}

/** lucide's plug, for the empty state. */
const PLUG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/></svg>`;

/** The commands that do the same from the machine heel runs on. */
const CLI_FOLD = html`<details class="connect-cli">
  <summary>From the command line${trusted(CHEVRON_DOWN)}</summary>
  <p class="muted">On the machine heel runs on. heel asks for the key on stdin; for Gmail, Calendar and Outlook you sign in here afterwards.</p>
  <pre class="args">heel connect github --as github --credential-stdin
heel connect gmail --as gmail-work
heel connect mcp --as notes --url https://notes.example.com/mcp --oauth</pre>
</details>`;

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
  const repos = [...new Set(byRepo.flatMap((a) => (a.repo === undefined ? [] : [a.repo])))];
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
            html`<button type="submit" class="${btn("outline", "sm")}">Stop sharing</button>`,
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
    }${repos
      .map(
        (repo) =>
          ` For ${repo}: ${byRepo
            .filter((a) => a.repo === repo)
            .map(principalName)
            .join(", ")}.`,
      )
      .join("")}</p>
    ${
      manage.admin === true
        ? html`${approversForm(row, manage, `${key}-all`, null, general)}
          ${repos.map((repo, i) =>
            approversForm(
              row,
              manage,
              `${key}-r${String(i)}`,
              repo,
              byRepo.filter((a) => a.repo === repo),
            ),
          )}
          ${isGitHub ? approversForm(row, manage, `${key}-new`, "", []) : ""}`
        : html`<p class="muted">An admin sets who approves an account's requests.</p>`
    }`;
}

/**
 * Approvers for one scope: every call (`repo` null), one repo already named,
 * or a new repo (`""`). Each form starts from that scope's own approvers,
 * since saving replaces exactly that scope.
 */
function approversForm(
  row: ConnectionRow,
  manage: Manage,
  id: string,
  repo: string | null,
  current: readonly { user?: string; group?: string }[],
): Html {
  const people = manage.people ?? [];
  const groups = current.flatMap((a) => (a.group === undefined ? [] : [a.group]));
  const title =
    repo === null ? "For every call" : repo === "" ? "For one repo" : `For ${repo} only`;
  return html`<div id="approvers-${id}" class="stack-form approvers-form">
    <p class="muted"><strong>${title}</strong></p>
    <input type="hidden" name="op" value="approvers" />
    ${
      repo === ""
        ? html`<input type="hidden" name="scope" value="repo" />
          <div class="row">
            <label for="approvers-${id}-repo">Repo</label>
            <input id="approvers-${id}-repo" name="repo" placeholder="owner/name" autocomplete="off" />
          </div>`
        : html`<input type="hidden" name="repo" value="${repo ?? ""}" />`
    }
    ${people.map(
      (name, i) => html`<div class="row">
        <label for="approvers-${id}-${String(i)}">${name}</label>
        <input id="approvers-${id}-${String(i)}" type="checkbox" name="user:${name}"${current.some((a) => a.user === name) ? " checked" : ""} />
      </div>`,
    )}
    ${
      manage.groups === true
        ? html`<div class="row">
            <label for="approvers-${id}-groups">Groups (one per line)</label>
            <textarea id="approvers-${id}-groups" name="groups" rows="2" spellcheck="false">
${groups.join("\n")}</textarea>
          </div>`
        : ""
    }
    <p class="muted">${
      repo === null
        ? "Nobody named means the owner decides again."
        : repo === ""
          ? "Calls on that repo go to them instead, replacing any approvers it already has."
          : "Nobody named means calls on this repo go back to the approvers for every call."
    }</p>
    ${ceremonyButton({
      callback: { handler: "manageAccount" },
      intent: "manage-account",
      label: "Save with your passkey",
      tone: "secondary",
      binding: { alias: row.alias },
      optionsFrom: `approvers-${id}`,
    })}
  </div>`;
}

function rowControls(row: ConnectionRow, manage: Manage, index: number): Html {
  const { csrfToken } = manage;
  // By row, not by name: no two names can make the same id.
  const key = `row${String(index)}`;
  return html`<details class="conn-manage">
    <summary class="${btn("ghost", "icon-sm")}" title="Manage ${row.alias}"><span class="visually-hidden">Manage ${row.alias}</span>${trusted(ELLIPSIS)}</summary>
    <div class="conn-manage-panel">
    <p class="conn-manage-title">Manage <span class="mono">${row.alias}</span></p>
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
      html`<button type="submit" class="${btn("danger")}" onclick="return confirm('Remove ${row.alias}? Its stored key goes, and agents can no longer use it.')">Remove ${row.alias}</button>`,
    )}
    </div>
  </details>`;
}

/** Signing in needs the operator's own OAuth client first: say which key, and where the steps are. */
function setupNeeded(setup: SignInSetup): Html {
  return html`<span class="muted"
    >Needs ${setup.label} sign-in set up: <code>${setup.configKey}</code>.
    <a href="${setup.docsUrl}" target="_blank" rel="noopener">How</a></span
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

/**
 * The one next step a row shows, or nothing when the account is ready and
 * needs none: a sign-in button (on the right of the row) or a hint to set
 * something up first (a muted line under the name).
 */
function nextStep(
  row: ConnectionRow,
  signInForm: FormTarget,
): { kind: "action" | "hint"; html: Html } | null {
  const ready = row.status === "active";
  // A client to configure matters only to an account that still has to sign in.
  if (row.setup !== null && !ready) return { kind: "hint", html: setupNeeded(row.setup) };
  if (row.signsIn && row.setup === null) {
    return {
      kind: "action",
      html: postForm(
        signInForm,
        { alias: row.alias },
        html`<button type="submit" class="${btn(ready ? "outline" : "default", "sm")}">${ready ? "Sign in again" : "Sign in"}</button>`,
      ),
    };
  }
  if (!ready) {
    return {
      kind: "hint",
      html: html`<span class="muted"
        >Give heel a new key: <code>heel account set ${row.alias} --credential-stdin</code></span
      >`,
    };
  }
  return null;
}

/** The status in words; colour only repeats it. */
function statusPill(row: ConnectionRow): Html {
  if (row.status === "active") return badge("Ready", "ok");
  if (row.setup !== null) return badge("Set up first", "warn");
  if (row.signsIn) return badge("Needs sign-in", "warn");
  return badge("Needs a new key", "error");
}

function lastUsed(row: ConnectionRow, now: Date): Html {
  const at = row.lastUsedAt ?? null;
  if (at === null) return html`<span class="muted">Not used yet</span>`;
  return html`<span class="muted">Used ${formatRelative(at, now)}</span><span class="visually-hidden">, ${time(at)}</span>`;
}

/**
 * The accounts a person owns, and sign-in for the ones whose server wants it
 * (D5c). Signing in happens on the server's own page; heel keeps the tokens
 * in its vault and never shows them.
 */
export function connectionsPage(props: ConnectionsProps): Html {
  const now = props.now ?? new Date();
  const waiting = props.rows.filter((row) => row.status !== "active").length;
  const canAdd = props.manage !== undefined;
  const addButton = canAdd
    ? dialogTrigger({ dialogId: "connect-another", label: "Add connection" })
    : "";
  return html`<div class="conn-page-head">
      <div>
        <h1>Connections</h1>
      </div>
      ${addButton}
    </div>
    ${outcomeNotice(props.outcome)}
    ${
      props.rows.length === 0
        ? html`<div class="req-empty conn-empty">
            <span class="req-empty-icon conn-empty-icon">${trusted(PLUG)}</span>
            <p class="req-empty-title">No accounts yet</p>
            <p class="muted">Connect Gmail, Calendar, GitHub or any API so your agents can use it through heel.</p>
            ${canAdd ? dialogTrigger({ dialogId: "connect-another", label: "Add connection", className: btn("outline", "sm") }) : html`<p class="muted">From the command line: <code>heel connect &lt;service&gt; --as &lt;name&gt;</code></p>`}
          </div>`
        : html`<section class="conn-table" aria-labelledby="conn-count">
            <p class="conn-table-head" id="conn-count">
              ${props.rows.length === 1 ? "1 account" : `${props.rows.length} accounts`}${
                waiting === 0 ? "" : `, ${waiting} need${waiting === 1 ? "s" : ""} you`
              }
            </p>
            <ul class="conn-rows" aria-label="Your accounts">
              ${props.rows.map((row, index) => {
                const step = nextStep(row, props.signInForm);
                return html`<li class="conn" data-alias="${row.alias}" data-status="${row.status}">
                  <div class="conn-main">
                    <span class="conn-icon">${serviceLogo(row.provider, row.alias)}</span>
                    <div class="conn-id">
                      <h2 class="conn-name mono" title="${row.alias}">${middle(row.alias)}</h2>
                      <p class="muted conn-kind">${providerLabel(row.provider)} · ${lastUsed(row, now)}</p>
                      ${step?.kind === "hint" ? html`<p class="conn-step conn-hint">${step.html}</p>` : ""}
                    </div>
                    <div class="conn-status">${statusPill(row)}</div>
                    <div class="conn-actions">
                      ${step?.kind === "action" ? html`<div class="conn-step">${step.html}</div>` : ""}
                      ${props.manage === undefined ? "" : rowControls(row, props.manage, index)}
                    </div>
                  </div>
                </li>`;
              })}
            </ul>
          </section>`
    }
    ${
      canAdd
        ? dialog({
            id: "connect-another",
            title: "Add a connection",
            wide: true,
            ...(props.connect?.open ? { open: true } : {}),
            body: html`${connectForm(props.connect?.picked ?? null, props.connect?.choices ?? serviceChoices(), props.connect?.query ?? "")} ${CLI_FOLD}`,
          })
        : html`<section class="card conn-add">
            <h2>Connect from the command line</h2>
            ${CLI_FOLD}
          </section>`
    }`;
}
