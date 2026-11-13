import type { PauseScope } from "../../core/call.ts";
import { type CeremonyCallback, ceremonyButton } from "./ceremony.ts";
import { formatPauseScope } from "./format.ts";
import { type Html, html } from "./html.ts";
import { type FormTarget, notice, postForm, time } from "./layout.ts";

export interface ActivePause {
  scope: PauseScope;
  /** Agent name, account alias or provider; null for a global pause. */
  target: string | null;
  pausedBy: string;
  pausedAt: Date;
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
  /** Pausing posts a plain form: one tap, no passkey, because it can only stop calls (Q-N5). */
  pauseForm: FormTarget;
  /** Resuming starts the passkey ceremony (Q-N5). */
  onResume: CeremonyCallback;
}

/** A stable id fragment for one pause, used to tie each resume button to its help text. */
function pauseKey(pause: { scope: PauseScope; target: string | null }): string {
  const target = (pause.target ?? "all").replace(/[^A-Za-z0-9_-]/g, "_");
  return `${pause.scope}-${target}`;
}

function isActive(
  active: readonly ActivePause[],
  scope: PauseScope,
  target: string | null,
): boolean {
  return active.some((p) => p.scope === scope && (scope === "global" || p.target === target));
}

function pauseButton(
  form: FormTarget,
  scope: PauseScope,
  target: string | null,
  paused: boolean,
): Html {
  const what = formatPauseScope(scope, target);
  if (paused) return html`<span class="muted">Paused</span>`;
  return postForm(
    form,
    { scope, target: target ?? "" },
    html`<button type="submit" class="btn btn-danger">Pause ${what}</button>`,
  );
}

function activeList(active: readonly ActivePause[], onResume: CeremonyCallback): Html {
  if (active.length === 0) {
    return html`<p>Nothing is paused. Every call goes through the rules as usual.</p>`;
  }
  return html`<table class="data">
    <caption>
      Paused now
    </caption>
    <thead>
      <tr>
        <th scope="col">Scope</th>
        <th scope="col">Paused by</th>
        <th scope="col">Since</th>
        <th scope="col">Resume</th>
      </tr>
    </thead>
    <tbody>
      ${active.map((pause) => {
        const helpId = `resume-help-${pauseKey(pause)}`;
        return html`<tr>
          <th scope="row">${formatPauseScope(pause.scope, pause.target)}</th>
          <td>${pause.pausedBy}</td>
          <td>${time(pause.pausedAt)}</td>
          <td>
            ${ceremonyButton({
              callback: onResume,
              intent: "resume",
              label: `Resume ${formatPauseScope(pause.scope, pause.target)}`,
              tone: "secondary",
              binding: { scope: pause.scope, target: pause.target ?? "" },
              describedBy: helpId,
            })}
            <div class="muted" id="${helpId}">Passkey required to resume.</div>
          </td>
        </tr>`;
      })}
    </tbody>
  </table>`;
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
 * assertion (Q-N5). The asymmetry is deliberate: pausing can only stop calls.
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
        html`<button type="submit" class="btn btn-danger">Pause everything</button>`,
      )}`;
  }
  const { active, agents, accounts, canPauseAll } = props.load;
  const allPaused = isActive(active, "global", null);
  const rows = (scope: "agent" | "account", names: readonly string[]): Html[] =>
    names.map(
      (name) =>
        html`<tr>
          <th scope="row">${name}</th>
          <td>${scope}</td>
          <td>${pauseButton(props.pauseForm, scope, name, allPaused || isActive(active, scope, name))}</td>
        </tr>`,
    );
  return html`${heading} ${outcomeNotice(props.outcome)}
    <section aria-labelledby="pause-active">
      <h2 id="pause-active">Paused now</h2>
      ${activeList(active, props.onResume)}
    </section>
    <section aria-labelledby="pause-new">
      <h2 id="pause-new">Pause</h2>
      <p class="muted">One tap. No passkey is needed to stop calls.</p>
      ${canPauseAll ? html`<div class="actions">${pauseButton(props.pauseForm, "global", null, allPaused)}</div>` : ""}
      <table class="data">
        <caption>
          Agents and accounts
        </caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Kind</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          ${rows("agent", agents)} ${rows("account", accounts)}
        </tbody>
      </table>
    </section>`;
}
