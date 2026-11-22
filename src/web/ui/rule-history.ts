import type { RuleChangeView } from "../../store/rule-changes.ts";
import { formatRelative } from "./format.ts";
import { type Html, html } from "./html.ts";
import { badge, time } from "./layout.ts";
import { diffLines } from "./proposals.ts";

/** Only the lines a change added or removed: unchanged lines would bury them. */
function changedOnly(diff: string): string {
  return diff
    .split("\n")
    .filter((line) => line.startsWith("+ ") || line.startsWith("- "))
    .join("\n");
}

function who(change: RuleChangeView): Html {
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
        : html`<ul class="req-list" aria-label="Rules file changes">
          ${props.changes.map(
            (change) => html`<li class="card req">
              <div class="ap-meta">
                ${badge(change.source === "proposal" ? "Proposal added" : "Outside heel", change.source === "proposal" ? "ok" : "warn")}
                <span class="mono">${change.file}</span>
                <span class="muted">${formatRelative(change.at, props.now)}</span>
              </div>
              <p>${who(change)}</p>
              <details>
                <summary>What changed</summary>
                ${diffLines(changedOnly(change.diff) || "  (only spacing or order changed)", "What changed")}
              </details>
              <p class="req-foot muted">${time(change.at)}</p>
            </li>`,
          )}
        </ul>`
    }`;
}
