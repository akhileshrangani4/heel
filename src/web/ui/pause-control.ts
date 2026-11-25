import type { PauseScope } from "../../core/call.ts";
import { type CeremonyCallback, ceremonyButton } from "./ceremony.ts";
import { formatPauseScope } from "./format.ts";
import { type Html, html } from "./html.ts";
import { type FormTarget, notice, postForm, time } from "./layout.ts";
import { btn } from "./shadcn/button.ts";
import { switchFace } from "./switch.ts";

export interface ActivePause {
  scope: PauseScope;
  /** Agent name, account alias or provider; null for a global pause. */
  target: string | null;
  pausedBy: string;
  pausedAt: Date;
  /** Whether this person may lift it (an admin, or whoever paused their own); unset means yes. */
  canResume?: boolean;
}

/**
 * What happened to the last pause or resume, shown once after the redirect
 * back to this page. A failed or expired passkey check leaves the pause on.
 */
export type PauseOutcome =
  | { kind: "none" }
  | { kind: "paused"; scope: PauseScope; target: string | null }
  | { kind: "resumed"; scope: PauseScope; target: string | null }
  | { kind: "resume-refused"; scope: PauseScope; target: string | null; reason: string }
  | { kind: "challenge-expired"; scope: PauseScope; target: string | null };

export interface PauseControlProps {
  outcome: PauseOutcome;
  load:
    | {
        ok: true;
        active: readonly ActivePause[];
        /** What this person may pause: their agents and accounts, or everything for an admin. */
        agents: readonly string[];
        accounts: readonly string[];
        canPauseAll: boolean;
      }
    | { ok: false; message: string };
  /** Pausing posts a plain form: one tap, no passkey, because it can only stop calls. */
  pauseForm: FormTarget;
  /** Resuming starts the passkey ceremony. */
  onResume: CeremonyCallback;
}

/** The shared line every resume switch points at: the passkey rule, said once. */
const RESUME_HELP_ID = "pause-passkey-help";

function activeFor(
  active: readonly ActivePause[],
  scope: PauseScope,
  target: string | null,
): ActivePause | undefined {
  return active.find((p) => p.scope === scope && (scope === "global" || p.target === target));
}

/** Running: a switch that is the pause form's own submit button, so it works with no script. */
function pauseSwitch(form: FormTarget, scope: PauseScope, target: string | null): Html {
  const what = formatPauseScope(scope, target);
  return postForm(
    form,
    { scope, target: target ?? "" },
    html`<button type="submit" class="ui-switch" role="switch" aria-checked="true" aria-label="Pause ${what}">${switchFace(true, "Running")}</button>`,
  );
}

/** Paused: a switch that starts the resume passkey ceremony, or a note when it isn't theirs. */
function resumeSwitch(pause: ActivePause, onResume: CeremonyCallback): Html {
  const what = formatPauseScope(pause.scope, pause.target);
  if (pause.canResume === false) {
    return html`<span class="pause-row-control"><span class="ui-switch" aria-disabled="true">${switchFace(false, "Paused")}</span><span class="muted pause-row-note">Only an admin, or whoever paused it, can resume this.</span></span>`;
  }
  return ceremonyButton({
    callback: onResume,
    intent: "resume",
    label: "Paused",
    tone: "secondary",
    binding: { scope: pause.scope, target: pause.target ?? "" },
    describedBy: RESUME_HELP_ID,
    asSwitch: { checked: false, ariaLabel: `Resume ${what}` },
  });
}

function pauseRow(name: Html, state: Html | "", control: Html): Html {
  return html`<li class="pause-row">
    <div class="pause-row-text">${name}${state === "" ? "" : html`<span class="muted">${state}</span>`}</div>
    ${control}
  </li>`;
}

function pausedBy(pause: ActivePause): Html {
  return html`Paused by ${pause.pausedBy} since ${time(pause.pausedAt)}`;
}

function outcomeNotice(outcome: PauseOutcome): Html | "" {
  if (outcome.kind === "none") return "";
  const what = formatPauseScope(outcome.scope, outcome.target);
  switch (outcome.kind) {
    case "paused":
      return notice("ok", html`<p>Paused ${what}. Calls in scope now return “paused”.</p>`);
    case "resumed":
      return notice(
        "ok",
        html`<p>
          Resumed ${what} after your passkey check. Pending requests can be approved again unless
          they expired; nothing called during the pause is replayed.
        </p>`,
      );
    case "resume-refused":
      return notice(
        "error",
        html`<p><strong>${what} is still paused.</strong> The passkey check failed: ${outcome.reason}</p>`,
      );
    case "challenge-expired":
      return notice(
        "warn",
        html`<p>
          <strong>${what} is still paused.</strong> The passkey check took too long and expired.
          Try resume again.
        </p>`,
      );
  }
}

