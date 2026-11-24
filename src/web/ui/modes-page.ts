import type { Mode } from "../../core/modes.ts";
import { ceremonyButton } from "./ceremony.ts";
import { type Html, html, trusted } from "./html.ts";
import { CHEVRON_DOWN } from "./icons.ts";
import { badge, type FormTarget, notice, postForm, scrollRegion } from "./layout.ts";

/**
 * The Modes page (A3): the org's default mode and each person's own, and
 * the controls to switch them. Tightening to `enforce` is a plain form, like
 * pausing; loosening needs a passkey, like resuming.
 *
 * People see two modes, Enforce and Watch. `shadow` and `record` are stored
 * values that both mean Watch (they behave the same; `record` only marked a
 * rollout that was still recording traffic), and `heel serve --watch` makes
 * Watch the default. One name, matching the docs and `watch: true` on a rule.
 */

export interface ModeRow {
  /** Empty for the org-wide default. */
  ownerId: string;
  label: string;
  /** Null when nothing is stored (the default applies). */
  mode: Mode | null;
  /** What actually applies: for a person, the stricter of the org default and their own row. */
  effective: Mode;
}

export type ModesOutcome =
  | { kind: "none" }
  | { kind: "switched"; ownerId: string; label: string; mode: Mode };

/** What a person sees for a stored mode: Enforce, or Watch for both `shadow` and `record`. */
export function modeLabel(mode: Mode): "Enforce" | "Watch" {
  return mode === "enforce" ? "Enforce" : "Watch";
}

const DESCRIPTION: Record<"Enforce" | "Watch", string> = {
  Enforce: "heel applies the rules: calls are allowed, sent for approval or denied.",
  Watch:
    "Calls your rules would deny or send for approval run anyway, and Activity shows what heel would have done.",
};

function tone(mode: Mode) {
  return mode === "enforce" ? "ok" : "warn";
}

/**
 * "Enforce | Watch": the mode that applies now is the pressed segment and does
 * nothing; the other is the switch itself. Tightening to Enforce is a plain
 * form, like pausing; loosening to Watch is a passkey ceremony, like resuming.
 */
function segmented(row: ModeRow, tighten: FormTarget, orgEffective: Mode): Html {
  const current = modeLabel(row.effective);
  const pressed = (label: "Enforce" | "Watch") =>
    html`<span class="seg-item" aria-current="true" aria-pressed="true">${label}</span>`;
  // A person's own Watch can't loosen an org default of Enforce, so offering it
  // would only store a setting that does nothing.
  if (current === "Enforce" && row.ownerId !== "" && orgEffective === "enforce") {
    return html`<span class="seg" aria-label="${row.label}'s mode">
        ${pressed("Enforce")}<span class="seg-item" aria-disabled="true">Watch</span>
      </span>
      <span class="muted seg-note">Follows the org default</span>`;
  }
  const other =
    current === "Enforce"
      ? ceremonyButton({
          callback: { handler: "mode" },
          intent: "mode",
          label: "Watch",
          tone: "secondary",
          binding: { owner: row.ownerId, mode: "shadow" },
          asSegment: { ariaLabel: `Switch ${row.label} to Watch` },
        })
      : postForm(
          tighten,
          { owner: row.ownerId },
          html`<button type="submit" class="seg-item"><span class="visually-hidden">Switch to </span>Enforce</button>`,
        );
  return html`<span class="seg" aria-label="${row.label}'s mode">${
    current === "Enforce" ? html`${pressed("Enforce")}${other}` : html`${other}${pressed("Watch")}`
  }</span>`;
}

function switchedNotice(
  outcome: Extract<ModesOutcome, { kind: "switched" }>,
  rows: readonly ModeRow[],
): Html {
  const row = rows.find((r) => r.ownerId === outcome.ownerId);
  const now = row?.effective ?? outcome.mode;
  if (modeLabel(now) === modeLabel(outcome.mode)) {
    return notice("ok", html`<p>${outcome.label} is now in ${modeLabel(now)} mode.</p>`);
  }
  return notice(
    "warn",
    html`<p>
      ${outcome.label}'s own mode is set to ${modeLabel(outcome.mode)}, but the org default is
      ${modeLabel(now)}, which is stricter, so ${outcome.label}'s calls stay in ${modeLabel(now)} mode.
    </p>`,
  );
}

export function modesPage(props: {
  rows: readonly ModeRow[];
  outcome: ModesOutcome;
  tighten: FormTarget;
  /** `heel serve --watch`: unset rows behave as Watch. */
  watchFallback: boolean;
}): Html {
  const org = props.rows.find((r) => r.ownerId === "");
  const orgEffective = org?.effective ?? "enforce";
  return html`<h1>Modes</h1>
    <p class="muted">Enforce applies your rules; Watch lets calls run and shows what heel would have done.</p>
    <details class="set-fold">
      <summary>How modes work${trusted(CHEVRON_DOWN)}</summary>
      <ul>
        <li><strong>Enforce</strong>: ${DESCRIPTION.Enforce}</li>
        <li>
          <strong>Watch</strong>: ${DESCRIPTION.Watch} Use it to try new rules on real traffic, then
          switch to Enforce.
        </li>
      </ul>
      <p class="muted">
        Some things hold in both modes: pause, org rules, hidden mail, and calls heel can't check
        safely are still stopped. A person's own mode can only be stricter than the org default.
        Switching to Watch needs your passkey.
      </p>
    </details>
    ${
      props.watchFallback
        ? notice(
            "info",
            html`<p>
              heel was started with <code>--watch</code>, so anyone without a mode of their own is in
              Watch mode. Switch the org default to Enforce here, or restart heel without
              <code>--watch</code>.
            </p>`,
          )
        : ""
    }
    ${props.outcome.kind === "switched" ? switchedNotice(props.outcome, props.rows) : ""}
    ${scrollRegion(
      "Modes",
      html`<table class="data modes-table">
      <caption class="visually-hidden">Modes</caption>
      <thead>
        <tr>
          <th scope="col">Who</th>
          <th scope="col">Mode</th>
          <th scope="col">What applies</th>
        </tr>
      </thead>
      <tbody>
        ${props.rows.map((row) => {
          const shown = modeLabel(row.effective);
          const note =
            row.mode === null
              ? row.ownerId === ""
                ? props.watchFallback
                  ? " (from --watch)"
                  : " (default)"
                : " (follows the org default)"
              : modeLabel(row.mode) !== shown
                ? ` (own setting ${modeLabel(row.mode)}; the org default is stricter)`
                : "";
          return html`<tr>
            <th scope="row">${row.label}</th>
            <td class="mode-switch">${segmented(row, props.tighten, orgEffective)}</td>
            <td>${badge(`${shown}${note}`, tone(row.effective))}<span class="muted mode-means">${DESCRIPTION[shown]}</span></td>
          </tr>`;
        })}
      </tbody>
    </table>`,
    )}`;
}
