import type { RulesEdit, RulesFileView } from "../../proposals/edit.ts";
import { ceremonyButton } from "./ceremony.ts";
import { type Html, html, trusted } from "./html.ts";
import { APPLY_ON_CHANGE, CHEVRON_DOWN } from "./icons.ts";
import { notice } from "./layout.ts";
import { diffLines } from "./proposals.ts";
import { hideInWords, ruleInWords } from "./rule-words.ts";
import { btn } from "./shadcn/button.ts";

/**
 * The Rules page (roadmap 2.9): your rules as sentences, in the order heel
 * reads them, with a menu to change what each decides and a button to remove
 * it. The YAML is there for whoever wants it, folded away. Nothing changes
 * until a preview has been read and a passkey taps Save.
 */

export interface RulesPreview {
  edit: RulesEdit;
  text: string;
  before: string;
  after: string;
  diff: string;
  problems: string[] | null;
  warnings: string[];
  view: RulesFileView;
  /** Opened from the person's own Rules page: only then is there a Save. */
  trusted: boolean;
  /** The change leaves the file exactly as it is. */
  unchanged: boolean;
}

const DECISION_WORDS: Record<string, string> = {
  allow: "lets it happen",
  ask: "asks you first",
  deny: "refuses it",
};

/** What a change does, in words: the rule as it will read, or the one going. */
function describe(edit: RulesEdit, before: RulesFileView, after: RulesFileView): string {
  switch (edit.kind) {
    case "decision": {
      const rule = after.rules[edit.index];
      return rule === undefined
        ? "This changes what one rule decides."
        : `This rule will read: ${ruleInWords(rule.rule)}`;
    }
    case "remove-rule": {
      const rule = before.rules[edit.index];
      return `This removes the rule "${rule === undefined ? "?" : ruleInWords(rule.rule)}". Calls it decided go on to the rules below it.`;
    }
    case "remove-hide": {
      const entry = before.hide[edit.index];
      return `This removes the hide entry "${entry === undefined ? "?" : hideInWords(entry.entry)}". Agents may see that email again.`;
    }
    case "replace":
      return "Your rules file as you edited it.";
  }
}

/** lucide's trash-2. */
const TRASH_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>`;

/** Lines kept around each change in the preview's diff. */
const CONTEXT = 2;

/**
 * Only the changed lines of a `lineDiff` ("+ ", "- ", "  " prefixed), with
 * CONTEXT unchanged lines around each change and a gap marker between far
 * apart changes, plus the added and removed counts.
 */
export function changedHunks(diff: string): { lines: string[]; added: number; removed: number } {
  const all = diff.replace(/\n$/, "").split("\n");
  const changed = all.map((line) => line.startsWith("+ ") || line.startsWith("- "));
  const keep = all.map((_, i) => {
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(all.length - 1, i + CONTEXT); j++) {
      if (changed[j]) return true;
    }
    return false;
  });
  const lines: string[] = [];
  let gap = false;
  all.forEach((line, i) => {
    if (keep[i]) {
      if (gap && lines.length > 0) lines.push("@ ⋯");
      gap = false;
      lines.push(line);
    } else gap = true;
  });
  return {
    lines,
    added: all.filter((l) => l.startsWith("+ ")).length,
    removed: all.filter((l) => l.startsWith("- ")).length,
  };
}

/** The changed lines, open, with their counts. */
function changeView(diff: string): Html {
  const hunks = changedHunks(diff);
  return html`<div class="rules-diff">
    <p class="rules-diff-head">
      <span>The change to your rules file</span>
      <span class="rules-diff-count"><span class="add">+${String(hunks.added)}</span> <span class="remove">−${String(hunks.removed)}</span></span>
    </p>
    <ul class="diff" aria-label="The change to your rules file">
      ${hunks.lines.map((line) => {
        const sign = line.slice(0, 1);
        if (sign === "@") return html`<li data-op="gap" aria-hidden="true">${line.slice(2)}</li>`;
        const op = sign === "+" ? "add" : sign === "-" ? "remove" : "same";
        const word = op === "add" ? "Added" : op === "remove" ? "Removed" : "";
        return html`<li data-op="${op}"><span class="sign" aria-hidden="true">${sign.trim()}</span>${word === "" ? "" : html`<span class="visually-hidden">${word}: </span>`}${line.slice(2)}</li>`;
      })}
    </ul>
  </div>`;
}

/** `file:line:col: message`, as `heel rules check` prints a problem, split for display. */
function splitProblem(problem: string): { where: string | null; what: string } {
  const match = /^(\S+?:\d+(?::\d+)?):\s+(.*)$/s.exec(problem);
  return match === null
    ? { where: null, what: problem }
    : { where: match[1] ?? null, what: match[2] ?? problem };
}

/** Each problem on its own line: where (file:line:col) in mono, then what. */
function problemsList(problems: readonly string[]): Html {
  return html`<ul class="problems">${problems.map((p) => {
    const { where, what } = splitProblem(p);
    return html`<li>${where === null ? "" : html`<span class="problem-where mono">${where}</span>`}<span class="problem-what">${what}</span></li>`;
  })}</ul>`;
}

/** lucide's file-lock. */
const FILE_LOCK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.8V20a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v1.5"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><rect width="8" height="5" x="2" y="13" rx="1"/><path d="M8 13v-2a2 2 0 1 0-4 0v2"/></svg>`;

