import type { RuleChangeView } from "../../store/rule-changes.ts";
import { formatRelative, formatUtc } from "./format.ts";
import { type Html, html, trusted } from "./html.ts";
import { CHEVRON_DOWN } from "./icons.ts";
import { badge } from "./layout.ts";
import { diffLines } from "./proposals.ts";

/** Only the lines a change added or removed: unchanged lines would bury them. */
function changedOnly(diff: string): string {
  return diff
    .split("\n")
    .filter((line) => line.startsWith("+ ") || line.startsWith("- "))
    .join("\n");
}

function who(change: RuleChangeView): Html {
  if (change.source === "web") {
    return html`Changed by ${change.decidedBy ?? "someone no longer here"} in heel's rules page.`;
  }
  if (change.source === "outside") {
    return html`Changed outside heel: edited by hand, or by git or another program.`;
  }
  const by = change.decidedBy ?? "someone no longer here";
  const proposal =
    change.proposalId === null
      ? ""
      : html` (<a href="/proposals/${encodeURIComponent(change.proposalId)}">the proposal</a>)`;
  return change.origin === "heel"
    ? html`Added by ${by} from heel's suggestion for ${change.agent ?? "an agent"}${proposal}.`
    : html`Added by ${by} from what ${change.agent ?? "an agent"} proposed${proposal}.`;
}

/**
 * The rules files' history (roadmap 2.4): every change, newest first, with
 * who proposed and added it, or a note that it was made outside heel, and
 * the lines it changed.
 */
export function ruleHistoryPage(props: {
  changes: readonly RuleChangeView[];
  now: Date;
  /** Admins see everyone's files and the org file. */
  everyone: boolean;
}): Html {
  return html`<h1>Rule history</h1>
    <p class="muted">
      Every change to ${props.everyone ? "the rules files" : "your rules file"}, newest first:
      those added from a proposal, with who proposed and who added them, and those made outside
      heel, which heel notices when it reloads the file.
    </p>
    ${
      props.changes.length === 0
        ? html`<p class="muted">No changes yet.</p>`
        : html`<ol class="timeline" aria-label="Rules file changes">
          ${props.changes.map(
            (change) => html`<li class="timeline-item" data-source="${change.source}">
              <span class="timeline-dot" aria-hidden="true"></span>
              <div class="timeline-body">
                <p class="timeline-head">
                  ${badge(
                    change.source === "proposal"
                      ? "Proposal added"
                      : change.source === "web"
                        ? "Rules page"
                        : "Outside heel",
                    change.source === "outside" ? "warn" : change.source === "web" ? "info" : "ok",
                  )}
                  <span class="mono">${change.file}</span>
                  <time class="muted" datetime="${change.at.toISOString()}" title="${formatUtc(change.at)}">${formatRelative(change.at, props.now)}</time>
                </p>
                <p class="timeline-who">${who(change)}</p>
                <details class="fold">
                  <summary>What changed${trusted(CHEVRON_DOWN)}</summary>
                  ${diffLines(changedOnly(change.diff) || "  (only spacing or order changed)", "What changed")}
                </details>
              </div>
            </li>`,
          )}
        </ol>`
    }`;
}
