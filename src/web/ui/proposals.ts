import { describeProposal } from "../../proposals/describe.ts";
import type { RuleProposalStatus } from "../../store/schema.ts";
import {
  actionBar,
  agentLine,
  approvalShell,
  codeChip,
  type Dock,
  pageFold,
  quote,
  shorten,
  technical,
} from "./approval-shell.ts";
import { ceremonyButton } from "./ceremony.ts";
import { formatRelative } from "./format.ts";
import { type Html, html, trusted } from "./html.ts";
import { CHEVRON_RIGHT } from "./icons.ts";
import { type FormTarget, notice, postForm, time } from "./layout.ts";
import { soonFoot } from "./requests.ts";
import { btn } from "./shadcn/button.ts";

/** One pending proposal, as the Approvals list shows it. */
export interface ProposalCard {
  id: string;
  agent: string;
  rules: number;
  hide: number;
  workdirs: number;
  reason: string | null;
  /** `heel` when heel drafted it from your own decisions (2.10), not the agent. */
  origin: "agent" | "heel";
  createdAt: Date;
  expiresAt: Date;
}

function count(n: number): string {
  return n === 1 ? "1 rule" : `${n} rules`;
}

/** lucide's scroll-text: a rules file. */
const RULES_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 12h-5"/><path d="M15 8h-5"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/></svg>`;

/**
 * Rule changes waiting for this person, on the Approvals page. Like a
 * connection request, the whole row opens it (`.req-card`).
 */
export function proposalCards(cards: readonly ProposalCard[], now: Date): Html | "" {
  if (cards.length === 0) return "";
  return html`<section class="req-section" aria-labelledby="req-rule-changes">
    <h2 id="req-rule-changes" class="req-section-title">
      Rule changes <span class="req-section-count">${String(cards.length)}</span>
    </h2>
    <ul class="req-group" aria-label="Proposed rule changes">
      ${cards.map(
        (card) => html`<li class="req req-card" data-status="pending">
          <span class="req-icon req-icon-rules">${trusted(RULES_ICON)}</span>
          <span class="req-body">
            <span class="ap-meta"><span class="muted">${formatRelative(card.createdAt, now)}</span></span>
            <a class="req-title req-link" href="/proposals/${encodeURIComponent(card.id)}"
              >${
                card.origin === "heel"
                  ? html`heel suggests <mark>${describeProposal(card.rules, card.hide, card.workdirs)}</mark> for ${shorten(card.agent, 12, 8)}, from your decisions`
                  : html`${shorten(card.agent, 12, 8)} wants to add <mark>${describeProposal(card.rules, card.hide, card.workdirs)}</mark>${
                      card.rules + card.hide > 0 ? " to your rules" : " for its heel run"
                    }`
              }</a
            >
            ${
              card.reason === null || card.origin === "heel"
                ? ""
                : html`<span class="req-reason">${agentLine(card.reason)}</span>`
            }
            ${soonFoot(card.expiresAt, now)}
          </span>
          <span class="req-go" aria-hidden="true">${trusted(CHEVRON_RIGHT)}</span>
        </li>`,
      )}
    </ul>
  </section>`;
}

export interface ProposalPageProps {
  id: string;
  agent: string;
  status: RuleProposalStatus;
  reason: string | null;
  /** `heel` when heel drafted it from the owner's decisions (2.10): `agent` didn't ask. */
  origin: "agent" | "heel";
  /** The file the rules go into, relative to heel's home: `rules/alice.yaml`. */
  file: string;
  /** Each rule as heel will write it, and in plain words (roadmap 2.3). */
  rules: readonly { yaml: string; words: string; why: string | null }[];
  /** Hide entries, added to the end of the file's `hide:` list. */
  hide: readonly { yaml: string; words: string; why: string | null }[];
  /**
   * Directories the agent asks its own `heel run` to work in: `path` as the
   * agent wrote it, `stored` as heel would store it (symlinks followed), or
   * null when it can't be added.
   */
  workdirs: readonly { path: string; stored: string | null; why: string | null }[];
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
        /** For heel's suggestions: the rule it goes right before, and how many rules stay above it. */
        placedBefore?: { rule: string; above: number } | null;
        diff: string;
      }
    | { ok: false; problem: string };
  reject: FormTarget;
  /** `applied` or `rejected` just now, for the notice at the top. */
  outcome: "applied" | "rejected" | null;
  /** Phones: pin the action bar to the bottom, or keep it in the panel. */
  dock?: Dock;
}

