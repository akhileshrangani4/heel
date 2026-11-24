import { flag, type Html, html, trusted } from "./html.ts";
import { btn } from "./shadcn/button.ts";

/**
 * One layout for every approval page: call approvals, connection requests
 * and rule changes. The answer comes first (one sentence of what is asked,
 * one line of why it matters), the decision sits in the side panel with one
 * action bar, and everything else folds away.
 *
 * - Wide screens: title and details on the left, a sticky side panel on the
 *   right with the status, the agent's words, the bar and the folds.
 * - Phones: title, side panel, details, in that order. With `dock: "pinned"`
 *   the bar is pinned to the bottom of the screen and takes the tab bar's
 *   place while a decision is open; with `"inline"` it stays in the panel.
 *
 * Presentation only: what the bar's buttons do is the caller's (I-56).
 */

export type Dock = "pinned" | "inline";

export interface ShellProps {
  kind: "call" | "connection" | "rules";
  /** The breadcrumb's last part: "Request", "Connection", "Rule change". */
  crumb: string;
  /** What is asked, or what happened once decided: the page's one h1. */
  title: Html;
  /** One line of why it matters, in heel's words. */
  why?: Html | string;
  /** The status badge and one short muted line beside it. */
  status: Html;
  /** The agent's words, notices, the decision and the folds. */
  side: Html;
  /** The details; omitted when there are none. */
  main?: Html | "";
  dock: Dock;
  /** Extra attributes on the article, e.g. the call page's remembered folds. */
  foldKind?: string;
}

const BACK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>`;

export function approvalShell(props: ShellProps): Html {
  const main = props.main ?? "";
  return html`<article
    class="ap"
    data-kind="${props.kind}"
    data-dock="${props.dock}"${props.foldKind === undefined ? "" : html` data-heel-fold-kind="${props.foldKind}"`}
  >
    <nav class="ap-crumbs" aria-label="Breadcrumb">
      <a href="/approvals">${trusted(BACK)}Approvals</a>
      <span class="muted" aria-hidden="true">/</span>
      <span aria-current="page">${props.crumb}</span>
    </nav>
    <div class="ap-layout">
      <header class="ap-head">
        <h1 class="ap-title">${props.title}</h1>
        ${props.why ? html`<p class="ap-why">${props.why}</p>` : ""}
      </header>
      <aside class="ap-side" aria-label="Decision">
        <p class="ap-status">${props.status}</p>
        ${props.side}
      </aside>
      ${main === "" ? "" : html`<div class="ap-main">${main}</div>`}
    </div>
  </article>`;
}

/**
 * The one action bar: no on the left, yes on the right, side by side at
 * every width. The yes button comes first in the page so it's read first;
 * CSS puts no on the left. `help` is read out with the buttons; `note`
 * shows it too, as one short line under the bar.
 */
export function actionBar(props: {
  yes: Html | "";
  no: Html | "";
  helpId: string;
  help: string;
  showHelp?: boolean;
  /** Pin it to the bottom of a phone screen when the page docks (false for a locked bar). */
  dock?: boolean;
}): Html {
  return html`<div class="ap-bar"${flag("data-dock", props.dock ?? true)}>
      ${props.yes === "" ? "" : html`<span class="ap-bar-yes">${props.yes}</span>`}
      ${props.no === "" ? "" : html`<span class="ap-bar-no">${props.no}</span>`}
    </div>
    <p id="${props.helpId}" class="${props.showHelp === true ? "ap-bar-note muted" : "visually-hidden"}">
      ${props.help}
    </p>`;
}

/**
 * A name, URL or id as a code chip that wraps anywhere (never cut: the
 * owner must see all of it to approve it), with a copy button when `copy`.
 */
export function codeChip(value: string, id: string, copy = true): Html {
  return html`<span class="ap-code"
    ><code id="${id}">${value}</code>${
      copy
        ? html`<button type="button" class="${btn("ghost", "xs", "ap-copy")}" data-heel-copy="${id}" aria-label="Copy ${value}">Copy</button>`
        : ""
    }</span
  >`;
}

/** A plain fold with a chevron, for the side panel's row of folds. */
export function sideFold(label: Html | string, content: Html, open = false): Html {
  return html`<details class="ap-more"${flag("open", open)}>
    <summary><span class="fold-label">${label}</span><span class="chev">${trusted(
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`,
    )}</span></summary>
    <div class="ap-fold-body">${content}</div>
  </details>`;
}
