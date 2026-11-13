import type { RuleRef } from "../../core/call.ts";
import { formatRule, plural } from "./format.ts";
import { type Html, html } from "./html.ts";
import { badge, type FormTarget, notice, scrollRegion, type Tone, time } from "./layout.ts";

/** One YAML or schema error, located to the character (spec: Loading, testing and reload). */
export interface RuleFileError {
  file: string;
  line: number;
  column: number;
  message: string;
}

/**
 * Which rule set is deciding. `invalid-reload` keeps the last valid set;
 * `invalid-boot` means no valid set exists and every call is denied.
 */
export type RulesValidity =
  | { state: "valid"; loadedAt: Date }
  | { state: "invalid-reload"; errors: readonly RuleFileError[]; lastGoodAt: Date }
  | { state: "invalid-boot"; errors: readonly RuleFileError[] };

export type WouldDecision = "allow" | "deny" | "ask";

/** One "would have decided" audit record from watch mode (I-71, I-72). */
export interface WatchEntry {
  at: Date;
  agent: string;
  account: string;
  /** Action when the definition knows one, otherwise the raw tool. */
  what: string;
  /** Null when the default deny would have decided. */
  rule: RuleRef | null;
  would: WouldDecision;
  /** `rule`: a `watch: true` rule matched. `global`: `heel serve --watch`. */
  source: "rule" | "global";
}

export interface DiffLine {
  op: "add" | "remove" | "same";
  text: string;
}

export interface RuleTestResult {
  name: string;
  pass: boolean;
  expected: string;
  actual: string;
}

/**
 * The drafting box. `off` when no `drafting:` model is configured (I-17).
 * A draft is never saved automatically: `ready` offers a save that a person
 * must submit.
 */
export type DraftingState =
  | { state: "off" }
  | { state: "idle" }
  | { state: "ready"; prompt: string; diff: readonly DiffLine[]; tests: readonly RuleTestResult[] }
  | { state: "error"; prompt: string; message: string };

export interface RulesPageProps {
  /** The rules file this person edits, e.g. `rules/alice.yaml`. */
  file: string;
  load:
    | {
        ok: true;
        validity: RulesValidity;
        watch: readonly WatchEntry[];
        drafting: DraftingState;
      }
    | { ok: false; message: string };
  draftForm: FormTarget;
  saveForm: FormTarget;
}

const WOULD_TONE: Record<WouldDecision, Tone> = { allow: "ok", deny: "error", ask: "warn" };

function errorTable(errors: readonly RuleFileError[]): Html {
  return scrollRegion(
    "Rule file errors",
    html`<table class="data">
    <caption>
      ${plural(errors.length, "error")}
    </caption>
    <thead>
      <tr>
        <th scope="col">Where</th>
        <th scope="col">Problem</th>
      </tr>
    </thead>
    <tbody>
      ${errors.map(
        (e) =>
          html`<tr>
            <th scope="row" class="mono">${e.file}:${e.line}:${e.column}</th>
            <td>${e.message}</td>
          </tr>`,
      )}
    </tbody>
  </table>`,
  );
}

function validityPanel(validity: RulesValidity): Html {
  switch (validity.state) {
    case "valid":
      return notice("ok", html`<p>Rules are valid. Loaded ${time(validity.loadedAt)}.</p>`);
    case "invalid-reload":
      return notice(
        "warn",
        html`<p>
            <strong>The last edit didn't load.</strong> The rules loaded ${time(validity.lastGoodAt)}
            keep deciding until the file is fixed.
          </p>
          ${errorTable(validity.errors)}`,
      );
    case "invalid-boot":
      return notice(
        "error",
        html`<p>
            <strong>No valid rules are loaded, so every call is denied.</strong> Fix the file;
            pausing still works meanwhile.
          </p>
          ${errorTable(validity.errors)}`,
      );
  }
}

function watchTable(entries: readonly WatchEntry[]): Html {
  if (entries.length === 0) {
    return html`<p>
      No watch records yet. Add <code>watch: true</code> to a rule, or run
      <code>heel serve --watch</code>, to see what it would decide without enforcing it.
    </p>`;
  }
  return scrollRegion(
    "Watch log",
    html`<table class="data">
    <caption>
      ${plural(entries.length, "record")}, newest first
    </caption>
    <thead>
      <tr>
        <th scope="col">When</th>
        <th scope="col">Agent</th>
        <th scope="col">Account</th>
        <th scope="col">Call</th>
        <th scope="col">Rule</th>
        <th scope="col">Would</th>
      </tr>
    </thead>
    <tbody>
      ${entries.map(
        (e) =>
          html`<tr>
            <td>${time(e.at)}</td>
            <td>${e.agent}</td>
            <td>${e.account}</td>
            <td class="mono">${e.what}</td>
            <td>${e.rule ? formatRule(e.rule) : html`<span class="muted">default deny</span>`}</td>
            <td>
              ${badge(`would ${e.would}`, WOULD_TONE[e.would])}
              <div class="muted">${e.source === "rule" ? "watch rule" : "global watch"}</div>
            </td>
          </tr>`,
      )}
    </tbody>
  </table>`,
  );
}

