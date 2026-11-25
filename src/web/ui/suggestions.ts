import type { LearnedRule } from "../../core/learning.ts";
import { ruleYaml } from "../../proposals/rules.ts";
import { type Html, html } from "./html.ts";
import { postForm } from "./layout.ts";
import { ruleInWords } from "./rule-words.ts";
import { btn } from "./shadcn/button.ts";

/**
 * Rules heel suggests from what you decided. Each one is read
 * on its own: what it would do, the decisions it rests on, and two buttons.
 * Reviewing opens it as a proposal, which you add with a passkey; nothing here
 * changes your rules.
 */
export function suggestionCards(
  suggestions: readonly LearnedRule[],
  csrfToken: string,
  /** Where Dismiss comes back to. */
  from: "approvals" | "activity",
): Html | "" {
  if (suggestions.length === 0) return "";
  return html`<section class="suggested" aria-label="Suggested rules">
    <h2 class="section-title">Suggested rules</h2>
    <ul class="req-list">
      ${suggestions.map(
        (s) => html`<li class="card req">
          <p class="rule-words"><strong>${ruleInWords(s.rule)}</strong></p>
          <p class="muted">You ${s.evidence}.</p>
          <details>
            <summary>As YAML</summary>
            <pre class="mono">${ruleYaml(s.rule)}</pre>
          </details>
          <div class="ap-actions">
            ${postForm(
              { action: `/suggestions/${encodeURIComponent(s.key)}/propose`, csrfToken },
              {},
              html`<button type="submit" class="${btn()}">Review and add</button>`,
            )}
            ${postForm(
              { action: `/suggestions/${encodeURIComponent(s.key)}/dismiss`, csrfToken },
              { from },
              html`<button type="submit" class="${btn("outline")}">Don't suggest this again</button>`,
            )}
          </div>
        </li>`,
      )}
    </ul>
  </section>`;
}