/** `lineDiff`'s output ("+ line", "- line", "  line") in the rules page's diff style. */
export function diffLines(diff: string, label = "The file after the change"): Html {
  const lines = diff.replace(/\n$/, "").split("\n");
  return html`<ul class="diff" aria-label="${label}">
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
  const placed = effect.placedBefore ?? null;
  const before =
    props.rules.length === 0
      ? ""
      : placed !== null
        ? html`<p>
          It goes right before <strong>${placed.rule}</strong>, the rule that asked about these
          requests, and keeps that rule's conditions, so it only decides requests that rule would
          have asked you about. ${
            placed.above === 0
              ? "No rule comes before it."
              : `Your ${count(placed.above)} above it still decide first.`
          }
        </p>`
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
  // The diff is shown once, by the caller, in Details › Technical.
  return html`${before}${hiding}${workdirs}`;
}

/** Pure: the add button's words, for what this proposal holds. */
function addLabel(props: ProposalPageProps): string {
  const kinds = [props.rules.length, props.hide.length, props.workdirs.length].filter((n) => n > 0);
  if (kinds.length > 1) return "Add these changes";
  if (props.rules.length > 0) return "Add these rules";
  if (props.hide.length > 0) return "Add to the hide list";
  return props.workdirs.length === 1 ? "Add this workdir" : "Add these workdirs";
}

function title(props: ProposalPageProps): Html {
  const what = describeProposal(props.rules.length, props.hide.length, props.workdirs.length);
  const agent = shorten(props.agent, 12, 8);
  switch (props.status) {
    case "applied":
      return html`Added ${what}`;
    case "rejected":
      return html`Rejected`;
    case "expired":
      return html`Expired`;
    case "superseded":
      return html`Replaced by a newer proposal`;
    case "pending":
      return props.origin === "heel"
        ? html`heel suggests <mark>${what}</mark>`
        : html`${agent} wants to add <mark>${what}</mark>`;
  }
}

/** Pure: one plain line of where the rules go, for Details. */
function placement(props: ProposalPageProps): string | null {
  const { effect } = props;
  if (!effect.ok || props.rules.length === 0) return null;
  const placed = effect.placedBefore ?? null;
  if (placed !== null) return `Right before ${placed.rule}.`;
  return effect.existing === 0
    ? "They're the first rules in the file."
    : `First, before your ${count(effect.existing)}.`;
}

/** The one line of why above the fold: the agent's reason, or its only entry's reason. */
function said(props: ProposalPageProps): string | null {
  if (props.origin === "heel") return null;
  if (props.reason !== null) return props.reason;
  const all = [...props.rules, ...props.hide, ...props.workdirs];
  return all.length === 1 ? (all[0]?.why ?? null) : null;
}

/**
 * Details: at most four plain rows (where they go, the agent's full words,
 * its full name when the title cut it), then Technical: the file, the YAML,
 * the diff, ids and times.
 */
function proposalDetails(props: ProposalPageProps): Html {
  const place = placement(props);
  const words = said(props);
  const pending = props.status === "pending" && props.expiresAt > props.now;
  const changesFile = props.rules.length + props.hide.length > 0;
  const effect = props.effect;
  const reasons = [...props.rules, ...props.hide, ...props.workdirs].filter(
    (r) => r.why !== null && r.why !== words,
  );
  return pageFold(
    "Details",
    html`<dl class="facts ap-facts-list">
        ${place === null ? "" : html`<dt>Goes</dt><dd>${place}</dd>`}
        ${words !== null && agentLine(words) !== words ? html`<dt>Why</dt><dd>${words}</dd>` : ""}
        ${
          shorten(props.agent, 12, 8) === props.agent
            ? ""
            : html`<dt>Agent</dt><dd>${codeChip(props.agent, `agent-${props.id}`)}</dd>`
        }
        ${
          props.origin === "heel"
            ? html`<dt>From</dt><dd>heel drafted this from requests you decided.</dd>`
            : ""
        }
      </dl>
      ${technical(html`<dl class="facts ap-facts-list">
          <dt>File</dt>
          <dd>${codeChip(props.file, `file-${props.id}`)}</dd>
          <dt>Proposal</dt>
          <dd>${codeChip(props.id, `id-${props.id}`)}</dd>
          <dt>Asked</dt>
          <dd>${time(props.createdAt)}</dd>
          ${
            props.decision === null
              ? html`<dt>Expires</dt><dd>${time(props.expiresAt)}</dd>`
              : html`<dt>Decided</dt><dd>By ${props.decision.by}, ${time(props.decision.at)}</dd>`
          }
        </dl>
        ${reasons.map((r) => html`<p><span class="muted">${props.agent} says: </span>${r.why}</p>`)}
        ${[...props.rules, ...props.hide].map((r) => html`<pre class="mono">${r.yaml}</pre>`)}
        ${pending ? effectView(props) : ""}
        ${pending && effect.ok && changesFile ? diffLines(effect.diff) : ""}`)}`,
  );
}

/** The content: each rule and hide entry in words, and each workdir. */
function changesView(props: ProposalPageProps): Html {
  const items = [...props.rules, ...props.hide];
  const words =
    items.length === 0
      ? ""
      : html`<ul class="ap-items" aria-label="Proposed rules">
          ${items.map((r) => html`<li><p class="rule-words">${r.words}</p></li>`)}
        </ul>`;
  const workdirs =
    props.workdirs.length === 0
      ? ""
      : html`<ul class="ap-items" aria-label="Proposed workdirs">
          ${props.workdirs.map(
            (dir) => html`<li>
              <p>${props.agent} may run commands with heel run in <code>${dir.stored ?? dir.path}</code></p>
              ${
                dir.stored === null || dir.stored === dir.path.replace(/(.)[\\/]$/, "$1")
                  ? ""
                  : html`<p class="muted">
                      ${props.agent} asked for <code>${dir.path}</code>, which leads to this
                      folder. This is the one you're adding.
                    </p>`
              }
            </li>`,
          )}
        </ul>`;
  return html`${words}${workdirs}<div class="ap-folds">${proposalDetails(props)}</div>`;
}

/** One proposal: what the agent asks for, what it would change, and the controls. */
export function proposalPage(props: ProposalPageProps): Html {
  const changesFile = props.rules.length + props.hide.length > 0;
  const pending = props.status === "pending" && props.expiresAt > props.now;
  const helpId = "proposal-passkey";
  const decide = pending
    ? html`<section class="ap-decide" aria-label="Decide">
        ${props.effect.ok ? "" : effectView(props)}
        ${actionBar({
          yes: props.effect.ok
            ? ceremonyButton({
                callback: { handler: "applyRules" },
                intent: "apply-rules",
                label: addLabel(props),
                tone: "primary",
                binding: { proposalId: props.id, sha: props.effect.sha },
                describedBy: helpId,
              })
            : "",
          no: postForm(
            props.reject,
            {},
            html`<button type="submit" class="${btn("outline")}">Reject</button>`,
          ),
          helpId,
          help: "Your passkey confirms it. Nothing changes until then.",
        })}
      </section>`
    : "";
  const done =
    props.status === "applied" && changesFile
      ? html`<p class="ap-next-action"><a class="${btn("outline")}" href="/rules/history">See the rule history</a></p>`
      : props.status === "pending"
        ? ""
        : "";
  const why =
    props.status === "applied"
      ? changesFile
        ? "heel is using them now."
        : `${props.agent}'s heel run can work there now.`
      : pending
        ? ""
        : "Nothing was added.";
  const expiring =
    pending && props.expiresAt.getTime() - props.now.getTime() < 24 * 3_600_000
      ? html`<span class="badge" data-tone="warn">Expires ${formatRelative(props.expiresAt, props.now)}</span>`
      : "";
  return approvalShell({
    kind: "rules",
    crumb: "",
    dock: props.dock ?? "pinned",
    title: title(props),
    quote: pending ? quote(props.agent, said(props)) : "",
    why,
    status: expiring,
    side: html`${decide}${done}`,
    main: changesView(props),
  });
}
