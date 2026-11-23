import { ceremonyButton } from "./ceremony.ts";
import { dialog, dialogTrigger } from "./dialog.ts";
import { formatRelative, formatUtc } from "./format.ts";
import { type Html, html, trusted } from "./html.ts";
import { CHEVRON_DOWN } from "./icons.ts";
import { badge, type FormTarget, notice, postForm, scrollRegion } from "./layout.ts";
import { btn } from "./shadcn/button.ts";

/**
 * The Grants page (A4b): a person states a task, writes what the agent may
 * do for it as one rules-language `match`, and signs it with a passkey.
 * Revoking is a plain form, since it can only stop calls.
 */

export interface GrantView {
  id: string;
  agent: string;
  task: string;
  match: string;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
  state: "live" | "expired" | "revoked";
}

export type GrantsOutcome = { kind: "none" } | { kind: "granted" } | { kind: "revoked" };

const DURATIONS = [
  { value: "1h", label: "1 hour" },
  { value: "1d", label: "1 day" },
  { value: "7d", label: "7 days" },
] as const;

export function grantsPage(props: {
  grants: readonly GrantView[];
  agents: readonly { id: string; name: string }[];
  outcome: GrantsOutcome;
  revoke: FormTarget;
  now?: Date;
}): Html {
  const outcome =
    props.outcome.kind === "granted"
      ? notice("ok", html`<p>Granted. The agent can do what it names until it ends.</p>`)
      : props.outcome.kind === "revoked"
        ? notice("ok", html`<p>Revoked. It applies from the agent's next call.</p>`)
        : "";
  const now = props.now ?? new Date();
  return html`<div class="page-head">
      <div>
        <h1>Grants</h1>
        <p class="muted">Let one agent do one narrow thing for a task, without asking each time.</p>
      </div>
      ${dialogTrigger({ dialogId: "grant-dialog", label: html`<span aria-hidden="true">+</span> New grant`, className: btn("default", "sm") })}
    </div>
    ${howItWorks(
      "How grants work",
      html`A grant lets one agent do one narrow thing for a task you describe, without asking each
      time. It answers your rules' asks and calls no rule covers; it never overrides a deny, your
      organization's rules, or a request someone denied. It ends when it expires or you revoke it, and
      you sign each one with your passkey.`,
    )}
    ${outcome}
    ${dialog({
      id: "grant-dialog",
      title: "Grant something new",
      description:
        "Describe the task, write what the agent may do for it as a rule's match, and sign it with your passkey.",
      body: html`<form id="grant-form" class="grant-form dialog-form" onsubmit="return false">
        <label for="grant-agent">Agent</label>
        <select id="grant-agent" name="agent">
          ${props.agents.map((a) => html`<option value="${a.id}">${a.name}</option>`)}
        </select>
        <label for="grant-task">Task</label>
        <input id="grant-task" name="task" maxlength="500" placeholder="Send the Q3 numbers to the vendor" />
        <label for="grant-match">What it may do (a rule's match)</label>
        <textarea id="grant-match" name="match" rows="3" class="mono"
          placeholder="{ action: email.send, recipients: { all_domain_in: [vendor.com], max: 5 } }"></textarea>
        <label for="grant-duration">Lasts</label>
        <select id="grant-duration" name="duration">
          ${DURATIONS.map((d) => html`<option value="${d.value}">${d.label}</option>`)}
        </select>
        ${ceremonyButton({
          callback: { handler: "grant" },
          intent: "grant",
          label: "Sign the grant",
          tone: "primary",
          binding: {},
          optionsFrom: "grant-form",
          statusId: "grant-status",
        })}
        <p id="grant-status" class="dialog-status" role="status" aria-live="polite"></p>
      </form>`,
    })}
    ${
      props.grants.length === 0
        ? html`<div class="req-empty">
            <span class="req-empty-icon agents-empty-icon">${trusted(TICKET_ICON)}</span>
            <p class="req-empty-title">No grants yet</p>
            <p class="muted">A grant you sign shows up here until it ends.</p>
          </div>`
        : scrollRegion(
            "Grants",
            html`<table class="data rows-table">
              <caption class="visually-hidden">Grants</caption>
              <thead>
                <tr><th scope="col">Task</th><th scope="col">Allows</th><th scope="col">Ends</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr>
              </thead>
              <tbody>
                ${props.grants.map(
                  (g) => html`<tr data-status="${g.state}">
                    <td><strong>${g.task}</strong><span class="cell-sub">${g.agent}</span></td>
                    <td><code class="cell-code">${g.match}</code></td>
                    <td>${
                      g.state === "live"
                        ? html`${badge("live", "ok")}<span class="cell-sub"><time datetime="${g.expiresAt.toISOString()}" title="${formatUtc(g.expiresAt)}">ends ${formatRelative(g.expiresAt, now)}</time></span>`
                        : badge(g.state, g.state === "revoked" ? "error" : "muted")
                    }</td>
                    <td class="cell-actions">${
                      g.state === "live"
                        ? postForm(
                            props.revoke,
                            { id: g.id },
                            html`<button type="submit" class="${btn("ghost", "sm", "text-destructive")}" aria-label="Revoke the grant for ${g.agent}: ${g.task}">Revoke</button>`,
                          )
                        : ""
                    }</td>
                  </tr>`,
                )}
              </tbody>
            </table>`,
          )
    }`;
}

/** lucide's ticket. */
const TICKET_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/></svg>`;

/** A small fold holding a page's full explanation, under its one-line intro. */
export function howItWorks(label: string, body: Html): Html {
  return html`<details class="how-fold">
    <summary>${label}${trusted(CHEVRON_DOWN)}</summary>
    <p class="muted">${body}</p>
  </details>`;
}
