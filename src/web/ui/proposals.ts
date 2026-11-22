import { describeProposal } from "../../proposals/describe.ts";
import type { RuleProposalStatus } from "../../store/schema.ts";
import { ceremonyButton } from "./ceremony.ts";
import { formatRelative } from "./format.ts";
import { type Html, html } from "./html.ts";
import { badge, type FormTarget, notice, postForm, type Tone, time } from "./layout.ts";

/** One pending proposal, as the Approvals list shows it. */
export interface ProposalCard {
  id: string;
  agent: string;
  rules: number;
  hide: number;
  workdirs: number;
  reason: string | null;
  createdAt: Date;
  expiresAt: Date;
}

const STATUS: Record<RuleProposalStatus, { label: string; tone: Tone | "muted" }> = {
  pending: { label: "Rule change", tone: "warn" },
  applied: { label: "Added", tone: "ok" },
  rejected: { label: "Rejected", tone: "muted" },
  superseded: { label: "Replaced", tone: "muted" },
  expired: { label: "Expired", tone: "muted" },
};

function count(n: number): string {
  return n === 1 ? "1 rule" : `${n} rules`;
}

/** Rule changes waiting for this person, above their approval requests. */
export function proposalCards(cards: readonly ProposalCard[], now: Date): Html | "" {
  if (cards.length === 0) return "";
  return html`<h2 class="section-title">Rule changes</h2>
    <ul class="req-list" aria-label="Proposed rule changes">
      ${cards.map(
        (card) => html`<li class="card req" data-status="pending">
          <div class="ap-meta">
            ${badge(STATUS.pending.label, STATUS.pending.tone)}
            <span class="ap-agent">${card.agent}</span>
            <span class="muted">${formatRelative(card.createdAt, now)}</span>
          </div>
          <h2 class="req-title">
            <a href="/proposals/${encodeURIComponent(card.id)}"
              >${card.agent} proposes <mark>${describeProposal(card.rules, card.hide, card.workdirs)}</mark>${
                card.rules + card.hide > 0 ? " for your rules file" : " for its heel run"
              }</a
            >
          </h2>
          ${
            card.reason === null
              ? ""
              : html`<p class="req-reason"><span class="muted">${card.agent} says:</span> ${card.reason}</p>`
          }
          <p class="req-foot muted">
            Expires ${formatRelative(card.expiresAt, now)} ·
            <span class="mono">${card.id}</span> · proposed ${time(card.createdAt)}
          </p>
        </li>`,
      )}
    </ul>`;
}

export interface ProposalPageProps {
  id: string;
  agent: string;
  status: RuleProposalStatus;
  reason: string | null;
  /** The file the rules go into, relative to heel's home: `rules/alice.yaml`. */
  file: string;
  rules: readonly { yaml: string; why: string | null }[];
  /** Hide entries, added to the end of the file's `hide:` list. */
  hide: readonly { yaml: string; why: string | null }[];
  /** Directories the agent asks its own `heel run` to work in. */
  workdirs: readonly { path: string; why: string | null }[];
  createdAt: Date;
  expiresAt: Date;
  decision: { by: string; at: Date } | null;
  now: Date;
  /** What adding them would do to the file now, or why it can't be done. */
  effect:
    | {
        ok: true;
        /** Hash of the file shown: adding signs this, so a later edit can't slip in. */
        sha: string;
        existing: number;
        existingNames: readonly string[];
        diff: string;
      }
    | { ok: false; problem: string };
  reject: FormTarget;
  /** `applied` or `rejected` just now, for the notice at the top. */
  outcome: "applied" | "rejected" | null;
}

/** `lineDiff`'s output ("+ line", "- line", "  line") in the rules page's diff style. */
function diffLines(diff: string): Html {
  const lines = diff.replace(/\n$/, "").split("\n");
  return html`<ul class="diff" aria-label="The file after the change">
    ${lines.map((line) => {
      const sign = line.slice(0, 1);
      const op = sign === "+" ? "add" : sign === "-" ? "remove" : "same";
      return html`<li data-op="${op}"><span class="sign" aria-hidden="true">${sign.trim()}</span>${line.slice(2)}</li>`;
    })}
  </ul>`;
}

function effectView(props: ProposalPageProps): Html {
  const { effect } = props;
  if (!effect.ok) {
    return notice(
      "error",
      html`<p><strong>This can't be added as it is.</strong></p>
      <p>${effect.problem}</p>`,
    );
  }
  const hiding =
    props.hide.length === 0
      ? ""
      : html`<p>
          The hide ${props.hide.length === 1 ? "entry goes" : "entries go"} at the end of
          ${props.file}'s hide list. Hiding only takes email away from your agents: matching
          messages drop out of what they read, and fetching, replying to or deleting one is
          denied.
        </p>`;
  const before =
    props.rules.length === 0
      ? ""
      : effect.existing === 0
        ? html`<p>${props.file} has no rules yet, so these become its first.</p>`
        : html`<p>
          They go <strong>first</strong> in ${props.file}, before your ${count(effect.existing)}${
            effect.existingNames.length > 0 ? html` (${effect.existingNames.join(", ")})` : ""
          }. The first rule that matches decides, so a call these match is decided by them, even
          one your own rules would have asked about or denied.
        </p>`;
  const workdirs =
    props.workdirs.length === 0
      ? ""
      : html`<p>
          Commands ${props.agent} runs with heel run may then start in, and change files in,
          ${props.workdirs.length === 1 ? "this folder" : "these folders"}, using only the accounts
          your rules allow. Its other workdirs stay as they are.
        </p>`;
  const changesFile = props.rules.length + props.hide.length > 0;
  return html`${before}${hiding}${workdirs}
    ${
      changesFile
        ? html`<details>
            <summary>The file after the change</summary>
            ${diffLines(effect.diff)}
          </details>`
        : ""
    }`;
}