/**
 * Pause is one tap on a signed-in page; resume needs a fresh passkey
 * assertion. The asymmetry is deliberate: pausing can only stop calls.
 */
export function pauseControl(props: PauseControlProps): Html {
  const heading = html`<h1>Pause</h1>
    <p class="muted">
      A paused agent or account gets “paused” on every call and reaches no upstream, even for a
      call that was already approved. Nothing called during a pause is replayed after resume.
    </p>`;
  if (!props.load.ok) {
    return html`${heading}
      ${notice(
        "error",
        html`<p><strong>Pause state couldn't be loaded.</strong> ${props.load.message}</p>
          <p>Pausing still works: it only ever stops calls.</p>`,
      )}
      ${postForm(
        props.pauseForm,
        { scope: "global", target: "" },
        html`<button type="submit" class="${btn("danger")}">Pause everything</button>`,
      )}`;
  }
  const { active, agents, accounts, canPauseAll } = props.load;
  const global = activeFor(active, "global", null);
  const row = (scope: "agent" | "account", name: string): Html => {
    const own = activeFor(active, scope, name);
    if (own !== undefined)
      return pauseRow(
        html`<strong class="mono">${name}</strong>`,
        pausedBy(own),
        resumeSwitch(own, props.onResume),
      );
    if (global !== undefined)
      return pauseRow(
        html`<strong class="mono">${name}</strong>`,
        html`Paused with everything`,
        html`<span class="ui-switch" aria-disabled="true">${switchFace(false, "Paused")}</span>`,
      );
    return pauseRow(
      html`<strong class="mono">${name}</strong>`,
      "",
      pauseSwitch(props.pauseForm, scope, name),
    );
  };
  // Pauses this page has no row for (a provider, or a target that's gone): listed so they can be lifted.
  const listed = (p: ActivePause) =>
    p.scope === "global" ||
    (p.scope === "agent" && p.target !== null && agents.includes(p.target)) ||
    (p.scope === "account" && p.target !== null && accounts.includes(p.target));
  const others = active.filter((p) => !listed(p));
  const group = (title: string, rows: readonly Html[]): Html | "" =>
    rows.length === 0
      ? ""
      : html`<li class="pause-group-label" aria-hidden="true">${title}</li>${rows}`;
  return html`${heading} ${outcomeNotice(props.outcome)}
    <p class="muted pause-rule">${active.length === 0 ? "Nothing is paused. Every call goes through the rules as usual. " : ""}Pausing is instant. <span id="${RESUME_HELP_ID}">Resuming asks for your passkey.</span></p>
    ${
      canPauseAll || global !== undefined
        ? html`<div class="card pause-everything${global === undefined ? "" : " is-paused"}">
            <div class="pause-row-text">
              <strong>Everything</strong>
              <span class="muted">${global === undefined ? "Every agent and every account at once." : pausedBy(global)}</span>
            </div>
            ${
              global === undefined
                ? postForm(
                    props.pauseForm,
                    { scope: "global", target: "" },
                    html`<button type="submit" class="${btn("danger", "sm")}" aria-label="Pause everything">Pause everything</button>`,
                  )
                : resumeSwitch(global, props.onResume)
            }
          </div>`
        : ""
    }
    <ul class="pause-rows" aria-label="Agents and accounts">
      ${group(
        "Agents",
        agents.map((name) => row("agent", name)),
      )}
      ${group(
        "Accounts",
        accounts.map((name) => row("account", name)),
      )}
      ${group(
        "Other pauses",
        others.map((p) =>
          pauseRow(
            html`<strong>${formatPauseScope(p.scope, p.target)}</strong>`,
            pausedBy(p),
            resumeSwitch(p, props.onResume),
          ),
        ),
      )}
    </ul>
    ${
      agents.length === 0 && accounts.length === 0 && others.length === 0
        ? html`<p class="muted">No agents or accounts to pause yet.</p>`
        : ""
    }`;
}