function diffView(lines: readonly DiffLine[]): Html {
  const sign = { add: "+", remove: "−", same: " " } as const;
  const word = { add: "added", remove: "removed", same: "unchanged" } as const;
  return html`<ol class="diff" aria-label="Proposed change">
    ${lines.map(
      // No whitespace inside <li>: diff lines are white-space:pre-wrap, so
      // template indentation would render as blank space around each line.
      (line) =>
        html`<li data-op="${line.op}"><span class="sign" aria-hidden="true">${sign[line.op]}</span><span class="visually-hidden">${word[line.op]}: </span>${line.text}</li>`,
    )}
  </ol>`;
}

function testResults(tests: readonly RuleTestResult[]): Html {
  const failed = tests.filter((t) => !t.pass).length;
  const summary =
    failed === 0
      ? notice("ok", html`<p>All ${plural(tests.length, "case")} pass (exit 0).</p>`)
      : notice("error", html`<p>${failed} of ${plural(tests.length, "case")} fail (exit 1).</p>`);
  return html`${summary}
    ${scrollRegion(
      "Draft test results",
      html`<table class="data">
      <caption>
        <code>heel rules test</code> on the draft
      </caption>
      <thead>
        <tr>
          <th scope="col">Case</th>
          <th scope="col">Expected</th>
          <th scope="col">Got</th>
          <th scope="col">Result</th>
        </tr>
      </thead>
      <tbody>
        ${tests.map(
          (t) =>
            html`<tr>
              <th scope="row">${t.name}</th>
              <td class="mono">${t.expected}</td>
              <td class="mono">${t.actual}</td>
              <td>${t.pass ? badge("Pass", "ok") : badge("Fail", "error")}</td>
            </tr>`,
        )}
      </tbody>
    </table>`,
    )}`;
}

function draftingBox(drafting: DraftingState, props: RulesPageProps): Html {
  if (drafting.state === "off") {
    return html`<p class="muted">
      Drafting is off: no <code>drafting:</code> model is configured. Rules still work as written.
    </p>`;
  }
  const prompt = drafting.state === "idle" ? "" : drafting.prompt;
  const form = html`<form method="post" action="${props.draftForm.action}">
    <input type="hidden" name="csrf" value="${props.draftForm.csrfToken}" />
    <label for="draft-prompt">Describe a rule in words</label>
    <p class="muted" id="draft-prompt-help">
      The model sees only this text, the rules schema and your account and action names. Never
      call data, messages or audit rows.
    </p>
    <textarea id="draft-prompt" name="prompt" aria-describedby="draft-prompt-help">${prompt}</textarea>
    <div class="actions">
      <button type="submit" class="btn btn-secondary">Draft</button>
    </div>
  </form>`;
  if (drafting.state === "idle") return form;
  if (drafting.state === "error") {
    return html`${form}
      ${notice(
        "error",
        html`<p>
          <strong>The drafting model couldn't be reached.</strong> ${drafting.message} Nothing
          changed; drafting is never on the decision path.
        </p>`,
      )}`;
  }
  const failing = drafting.tests.some((t) => !t.pass);
  return html`${form}
    <h3>Draft</h3>
    ${diffView(drafting.diff)}
    <h3>Test results</h3>
    ${testResults(drafting.tests)}
    <form method="post" action="${props.saveForm.action}">
      <input type="hidden" name="csrf" value="${props.saveForm.csrfToken}" />
      <p class="muted">Nothing is saved until you save it.</p>
      <div class="actions">
        <button type="submit" class="btn btn-primary"${failing ? html` aria-describedby="draft-failing"` : ""}>
          Save to ${props.file}
        </button>
        ${failing ? html`<span id="draft-failing">Some cases fail; saving keeps them failing.</span>` : ""}
      </div>
    </form>`;
}

/** The rules page shell: validation, watch log and drafting (spec: Rules language, Teams). */
export function rulesPage(props: RulesPageProps): Html {
  const heading = html`<h1>Rules</h1>
    <p class="muted mono">${props.file}</p>`;
  if (!props.load.ok) {
    return html`${heading}
      ${notice(
        "error",
        html`<p><strong>Rules state couldn't be loaded.</strong> ${props.load.message}</p>
          <p><code>heel rules check</code> on the heel host reports the same validation.</p>`,
      )}`;
  }
  return html`${heading}
    <section aria-labelledby="rules-validation">
      <h2 id="rules-validation">Validation</h2>
      ${validityPanel(props.load.validity)}
    </section>
    <section aria-labelledby="rules-watch">
      <h2 id="rules-watch">Watch log</h2>
      ${watchTable(props.load.watch)}
    </section>
    <section aria-labelledby="rules-draft">
      <h2 id="rules-draft">Draft a rule</h2>
      ${draftingBox(props.load.drafting, props)}
    </section>`;
}
