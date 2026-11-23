import { ceremonyButton } from "./ceremony.ts";
import { type Html, html } from "./html.ts";
import { notice, postForm, time } from "./layout.ts";

/**
 * Managing agents from the web app (roadmap 2.9): adding one, a new token, a
 * revoke, workdirs. Adding and giving power ask for a passkey; taking it away
 * is a plain button.
 */

const DAYS = [
  { value: "90", label: "90 days" },
  { value: "30", label: "30 days" },
  { value: "365", label: "A year" },
  { value: "never", label: "Never expires" },
];

function daysSelect(id: string): Html {
  return html`<select id="${id}" name="days">
    ${DAYS.map((d) => html`<option value="${d.value}">${d.label}</option>`)}
  </select>`;
}

/** The form that adds an agent: its name, and how long its token lasts. */
export function addAgentForm(): Html {
  return html`<section aria-labelledby="add-agent-heading" class="card">
    <h2 id="add-agent-heading">Add an agent</h2>
    <form id="add-agent-form" class="stack-form" onsubmit="return false">
      <input type="hidden" name="op" value="add" />
      <div class="row">
        <label for="add-agent-name">Name</label>
        <input id="add-agent-name" name="name" maxlength="64" placeholder="claude-code" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
      </div>
      <div class="row">
        <label for="add-agent-days">Token lasts</label>
        ${daysSelect("add-agent-days")}
      </div>
      ${ceremonyButton({
        callback: { handler: "manageAgent" },
        intent: "manage-agent",
        label: "Add with your passkey",
        tone: "primary",
        binding: {},
        optionsFrom: "add-agent-form",
      })}
    </form>
    <p class="muted">Its token is shown once, on the next page. Copy it into the agent's MCP settings.</p>
  </section>`;
}

/** One live agent's controls: a new token, workdirs, revoke. */
export function agentControls(props: {
  name: string;
  workRoots: readonly string[];
  csrfToken: string;
  /** The viewer's own agent: only then a new token or a new workdir (admins can only take away). */
  own: boolean;
}): Html {
  const key = props.name.replace(/[^A-Za-z0-9_-]/g, "-");
  return html`<details class="agent-manage">
    <summary>Manage ${props.name}</summary>
    ${
      props.own
        ? html`<form id="rotate-${key}" onsubmit="return false">
      <label for="rotate-${key}-days">New token lasts</label>
      ${daysSelect(`rotate-${key}-days`)}
      ${ceremonyButton({
        callback: { handler: "manageAgent" },
        intent: "manage-agent",
        label: "New token",
        tone: "secondary",
        binding: { op: "rotate", name: props.name },
        optionsFrom: `rotate-${key}`,
      })}
      <p class="muted">The old token stops working at once, and its running scripts stop.</p>
    </form>`
        : ""
    }
    <h3>Folders its heel run may work in</h3>
    ${
      props.workRoots.length === 0
        ? html`<p class="muted">None yet.</p>`
        : html`<ul class="workdirs">
            ${props.workRoots.map(
              (root) =>
                html`<li><code>${root}</code> ${postForm(
                  {
                    action: `/agents/${encodeURIComponent(props.name)}/workdirs/remove`,
                    csrfToken: props.csrfToken,
                  },
                  { path: root },
                  html`<button type="submit" class="btn btn-secondary">Remove</button>`,
                )}</li>`,
            )}
          </ul>`
    }
    ${
      props.own
        ? html`<form id="workdir-${key}" onsubmit="return false">
      <label for="workdir-${key}-path">Add a folder (an absolute path on heel's machine)</label>
      <input id="workdir-${key}-path" name="path" placeholder="/home/you/project" autocomplete="off" />
      ${ceremonyButton({
        callback: { handler: "manageAgent" },
        intent: "manage-agent",
        label: "Add with your passkey",
        tone: "secondary",
        binding: { op: "workdir", name: props.name },
        optionsFrom: `workdir-${key}`,
      })}
    </form>`
        : ""
    }
    ${postForm(
      { action: `/agents/${encodeURIComponent(props.name)}/revoke`, csrfToken: props.csrfToken },
      {},
      html`<button type="submit" class="btn btn-danger" onclick="return confirm('Revoke ${props.name}? Its tokens stop working at once, and its name can\\'t be used again.')">Revoke ${props.name}</button>`,
    )}
  </details>`;
}

/** A new token, shown once; or why it can't be shown. */
export function newTokenPage(
  view: { name: string; token: string; expiresAt: string | null; mcpUrl: string | null } | null,
): Html {
  if (view === null) {
    return html`<h1>New agent token</h1>
      ${notice(
        "info",
        html`<p>This token was already shown, or more than 5 minutes have passed. heel doesn't keep it.
          Give the agent another from <a href="/agents">Agents</a>.</p>`,
      )}`;
  }
  const command =
    view.mcpUrl === null
      ? null
      : `claude mcp add --scope user --transport http heel ${view.mcpUrl} --header "Authorization: Bearer ${view.token}"`;
  return html`<h1>${view.name}'s token</h1>
    ${notice(
      "warn",
      html`<p><strong>Copy it now: heel shows it only this once.</strong> Anyone with it can act as
        ${view.name} through heel, within your rules.</p>`,
    )}
    <p><label for="new-token">Token</label></p>
    <input id="new-token" class="mono" readonly value="${view.token}" onclick="this.select()" />
    <p class="muted">${view.expiresAt === null ? "It never expires." : html`It expires ${time(new Date(view.expiresAt))}.`}</p>
    ${
      view.mcpUrl === null
        ? ""
        : html`<h2>Add it to the agent</h2>
          <p>MCP address: <code>${view.mcpUrl}</code>, with the token as a bearer token.</p>
          <p>For Claude Code:</p>
          <input class="mono" readonly value="${command ?? ""}" onclick="this.select()" />`
    }
    <p><a class="btn btn-primary" href="/agents">Done</a></p>`;
}
