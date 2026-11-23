import { lineDiff } from "../../../drafting/draft.ts";
import { applyEdit, rulesCheck, textHash, viewRules } from "../../../proposals/edit.ts";
import type { RulesPreview } from "../rules-editor.ts";

/**
 * Rules-editor fixtures for the preview, built with heel's real rules parser
 * from small YAML files, so what the preview shows is what /rules would.
 */

export const RULES_DISPLAY = "rules/alice.yaml";

export const RULES_TEXT = `rules:
  - name: reads
    match: { kind: read }
    then: allow
  - name: client-sends-ask
    match: { action: email.send }
    then: ask
  - name: no-deletes
    match: { action: email.remove }
    then: deny
hide:
  - email: { from: { any_domain_in: [family.example] } }
`;

/** Two mistakes: a misspelled match key and a decision heel doesn't know. */
export const BROKEN_RULES_TEXT = `rules:
  - name: reads
    match: { kind: read }
    then: allow
  - name: client-sends-ask
    match: { action: email.send, recipient: { all_domain_in: [vendor.com] } }
    then: ask
  - name: no-deletes
    match: { action: email.remove }
    then: maybe
`;

export const EMPTY_RULES_TEXT = "rules: []\n";

export function rulesFile(text: string) {
  return { display: RULES_DISPLAY, text, view: viewRules(text, RULES_DISPLAY) };
}

/** What /rules?op=decision&index=1&then=deny shows: client sends changed from ask to deny. */
export function decisionPreview(): RulesPreview {
  const edit = { kind: "decision", index: 1, decision: "deny" } as const;
  const after = applyEdit(RULES_TEXT, edit);
  if (!after.ok) throw new Error(after.problem);
  return {
    edit,
    text: after.text,
    before: textHash(RULES_TEXT),
    after: textHash(after.text),
    diff: lineDiff(RULES_TEXT, after.text),
    ...rulesCheck(after.text, RULES_DISPLAY),
    trusted: true,
    unchanged: false,
    view: viewRules(after.text, RULES_DISPLAY),
  };
}
