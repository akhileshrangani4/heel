import type { SignInSetup } from "../../definitions/sign-in-setup.ts";
import type { ActionDecision, ActionOutcome, Coverage } from "../../requests/coverage.ts";
import type { AgentRequestStatus } from "../../store/schema.ts";
import {
  actionBar,
  approvalShell,
  codeChip,
  type Dock,
  shorten,
  sideFold,
} from "./approval-shell.ts";
import { ceremonyButton } from "./ceremony.ts";
import { formatRelative } from "./format.ts";
import { type Html, html, trusted } from "./html.ts";
import { CHEVRON_RIGHT } from "./icons.ts";
import { badge, type FormTarget, notice, postForm, type Tone, time } from "./layout.ts";
import { serviceLogo } from "./logos.ts";
import { btn } from "./shadcn/button.ts";

/** One waiting connection request, as the Approvals list shows it. */
export interface RequestCard {
  id: string;
  agent: string;
  /** heel's words: "Gmail", "the MCP server at mcp.example.com". */
  service: string;
  /** For the service's mark. */
  provider: string;
  alias: string;
  why: string | null;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Connection requests waiting for this person, on the Approvals page. The
 * whole row opens the request: its title link stretches over the row
 * (`.req-card`), and anything else clickable in it sits above that.
 */
export function requestCards(cards: readonly RequestCard[], now: Date): Html | "" {
  if (cards.length === 0) return "";
  return html`<section class="req-section" aria-labelledby="req-connections">
    <h2 id="req-connections" class="req-section-title">
      Connection requests <span class="req-section-count">${String(cards.length)}</span>
    </h2>
    <ul class="req-group" aria-label="Connection requests">
      ${cards.map(
        (card) => html`<li class="req req-card" data-status="pending">
          <span class="req-icon">${serviceLogo(card.provider, card.alias)}</span>
          <span class="req-body">
            <span class="ap-meta">
              <span class="ap-agent">${shorten(card.agent, 12, 8)}</span>
              <span class="muted">${formatRelative(card.createdAt, now)}</span>
            </span>
            <a class="req-title req-link" href="/requests/${encodeURIComponent(card.id)}"
              >${shorten(card.agent, 12, 8)} wants to connect <mark>${card.service}</mark></a
            >
            ${
              card.why === null
                ? ""
                : html`<span class="req-reason"><span class="muted">${card.agent} says:</span> ${card.why}</span>`
            }
            <span class="req-foot muted">Expires ${formatRelative(card.expiresAt, now)}</span>
          </span>
          <span class="req-go" aria-hidden="true">${trusted(CHEVRON_RIGHT)}</span>
        </li>`,
      )}
    </ul>
  </section>`;
}

export interface RequestPageProps {
  id: string;
  agent: string;
  status: AgentRequestStatus;
  service: string;
  provider: string;
  /** The agent's choice of name; how rules and tools will name the account. */
  alias: string;
  /** For an MCP server: its full URL, shown as is. */
  url: string | null;
  /** For an MCP server: whether it signs in with OAuth. */
  oauth: boolean;
  why: string | null;
  createdAt: Date;
  expiresAt: Date;
  decision: { by: string; at: Date } | null;
  now: Date;
  /** The owner's rules and the agent's grants that would cover the account. */
  coverage: Coverage;
  /** Why it can't be connected as asked (the name is taken), or null. */
  problem: string | null;
  /** Sign-in this heel can't do yet for the provider. */
  setup: SignInSetup | null;
  /** Binds the passkey to exactly what's shown. */
  hash: string;
  reject: FormTarget;
  /** After approving: the form that starts the account's sign-in, when it needs one. */
  signIn: FormTarget | null;
  outcome: "approved" | "rejected" | null;
  /** heel couldn't check the pasted key with its service, so it was stored as it is. */
  unchecked?: boolean;
  /** For a service that uses a key: what key it takes. The owner pastes it here, never the agent. */
  key: { hint: string } | null;
  /** Phones: pin the action bar to the bottom, or keep it in the panel. */
  dock?: Dock;
  /** Design round: actions grouped by outcome (`groups`) or one list, outcome per row (`list`). */
  coverageLayout?: "groups" | "list";
}

// ── What the agent could do with it ─────────────────────────────────────────

const OUTCOME: Record<ActionOutcome, { label: string; tone: Tone | "muted" }> = {
  allow: { label: "Runs on its own", tone: "ok" },
  ask: { label: "Asks you each time", tone: "warn" },
  deny: { label: "Never runs", tone: "muted" },
  depends: { label: "Depends on the call", tone: "info" },
};
const ORDER: readonly ActionOutcome[] = ["ask", "allow", "depends", "deny"];
/** The same outcomes, short, for one badge per row (variant B). */
const SHORT: Record<ActionOutcome, string> = {
  allow: "Runs",
  ask: "Asks you",
  deny: "Never runs",
  depends: "Depends",
};

/** "merge pull request" → "Merge pull request": labels start with a capital, the rest as written. */
function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const runs = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

/** Pure: the block's one-line answer, computed from what the rules decide for each action. */
export function coverageSummary(coverage: Coverage): string {
  const actions = coverage.actions;
  if (actions.kind === "opaque") {
    switch (actions.outcome) {
      case "ask":
        return "heel can't tell reads from writes here, so every call asks you.";
      case "allow":
        return "Every call runs on its own.";
      case "deny":
        return "Every call is denied until you add a rule for it.";
      case "depends":
        return "heel can't tell reads from writes here. Your rules decide each call by what it contains.";
    }
  }
  const all = actions.actions;
  const of = (o: ActionOutcome) => all.filter((a) => a.outcome === o);
  const [allow, ask, deny, depends] = [of("allow"), of("ask"), of("deny"), of("depends")];
  const reads = all.filter((a) => a.read);
  const parts: string[] = [];
  if (allow.length === all.length) return "Everything runs on its own.";
  if (ask.length === all.length) return "Everything asks you first.";
  if (deny.length === all.length) return "Nothing can run yet: no rule covers it.";
  if (allow.length > 0) {
    parts.push(
      allow.length === reads.length && allow.every((a) => a.read)
        ? "Reads run on their own."
        : allow.length === 1
          ? "1 action runs on its own."
          : `${String(allow.length)} actions run on their own.`,
    );
  }
  if (ask.length > 0) {
    parts.push(
      allow.length > 0 && allow.length + ask.length === all.length
        ? "Everything else asks you."
        : `${String(ask.length)} ask you.`,
    );
  }
  if (depends.length > 0) {
    parts.push(`${String(depends.length)} depend on the call.`);
  }
  if (deny.length > 0)
    parts.push(`${String(deny.length)} never ${deny.length === 1 ? "runs" : "run"}.`);
  return parts.join(" ");
}

function actionName(action: ActionDecision): Html {
  return html`<li class="cov-action"${action.risk === null ? "" : html` data-risk`}>
    <span>${sentence(action.label)}</span>${
      action.risk === null
        ? ""
        : html` <span class="cov-risk" title="Look twice before approving">${sentence(action.risk)}</span>`
    }
  </li>`;
}

/** Variant A: one group per outcome, with a count, risky actions first. */
function groupsView(actions: readonly ActionDecision[]): Html {
  return html`<div class="cov-groups">
    ${ORDER.map((outcome) => {
      const these = actions
        .filter((a) => a.outcome === outcome)
        .sort((a, b) => Number(b.risk !== null) - Number(a.risk !== null));
      if (these.length === 0) return "";
      const o = OUTCOME[outcome];
      return html`<div class="cov-group" data-outcome="${outcome}">
        <h3 class="cov-group-head">
          ${badge(o.label, o.tone)} <span class="cov-count">${String(these.length)}</span>
        </h3>
        <ul class="cov-names">
          ${these.map(actionName)}
        </ul>
      </div>`;
    })}
  </div>`;
}

/** Variant B: one list, each action with its outcome, asks and risky ones first. */
function listView(actions: readonly ActionDecision[]): Html {
  const sorted = [...actions].sort(
    (a, b) =>
      ORDER.indexOf(a.outcome) - ORDER.indexOf(b.outcome) ||
      Number(b.risk !== null) - Number(a.risk !== null),
  );
  return html`<ul class="cov-list">
    ${sorted.map((a) => {
      const o = OUTCOME[a.outcome];
      return html`<li class="cov-row" data-outcome="${a.outcome}">
        <span class="cov-row-name">${sentence(a.label)}${
          a.risk === null ? "" : html` <span class="cov-risk">${sentence(a.risk)}</span>`
        }</span>
        ${badge(SHORT[a.outcome], o.tone)}
      </li>`;
    })}
  </ul>`;
}

/** Every action with its description and tool name, and the rules that decide them. */
function coverageFolds(coverage: Coverage, id: string): Html {
  const a = coverage.actions;
  const all =
    a.kind === "opaque"
      ? ""
      : html`<details class="ap-fold cov-fold">
          <summary><span class="fold-label">Show all ${String(a.actions.length)} actions</span></summary>
          <dl class="cov-all">
            ${a.actions.map(
              (d) => html`<div>
                <dt><span class="mono">${d.tool}</span> ${badge(OUTCOME[d.outcome].label, OUTCOME[d.outcome].tone)}</dt>
                <dd>${d.description}</dd>
              </div>`,
            )}
          </dl>
        </details>`;
  const deciding = new Map<string, number>();
  if (a.kind === "opaque") deciding.set(a.rule ?? "No rule matches, so it is denied", 1);
  else {
    for (const d of a.actions) {
      const key = d.rule ?? "No rule matches, so it is denied";
      deciding.set(key, (deciding.get(key) ?? 0) + 1);
    }
  }
  return html`${all}
    <details class="ap-fold cov-fold">
      <summary><span class="fold-label">Show rules</span></summary>
      <ul class="cov-rules" aria-labelledby="${id}">
        ${[...deciding].map(
          ([rule, n]) =>
            html`<li><span class="mono">${rule}</span>${
              a.kind === "opaque"
                ? ""
                : html` <span class="muted">decides ${runs(n, "action", "actions")}</span>`
            }</li>`,
        )}
        ${coverage.rules
          .filter((r) => r.rule.startsWith("grant "))
          .map(
            (r) =>
              html`<li><span class="mono">${r.rule}</span> <span class="muted">a grant for this agent</span></li>`,
          )}
      </ul>
    </details>`;
}

/**
 * One line of what the agent could do, and everything else in one fold:
 * the actions by outcome, risky ones flagged, every action and the rules.
 */
function coverageView(props: RequestPageProps): Html {
  const id = `cov-${props.id}`;
  const a = props.coverage.actions;
  const body =
    a.kind === "opaque"
      ? ""
      : props.coverageLayout === "list"
        ? listView(a.actions)
        : groupsView(a.actions);
  return html`<section class="cov" aria-labelledby="${id}">
    <p id="${id}" class="cov-summary">${coverageSummary(props.coverage)}</p>
    ${
      props.coverage.mode === "watch"
        ? notice("warn", html`<p>Watch mode is on: calls run even where this says ask.</p>`)
        : ""
    }
    <details class="ap-fold cov-more">
      <summary><span class="fold-label">See what it can do</span></summary>
      ${body}
      ${coverageFolds(props.coverage, id)}
      <p class="cov-change"><a href="/rules">Change rules</a></p>
    </details>
  </section>`;
}

// ── The page ────────────────────────────────────────────────────────────────

/** The service as the title names it, with a long MCP host shortened (the full URL is in Details). */
function serviceTitle(props: RequestPageProps): string {
  if (props.url === null || !URL.canParse(props.url)) return props.service;
  return `the MCP server at ${shorten(new URL(props.url).host, 16, 12)}`;
}

/** "as `alias`", shortened when long; left out when it's just the service's own name. */
function asAlias(props: RequestPageProps): Html | "" {
  if (props.alias === props.provider) return "";
  return html` as <code class="ap-short" title="${props.alias}">${shorten(props.alias)}</code>`;
}

function detailsFold(props: RequestPageProps): Html {
  return sideFold(
    "Details",
    html`<dl class="facts ap-facts-list">
      <dt>Agent</dt>
      <dd>${codeChip(props.agent, `agent-${props.id}`)}</dd>
      <dt>Name</dt>
      <dd>${codeChip(props.alias, `alias-${props.id}`)}</dd>
      ${
        props.url === null
          ? ""
          : html`<dt>Server</dt>
            <dd>${codeChip(props.url, `url-${props.id}`)}</dd>`
      }
      ${
        props.why === null
          ? ""
          : html`<dt>Why</dt>
            <dd>${props.why}</dd>`
      }
      ${
        props.decision === null
          ? html`<dt>Expires</dt>
            <dd>${time(props.expiresAt)}</dd>`
          : html`<dt>Decided</dt>
            <dd>By ${props.decision.by}, ${time(props.decision.at)}</dd>`
      }
      <dt>Request</dt>
      <dd>${codeChip(props.id, `id-${props.id}`)}</dd>
    </dl>`,
  );
}

function keyField(props: RequestPageProps): Html | "" {
  if (props.problem !== null || props.key === null) return "";
  return html`<fieldset id="request-key" class="ap-key-field">
    <label for="request-key-input">${props.service} key</label>
    <input
      id="request-key-input"
      name="key"
      type="password"
      autocomplete="new-password"
      data-1p-ignore
      data-lpignore="true"
      data-bwignore
      spellcheck="false"
      required
    />
    <details class="ap-hint">
      <summary>Where do I get this key?</summary>
      <p>${props.key.hint}</p>
      <p>Only heel keeps it. ${props.agent} never sees it.</p>
    </details>
  </fieldset>`;
}

/** The step left after connecting: take away the agent's old way in. */
function lastStep(props: RequestPageProps): Html {
  return html`<p class="ap-next">
    ${
      props.provider === "github"
        ? html`Next: revoke its <a href="https://github.com/settings/tokens">old GitHub token</a>.`
        : props.key !== null
          ? "Next: revoke the key it used before."
          : "Next: sign it out where it ran before."
    }
  </p>`;
}

/** The agent's own words: one line, attributed, never mistaken for heel's. Full text in Details. */
function quote(agent: string, words: string | null): Html | "" {
  if (words === null) return "";
  return html`<figure class="reason ap-quote">
    <figcaption class="visually-hidden">${agent} says (its own words; heel didn't check them):</figcaption>
    <blockquote>${words}</blockquote>
  </figure>`;
}

/** Expiry only when it's close. */
function soon(expiresAt: Date, now: Date): Html | "" {
  return expiresAt.getTime() - now.getTime() < 24 * 3_600_000
    ? html`<span class="badge" data-tone="warn">Expires ${formatRelative(expiresAt, now)}</span>`
    : "";
}

function pendingPage(props: RequestPageProps): Html {
  const helpId = "request-passkey";
  const trust =
    props.url === null
      ? ""
      : html`<p class="ap-warn" role="note">Only connect servers you trust.</p>`;
  const problem = props.problem === null ? "" : notice("error", html`<p>${props.problem}</p>`);
  const setup =
    props.setup === null
      ? ""
      : notice(
          "warn",
          html`<p>
            ${props.setup.label} sign-in isn't set up here. Set
            <span class="mono">${props.setup.configKey}</span> (<a href="${props.setup.docsUrl}">how</a>).
          </p>`,
        );
  const decide = html`<section class="ap-decide" aria-label="Decide">
    ${keyField(props)}
    ${actionBar({
      yes:
        props.problem === null
          ? ceremonyButton({
              callback: { handler: "approveConnection" },
              intent: "connect",
              label: "Connect it",
              tone: "primary",
              binding: { requestId: props.id, hash: props.hash },
              describedBy: helpId,
              ...(props.key === null ? {} : { optionsFrom: "request-key" }),
            })
          : "",
      no: postForm(
        props.reject,
        {},
        html`<button type="submit" class="${btn("outline")}">Reject</button>`,
      ),
      helpId,
      help: "Your passkey confirms it. Nothing is connected or contacted until then.",
    })}
  </section>`;
  return approvalShell({
    kind: "connection",
    crumb: "",
    dock: props.dock ?? "inline",
    title: html`${shorten(props.agent, 12, 8)} wants to connect ${serviceTitle(props)}${asAlias(props)}`,
    status: soon(props.expiresAt, props.now),
    side: html`${quote(props.agent, props.why)}${trust}${problem}${setup}${decide}
      <div class="ap-folds">${detailsFold(props)}</div>`,
    main: coverageView(props),
  });
}

/** After approving: the page becomes the confirmation (note 11). */
function connectedPage(props: RequestPageProps): Html {
  const needsSignIn = props.signIn !== null;
  const name = html`<code class="ap-short" title="${props.alias}">${shorten(props.alias)}</code>`;
  const next = needsSignIn
    ? postForm(
        props.signIn as FormTarget,
        { alias: props.alias },
        html`<button type="submit" class="${btn()}">Sign in to ${props.service}</button>`,
      )
    : html`<a class="${btn("outline")}" href="/approvals">Back to Approvals</a>`;
  return approvalShell({
    kind: "connection",
    crumb: "",
    dock: "inline",
    title: needsSignIn ? html`${name} is added` : html`${name} is connected`,
    why: needsSignIn ? "Sign in to finish." : "",
    side: html`${
      props.unchecked === true
        ? notice(
            "warn",
            html`<p>heel couldn't check the key, so it connected it as it is. If calls fail, replace it on Connections.</p>`,
          )
        : ""
    }
      <div class="ap-next-action">${next}</div>
      ${needsSignIn ? "" : lastStep(props)}
      <div class="ap-folds">${detailsFold(props)}</div>`,
    main: coverageView(props),
  });
}

const CLOSED: Record<
  Exclude<AgentRequestStatus, "pending" | "approved">,
  (p: RequestPageProps) => [string, string]
> = {
  rejected: () => ["Rejected", "Nothing was connected."],
  expired: () => ["Expired", "Nothing was connected."],
  superseded: () => ["Replaced by a newer request", "Nothing was connected."],
};

/** One request: what the agent asks for, what it would let the agent do, and the controls. */
export function requestPage(props: RequestPageProps): Html {
  if (props.status === "approved") return connectedPage(props);
  const pending = props.status === "pending" && props.expiresAt > props.now;
  if (pending) return pendingPage(props);
  const status = props.status === "pending" ? "expired" : props.status;
  const [title, why] = CLOSED[status](props);
  return approvalShell({
    kind: "connection",
    crumb: "",
    dock: "inline",
    title: html`${title}`,
    why,
    side: html`<div class="ap-next-action"><a class="${btn("outline")}" href="/approvals">Back to Approvals</a></div>
      <div class="ap-folds">${detailsFold(props)}</div>`,
  });
}
