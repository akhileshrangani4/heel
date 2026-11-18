import type { Mode } from "../../core/modes.ts";
import { ceremonyButton } from "./ceremony.ts";
import { type Html, html } from "./html.ts";
import { badge, type FormTarget, notice, postForm } from "./layout.ts";

/**
 * The Modes page (A3): the org's default mode and each person's own, and
 * the controls to switch them. Tightening to `enforce` is a plain form, like
 * pausing; loosening to `shadow` or `record` needs a passkey, like resuming.
 */

export interface ModeRow {
  /** Empty for the org-wide default. */
  ownerId: string;
  label: string;
  /** Null when nothing is stored (the default applies). */
  mode: Mode | null;
}

export type ModesOutcome = { kind: "none" } | { kind: "switched"; label: string; mode: Mode };

const DESCRIPTION: Record<Mode, string> = {
  enforce: "heel decides every call.",
  shadow:
    "Owner rules and the default deny are logged as would-deny or would-ask, then the call runs.",
  record: "Calls run without owner rules; heel only records them. Org rules still apply.",
};

function tone(mode: Mode | null) {
  return mode === null || mode === "enforce" ? "ok" : "warn";
}

function controls(row: ModeRow, tighten: FormTarget): Html {
  const current = row.mode ?? "enforce";
  const loosen = (mode: Mode) =>
    ceremonyButton({
      callback: { handler: "mode" },
      intent: "mode",
      label: `Switch to ${mode}`,
      tone: "secondary",
      binding: { owner: row.ownerId, mode },
    });
  return html`${
    current === "enforce"
      ? ""
      : postForm(
          tighten,
          { owner: row.ownerId },
          html`<button type="submit" class="btn btn-primary">Switch to enforce</button>`,
        )
  }
  ${current === "shadow" ? "" : loosen("shadow")} ${current === "record" ? "" : loosen("record")}`;
}

export function modesPage(props: {
  rows: readonly ModeRow[];
  outcome: ModesOutcome;
  tighten: FormTarget;
  /** `heel serve --watch`: unset rows behave as shadow. */
  watchFallback: boolean;
}): Html {
  const fallback: Mode = props.watchFallback ? "shadow" : "enforce";
  return html`<h1>Modes</h1>
    <p class="muted">
      When several apply, the strictest wins: enforce, then shadow, then record. Pause, org rules,
      hiding and fail-closed denies hold in every mode. Loosening a mode needs your passkey.
    </p>
    ${
      props.outcome.kind === "switched"
        ? notice("ok", html`<p>${props.outcome.label} is now in ${props.outcome.mode} mode.</p>`)
        : ""
    }
    <table class="data">
      <caption>Modes</caption>
      <thead>
        <tr>
          <th scope="col">Who</th>
          <th scope="col">Mode</th>
          <th scope="col">What it means</th>
          <th scope="col">Switch</th>
        </tr>
      </thead>
      <tbody>
        ${props.rows.map((row) => {
          const shown = row.mode ?? fallback;
          return html`<tr>
            <th scope="row">${row.label}</th>
            <td>${badge(row.mode === null ? `${shown} (default)` : shown, tone(shown))}</td>
            <td class="muted">${DESCRIPTION[shown]}</td>
            <td>${controls(row, props.tighten)}</td>
          </tr>`;
        })}
      </tbody>
    </table>`;
}