/** Pure: the add button's words, for what this proposal holds. */
function addLabel(props: ProposalPageProps): string {
  const kinds = [props.rules.length, props.hide.length, props.workdirs.length].filter((n) => n > 0);
  if (kinds.length > 1) return "Add these changes";
  if (props.rules.length > 0) return "Add these rules";
  if (props.hide.length > 0) return "Add to the hide list";
  return props.workdirs.length === 1 ? "Add this workdir" : "Add these workdirs";
}

/** One proposal: what the agent asks for, what it would change, and the controls. */
export function proposalPage(props: ProposalPageProps): Html {
  const status = STATUS[props.status];
  const changesFile = props.rules.length + props.hide.length > 0;
  const outcome =
    props.outcome === "applied"
      ? notice(
          "ok",
          changesFile
            ? html`<p>Added to ${props.file}. heel is using them now.</p>`
            : html`<p>Added. ${props.agent}'s heel run can work there now.</p>`,
        )
      : props.outcome === "rejected"
        ? notice("info", html`<p>Rejected. Nothing ${props.agent} proposed was added.</p>`)
        : "";
  const pending = props.status === "pending" && props.expiresAt > props.now;
  return html`${outcome}
    <header class="card ap-head">
      <div class="ap-meta">
        <span class="ap-agent">${props.agent}</span>
        <span class="muted">${formatRelative(props.createdAt, props.now)}</span>
        ${badge(status.label, status.tone)}
      </div>
      <h1 class="ap-title">
        ${props.agent} proposes
        ${describeProposal(props.rules.length, props.hide.length, props.workdirs.length)}
        ${changesFile ? html`for ${props.file}` : "for its heel run"}
      </h1>
      ${
        props.reason === null
          ? ""
          : html`<figure class="reason">
              <figcaption>${props.agent} says (its own words; heel didn't check them)</figcaption>
              <blockquote>${props.reason}</blockquote>
            </figure>`
      }
    </header>
    ${
      props.rules.length === 0
        ? ""
        : html`<ul class="req-list" aria-label="Proposed rules">
      ${props.rules.map(
        (rule) => html`<li class="card">
          ${
            rule.why === null
              ? ""
              : html`<p><span class="muted">${props.agent}: </span>${rule.why}</p>`
          }
          <pre class="mono">${rule.yaml}</pre>
        </li>`,
      )}
    </ul>`
    }
    ${
      props.hide.length === 0
        ? ""
        : html`<h2 class="section-title">Hide from agents</h2>
          <ul class="req-list" aria-label="Proposed hide entries">
            ${props.hide.map(
              (entry) => html`<li class="card">
                ${
                  entry.why === null
                    ? ""
                    : html`<p><span class="muted">${props.agent}: </span>${entry.why}</p>`
                }
                <pre class="mono">${entry.yaml}</pre>
              </li>`,
            )}
          </ul>`
    }
    ${
      props.workdirs.length === 0
        ? ""
        : html`<h2 class="section-title">Workdirs for heel run</h2>
          <ul class="req-list" aria-label="Proposed workdirs">
            ${props.workdirs.map(
              (dir) => html`<li class="card">
                <p>${props.agent} may run commands with heel run in <code>${dir.path}</code></p>
                ${
                  dir.why === null
                    ? ""
                    : html`<p><span class="muted">${props.agent}: </span>${dir.why}</p>`
                }
              </li>`,
            )}
          </ul>`
    }
    ${pending ? effectView(props) : ""}
    ${
      props.decision === null
        ? ""
        : html`<p class="muted">
            ${status.label} by ${props.decision.by} ${time(props.decision.at)}
          </p>`
    }
    ${
      pending
        ? html`<div class="decide">
            ${
              props.effect.ok
                ? ceremonyButton({
                    callback: { handler: "applyRules" },
                    intent: "apply-rules",
                    label: addLabel(props),
                    tone: "primary",
                    binding: { proposalId: props.id, sha: props.effect.sha },
                    describedBy: "proposal-passkey",
                  })
                : ""
            }
            ${postForm(props.reject, {}, html`<button type="submit" class="btn btn-secondary">Reject</button>`)}
            <p id="proposal-passkey" class="muted">
              Adding them asks for your passkey. Nothing changes until you add them; rejecting
              changes nothing. Proposals expire ${formatRelative(props.expiresAt, props.now)}.
            </p>
          </div>`
        : ""
    }`;
}