function previewPanel(preview: RulesPreview, current: RulesFileView): Html {
  if (preview.unchanged) {
    return html`<section class="card preview" aria-labelledby="preview-heading">
      <h2 id="preview-heading">Nothing would change</h2>
      <p>${preview.edit.kind === "decision" ? "That rule already decides that." : "That's what your rules file already says."}</p>
      <p><a class="${btn("outline")}" href="/rules">Back</a></p>
    </section>`;
  }
  return html`<section class="card preview" aria-labelledby="preview-heading">
    <h2 id="preview-heading">Before you save</h2>
    <p>${describe(preview.edit, current, preview.view)}</p>
    ${
      preview.problems === null
        ? html`<p class="muted">Afterwards, your rules read like this:</p>
          <ol class="rule-sentences">
            ${preview.view.rules.map((r) => html`<li>${ruleInWords(r.rule)}</li>`)}
          </ol>`
        : notice(
            "error",
            html`<p><strong>This wouldn't load, so it can't be saved:</strong></p>${problemsList(preview.problems)}`,
          )
    }
    ${
      preview.problems === null && preview.warnings.length > 0
        ? notice(
            "warn",
            html`<p><strong>It would load, with a warning:</strong></p>${problemsList(preview.warnings)}`,
          )
        : ""
    }
    ${changeView(preview.diff)}
    <details class="fold">
      <summary>The whole file after the change${trusted(CHEVRON_DOWN)}</summary>
      ${diffLines(preview.diff, "Your rules file after the change")}
    </details>
    ${
      preview.problems === null && !preview.trusted
        ? notice(
            "warn",
            html`<p>This change came from a link, not from your Rules page, so it can't be saved from here. If you want it, make it from <a href="/rules">your rules</a>.</p>`,
          )
        : preview.problems === null
          ? html`<div id="rules-save" class="form">
            <textarea name="text" hidden>
${preview.text}</textarea>
            ${ceremonyButton({
              callback: { handler: "saveRules" },
              intent: "save-rules",
              label: "Save with your passkey",
              tone: "primary",
              binding: { before: preview.before, after: preview.after },
              optionsFrom: "rules-save",
            })}
            <a class="${btn("outline")}" href="/rules">Cancel</a>
          </div>`
          : html`<p><a class="${btn("outline")}" href="/rules">Back</a></p>`
    }
  </section>`;
}

function ruleRow(r: RulesFileView["rules"][number], csrf: string): Html {
  const n = String(r.index + 1);
  return html`<li class="rule-row">
    <span class="rule-n" aria-hidden="true">${n}</span>
    <div class="rule-text">
      <p class="rule-words">${ruleInWords(r.rule)}</p>
      ${r.name === null ? "" : html`<p class="rule-name mono">${r.name}</p>`}
    </div>
    <form method="get" action="/rules" class="rule-actions">
      <input type="hidden" name="op" value="decision" />
      <input type="hidden" name="index" value="${String(r.index)}" />
      <input type="hidden" name="csrf" value="${csrf}" />
      <label for="then-${String(r.index)}" class="visually-hidden">Change rule ${n} to</label>
      <select id="then-${String(r.index)}" name="then" onchange="${APPLY_ON_CHANGE}">
        ${["allow", "ask", "deny"].map(
          (d) =>
            html`<option value="${d}"${d === r.decision ? " selected" : ""}>${DECISION_WORDS[d] ?? d}</option>`,
        )}
      </select>
      <noscript><button type="submit" class="${btn("outline", "sm")}">Preview</button></noscript>
      <a class="${btn("ghost", "icon-sm", "rule-remove")}" href="/rules?op=remove-rule&amp;index=${String(r.index)}&amp;csrf=${encodeURIComponent(csrf)}" aria-label="Remove rule ${n}" title="Remove rule ${n}">${trusted(TRASH_ICON)}</a>
    </form>
  </li>`;
}

export function rulesEditorPage(props: {
  file: { display: string; text: string; view: RulesFileView } | null;
  preview: RulesPreview | null;
  problem: string | null;
  saved: "live" | "pending" | null;
  csrfToken: string;
}): Html {
  const heading = html`<h1>Rules</h1>`;
  if (props.file === null) {
    return html`${heading}
      <div class="req-empty">
        <span class="req-empty-icon rules-empty-icon">${trusted(FILE_LOCK_ICON)}</span>
        <p class="req-empty-title">heel can't edit rules files from here</p>
        <p class="muted">This heel reads its rules from files it doesn't manage. Change them where they live, and <code>heel rules check</code> on heel's machine says whether they load.</p>
      </div>`;
  }
  const { view } = props.file;
  return html`${heading}
    <p class="rules-lede">Read from the top: the first rule that matches decides; anything else is refused.</p>
    <p class="rules-file muted">
      <span class="mono">${props.file.display}</span> · <a href="/rules/history">Rule history</a>
    </p>
    ${props.saved === "live" ? notice("ok", html`<p>Saved. heel is using your rules now.</p>`) : ""}
    ${
      props.saved === "pending"
        ? notice(
            "warn",
            html`<p>Saved, but heel isn't using it yet: another rules file has a problem, so heel keeps the last set that loaded. <code>heel rules check</code> on heel's machine says which.</p>`,
          )
        : ""
    }
    ${props.problem === null ? "" : notice("error", html`<p>${props.problem}</p>`)}
    ${props.preview === null ? "" : previewPanel(props.preview, view)}
    ${
      view.problems === null
        ? notice("ok", html`<p>Your rules load, with no problems.</p>`)
        : notice(
            "error",
            html`<p><strong>Your rules file has problems.</strong> Until they're fixed, heel keeps using the last version that loaded.</p>${problemsList(view.problems)}`,
          )
    }
    <h2>Your rules</h2>
    ${
      view.rules.length === 0
        ? html`<div class="req-empty rules-empty">
            <p class="req-empty-title">No rules yet</p>
            <p class="muted">Every call is refused until a rule allows it. Agents can propose rules, and heel suggests some from what you approve.</p>
          </div>`
        : html`<ol class="rule-list" aria-label="Your rules, in order">${view.rules.map((r) => ruleRow(r, props.csrfToken))}</ol>`
    }
    ${
      view.hide.length === 0
        ? ""
        : html`<h2>Hidden from agents</h2>
          <ul class="rule-list">
            ${view.hide.map(
              (h, i) => html`<li class="rule-row">
                <span class="rule-n" aria-hidden="true">${String(i + 1)}</span>
                <div class="rule-text"><p class="rule-words">${hideInWords(h.entry)}</p></div>
                <div class="rule-actions">
                  <a class="${btn("ghost", "icon-sm", "rule-remove")}" href="/rules?op=remove-hide&amp;index=${String(h.index)}&amp;csrf=${encodeURIComponent(props.csrfToken)}" aria-label="Remove hide entry ${String(i + 1)}" title="Remove hide entry ${String(i + 1)}">${trusted(TRASH_ICON)}</a>
                </div>
              </li>`,
            )}
          </ul>`
    }
    <details class="rules-yaml fold">
      <summary>Edit the file directly (YAML)${trusted(CHEVRON_DOWN)}</summary>
      <p class="muted">For anything the menus above don't do. heel checks it and shows what it means before you save. <a href="https://useheel.dev/docs/rules-reference" target="_blank" rel="noopener">Every key</a>.</p>
      <form method="post" action="/rules/check">
        <input type="hidden" name="csrf" value="${props.csrfToken}" />
        <label for="rules-yaml-text" class="visually-hidden">Your rules file (YAML)</label>
        <textarea id="rules-yaml-text" name="text" rows="18" class="mono" spellcheck="false">
${props.file.text}</textarea>
        <button type="submit" class="${btn("outline")}">Check it</button>
      </form>
    </details>`;
}
