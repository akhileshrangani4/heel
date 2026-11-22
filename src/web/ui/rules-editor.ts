import type { RulesEdit, RulesFileView } from "../../proposals/edit.ts";
import { ceremonyButton } from "./ceremony.ts";
import { type Html, html } from "./html.ts";
import { badge, notice } from "./layout.ts";
import { diffLines } from "./proposals.ts";
import { hideInWords, ruleInWords } from "./rule-words.ts";

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

function problemsList(problems: readonly string[]): Html {
  return html`<ul class="problems">${problems.map((p) => html`<li class="mono">${p}</li>`)}</ul>`;
}

function previewPanel(preview: RulesPreview, current: RulesFileView): Html {
  if (preview.unchanged) {
    return html`<section class="card preview" aria-labelledby="preview-heading">
      <h2 id="preview-heading">Nothing would change</h2>
      <p>${preview.edit.kind === "decision" ? "That rule already decides that." : "That's what your rules file already says."}</p>
      <p><a class="btn btn-secondary" href="/rules">Back</a></p>
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
    <details>
      <summary>The exact change to the file</summary>
      ${diffLines(preview.diff, "The change to your rules file")}
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
            <a class="btn btn-secondary" href="/rules">Cancel</a>
          </div>`
          : html`<p><a class="btn btn-secondary" href="/rules">Back</a></p>`
    }
  </section>`;
}

function ruleRow(r: RulesFileView["rules"][number], csrf: string): Html {
  return html`<li class="card rule-row">
    <p class="rule-words">
      <strong>${ruleInWords(r.rule)}</strong>
    </p>
    <div class="rule-meta muted">
      ${r.name === null ? "" : html`<span class="mono">${r.name}</span> · `}${badge(DECISION_WORDS[r.decision] ?? r.decision, r.decision === "deny" ? "error" : r.decision === "ask" ? "warn" : "ok")}
    </div>
    <form method="get" action="/rules" class="rule-actions">
      <input type="hidden" name="op" value="decision" />
      <input type="hidden" name="index" value="${String(r.index)}" />
      <input type="hidden" name="csrf" value="${csrf}" />
      <label for="then-${String(r.index)}">Change it to</label>
      <select id="then-${String(r.index)}" name="then">
        ${["allow", "ask", "deny"].map(
          (d) =>
            html`<option value="${d}"${d === r.decision ? " selected" : ""}>${DECISION_WORDS[d] ?? d}</option>`,
        )}
      </select>
      <button type="submit" class="btn btn-secondary">Preview</button>
      <a class="btn btn-danger" href="/rules?op=remove-rule&amp;index=${String(r.index)}&amp;csrf=${encodeURIComponent(csrf)}">Remove…</a>
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
    return html`${heading}<p class="muted">heel can't edit rules files from here.</p>`;
  }
  const { view } = props.file;
  return html`${heading}
    <p class="muted">
      What heel does with each call your agents make, read from the top: the first rule that
      matches decides, and a call no rule matches is refused. Your file is
      <span class="mono">${props.file.display}</span>; every change is in the
      <a href="/rules/history">rule history</a>.
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
        ? html`<p class="muted">No rules yet: every call is refused. Agents can propose rules, and heel suggests some from what you approve.</p>`
        : html`<ol class="rule-list" aria-label="Your rules, in order">${view.rules.map((r) => ruleRow(r, props.csrfToken))}</ol>`
    }
    ${
      view.hide.length === 0
        ? ""
        : html`<h2>Hidden from agents</h2>
          <ul class="rule-list">
            ${view.hide.map(
              (h) => html`<li class="card rule-row">
                <p class="rule-words">${hideInWords(h.entry)}</p>
                <a class="btn btn-danger" href="/rules?op=remove-hide&amp;index=${String(h.index)}&amp;csrf=${encodeURIComponent(props.csrfToken)}">Remove…</a>
              </li>`,
            )}
          </ul>`
    }
    <details class="rules-yaml">
      <summary>Edit the file directly (YAML)</summary>
      <p class="muted">For anything the menus above don't do. heel checks it and shows what it means before you save. <a href="https://useheel.dev/docs/rules-reference" target="_blank" rel="noopener">Every key</a>.</p>
      <form method="post" action="/rules/check">
        <input type="hidden" name="csrf" value="${props.csrfToken}" />
        <textarea name="text" rows="18" class="mono" spellcheck="false">
${props.file.text}</textarea>
        <button type="submit" class="btn btn-secondary">Check it</button>
      </form>
    </details>`;
}
