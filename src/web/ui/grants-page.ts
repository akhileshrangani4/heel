import { ceremonyButton } from "./ceremony.ts";
import { type Html, html } from "./html.ts";
import { type FormTarget, notice, postForm, time } from "./layout.ts";

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
}): Html {
  const outcome =
    props.outcome.kind === "granted"
      ? notice("ok", html`<p>Granted. The agent can do what it names until it ends.</p>`)
      : props.outcome.kind === "revoked"
        ? notice("ok", html`<p>Revoked. It applies from the agent's next call.</p>`)
        : "";
  return html`<h1>Grants</h1>
    <p class="muted">
      A grant lets one agent do one narrow thing for a task you describe, without asking each time.
      It answers your rules' asks and calls no rule covers; it never overrides a deny, your
      organization's rules, or a request someone denied. It ends when it expires or you revoke it, and
      you sign each one with your passkey.
    </p>
    ${outcome}
    <form id="grant-form" class="card grant-form" onsubmit="return false">
      <h2>Grant something new</h2>
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
      })}
    </form>
    <h2>Grants</h2>
    ${
      props.grants.length === 0
        ? html`<p class="muted">No grants yet.</p>`
        : html`<ul class="req-list" aria-label="Grants">
            ${props.grants.map(
              (g) => html`<li class="card req" data-status="${g.state}">
                <div class="ap-meta">
                  <span class="ap-agent">${g.agent}</span>
                  <span class="muted">${g.state === "live" ? html`ends ${time(g.expiresAt)}` : g.state}</span>
                </div>
                <h3 class="req-title">${g.task}</h3>
                <div class="req-foot-row">
                  <p class="req-foot"><span class="muted">Allows</span> <code>${g.match}</code></p>
                  ${
                    g.state === "live"
                      ? postForm(
                          props.revoke,
                          { id: g.id },
                          html`<button type="submit" class="btn btn-secondary" aria-label="Revoke the grant for ${g.agent}: ${g.task}">Revoke</button>`,
                        )
                      : ""
                  }
                </div>
              </li>`,
            )}
          </ul>`
    }`;
}
