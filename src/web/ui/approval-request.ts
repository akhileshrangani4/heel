import type { RuleRef, Surface } from "../../core/call.ts";
import type { ApprovalHints, HintTone } from "../../core/hints.ts";
import type { ApprovalScript } from "../../gateway/pipeline/ports.ts";
import type { ApprovalOrigin, ApprovalStatus } from "../../store/schema.ts";
import { actionBar } from "./approval-shell.ts";
import { type CeremonyCallback, ceremonyButton } from "./ceremony.ts";
import {
  formatArguments,
  formatBytes,
  formatPauseScope,
  formatRelative,
  formatRule,
  plural,
} from "./format.ts";
import { flag, type Html, html, trusted } from "./html.ts";
import { badge, notice, type PauseNotice, type Tone, time } from "./layout.ts";
import {
  actionPhrase,
  argumentLines,
  clientLabel,
  type EmailPreview,
  groupByDomain,
  type HttpPreview,
  headline,
  homeDomain,
  type MergePreview,
  middle,
  toolPhrase,
} from "./summary.ts";

export type { EmailPreview, MergePreview } from "./summary.ts";

/** A count condition on the deciding rule, with this call's items included (I-24). */
export interface CountWindow {
  per: "run" | "hour";
  total: number;
  over: number;
}

export interface ApprovalRequestView {
  id: string;
  callHash: string;
  status: ApprovalStatus;
  /** `org` asks are approved once by an org admin and never stand (Q-A7). */
  origin: ApprovalOrigin;
  agent: string;
  runId: string | null;
  account: string;
  provider: string;
  surface: Surface;
  tool: string;
  action: string | null;
  rule: RuleRef;
  /**
   * The agent's own reason (MCP `heel_reason`, the HTTP proxy's `Heel-Reason`,
   * `heel run --reason`), or null. What the agent claims,
   * never what the call does: it's shown apart from heel's facts, as quoted words.
   */
  reason: string | null;
  /** The code-mode task the call came from, as the agent wrote it (C3), or null. */
  script: ApprovalScript | null;
  /** The MCP client the agent used, as that client named itself; null when unknown. */
  client: string | null;
  /** The canonical, post-rewrite arguments: exactly what will run. */
  args: unknown;
  /** The email a send or a draft holds; null for anything else. */
  email: EmailPreview | null;
  /** The merge view, for `github.merge`; null for anything else. */
  merge: MergePreview | null;
  /** The HTTP proxy view, with the body decoded; null for other surfaces. */
  http?: HttpPreview | null;
  items: number;
  counts: readonly CountWindow[];
  createdAt: Date;
  /** Pending: 24 h after creation. Approved: 1 h after the decision (Q-A4). */
  expiresAt: Date;
  decision: { by: string; at: Date } | null;
  executedAt: Date | null;
  /**
   * What each approval adapter said (core/hints.ts), or `pending` while one
   * hasn't answered yet; empty when none are configured.
   */
  hints: readonly { adapter: string; result: ApprovalHints | { status: "pending" } }[];
}

/**
 * Standing approval lengths offered to the approver. The longest one is what
 * the page and the docs promise; the store's 90-day hard cap (Q-A6) is a
 * backstop above it, never an option.
 */
export const STANDING_DURATIONS = [
  { value: "1h", label: "1 hour" },
  { value: "1d", label: "1 day" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
] as const;
/** The longest standing approval a person can pick, in days. */
export const STANDING_LONGEST_DAYS = 30;

/** Design variant for the email header: like a mail client (A), or one labelled row per field (B). */
export type EmailLayout = "mail" | "rows";

/**
 * Design variant for approving for longer: a menu on Approve once (A), or an
 * offer on the approved page (B, preview only: the decide route refuses a
 * second decision on an approved request today).
 */
export type AllowAgain = "menu" | "after";

export interface ApprovalRequestProps {
  now: Date;
  /** The request, or why it couldn't be loaded. */
  load: { ok: true; request: ApprovalRequestView } | { ok: false; message: string };
  /** A pause covering this request's agent, account or provider. */
  pause: PauseNotice | null;
  /** Starts the passkey ceremony for approve, approve-as-standing and deny (I-56). */
  onDecide: CeremonyCallback;
  /** The viewer's remembered sections for this kind of request; none by default. */
  folds?: Folds;
  /** The task waiting on this call runs in the background: approving starts it again at once (C6). */
  background?: boolean;
  emailLayout?: EmailLayout;
  allowAgain?: AllowAgain;
}

/**
 * A menu marked `data-heel-reset` goes back to its default choices when it
 * closes, so a choice made and abandoned never stays behind a button.
 * Presentation only: it decides nothing. Part of the decision pages' script.
 */
export const MENU_RESET_SCRIPT = `
document.addEventListener("toggle", (event) => {
  const menu = event.target;
  if (!(menu instanceof HTMLDetailsElement) || menu.open || !menu.hasAttribute("data-heel-reset")) return;
  for (const input of menu.querySelectorAll("input")) input.checked = input.defaultChecked;
}, true);
`;

/** What remembered folds are keyed by: the action, or `provider:tool` without one. */
export function foldKind(
  request: Pick<ApprovalRequestView, "action" | "provider" | "tool">,
): string {
  return request.action ?? `${request.provider}:${request.tool}`;
}

const STATUS_BADGE: Record<ApprovalStatus, { label: string; tone: Tone | "muted" }> = {
  pending: { label: "Pending", tone: "warn" },
  approved: { label: "Approved", tone: "ok" },
  denied: { label: "Denied", tone: "error" },
  expired: { label: "Expired", tone: "muted" },
  executed: { label: "Ran once", tone: "info" },
};

/** The status as a badge, for the approvals list. */
export function approvalStatusBadge(status: ApprovalStatus): Html {
  const { label, tone } = STATUS_BADGE[status];
  return badge(label, tone);
}

function lineCount(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}

/** lucide icons, drawn inline (decorative: the words beside them carry the meaning). */
const svg = (paths: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICONS = {
  chevron: svg('<path d="m6 9 6 6 6-6"/>'),
  alert: svg(
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  ),
  check: svg('<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>'),
  x: svg('<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>'),
  clock: svg('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'),
  paperclip: svg(
    '<path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"/>',
  ),
  back: svg('<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>'),
  steps: svg(
    '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  ),
} as const;

/** The chevron at the right of every fold's summary; CSS turns it when the fold is open. */
const CHEV = html`<span class="chev">${trusted(ICONS.chevron)}</span>`;

/** Email bodies longer than this show the first lines and fold the rest. */
const BODY_LINES_SHOWN = 6;

/** Sections the person opened or closed before on this kind of request (store/folds.ts). */
export type Folds = ReadonlyMap<string, boolean>;

/**
 * The page's top-level folds share one `name`, so the browser keeps at most
 * one of them open (exclusive `<details>`).
 */
const ONE_OPEN = "ap-one";

/**
 * A collapsible section the page remembers per kind of request. The client
 * script posts a toggle; the server renders the remembered state next time.
 */
function fold(
  folds: Folds,
  section: string,
  openByDefault: boolean,
  summary: Html,
  content: Html,
  className = "ap-fold",
  exclusive = false,
): Html {
  const open = folds.get(section) ?? openByDefault;
  return html`<details class="${className}"${exclusive ? html` name="${ONE_OPEN}"` : ""} data-heel-fold="${section}"${flag("open", open)}>
    <summary><span class="fold-label">${summary}</span>${CHEV}</summary>
    ${content}
  </details>`;
}

const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The page's one sentence: what will happen, where. Built from the stored
 * call, never from the agent's words. Long names are cut in the middle here
 * only; the content below shows them whole.
 */
export function askSentence(request: ApprovalRequestView): string {
  const place = middle(request.account);
  const email = request.email;
  if (email !== null) {
    if (request.action === "email.draft") return `Save an email draft in ${place}`;
    const everyone = [...new Set([...email.to, ...email.cc, ...email.bcc])];
    const who = everyone.length === 1 ? middle(everyone[0] ?? "") : `${everyone.length} people`;
    return `${cap(actionPhrase(request.action, request.tool))} to ${who} from ${place}`;
  }
  const said = headline(request);
  return `${cap(said.action)} ${said.preposition} ${middle(said.place)}${said.rest}`;
}

/** A stable colour per agent name, so two agents never look alike at a glance. */
function agentHue(name: string): number {
  let hue = 7;
  for (const c of name) hue = (hue * 31 + (c.codePointAt(0) ?? 0)) % 360;
  return hue;
}

/** Expiry shows only when it's close. */
const CLOSE_MS = 2 * 60 * 60 * 1000;

/** Who is asking, named once. Everywhere else the page says "the agent". */
function whoView(request: ApprovalRequestView, now: Date): Html {
  const soon =
    request.status === "pending" && request.expiresAt.getTime() - now.getTime() < CLOSE_MS;
  return html`<div class="ap-who">
    <span class="ap-avatar" style="--hue:${String(agentHue(request.agent))}" aria-hidden="true"
      >${request.agent.charAt(0).toUpperCase()}</span
    >
    <span class="ap-agent" title="${request.agent}">${middle(request.agent)}</span>
    ${soon ? html`<span class="ap-soon">Expires ${formatRelative(request.expiresAt, now)}</span>` : ""}
  </div>`;
}

/** How the agent reached heel, for Technical: the MCP client it named, or the surface. */
function viaText(request: ApprovalRequestView): string {
  if (request.client !== null) return `${clientLabel(request.client)}, as it named itself`;
  if (request.surface === "cli") return "heel run";
  if (request.surface === "http") return "The HTTP proxy";
  return "Unknown";
}

/** The agent's reason, set apart and marked as its own: heel didn't check it. */
function reasonView(request: ApprovalRequestView): Html | "" {
  if (request.reason === null) return "";
  return html`<figure class="reason ap-why">
    <figcaption>The agent says <span class="ap-unchecked">Not checked</span></figcaption>
    <blockquote>${request.reason}</blockquote>
  </figure>`;
}

/** Recipients by domain: every domain named, outsiders marked, every address on the page. */
function recipients(
  field: string,
  addresses: readonly string[],
  home: string | null,
  folds: Folds,
): Html {
  return html`<ul class="ap-domains">
    ${groupByDomain(addresses, home).map((group) => {
      const outside = group.outside ? html` <span class="ap-outside">Outside</span>` : "";
      if (group.addresses.length <= 3) {
        return html`<li>
          ${group.addresses.map((a) => html`<span class="ap-chip${group.outside ? " is-outside" : ""}">${a}</span> `)}${outside}
        </li>`;
      }
      // Only groups of four or more fold, and the domain stays in the summary.
      return html`<li>
        ${fold(
          folds,
          `${field}:${group.domain}`,
          false,
          html`<strong>${group.addresses.length} people</strong> at ${group.domain}${outside}`,
          html`<ul class="ap-addresses">
            ${group.addresses.map((a) => html`<li>${a}</li>`)}
          </ul>`,
        )}
      </li>`;
    })}
  </ul>`;
}

/**
 * The body as readable text. A long one shows its first lines and folds the
 * rest behind "Show all N lines"; every line is on the page either way
 * (I-57), split across two blocks that join back exactly.
 */
function mailBody(body: string, folds: Folds): Html {
  const lines = body.split("\n");
  if (lines.length <= BODY_LINES_SHOWN) {
    return html`<div class="ap-mail"><pre class="body">${body}</pre></div>`;
  }
  const head = lines.slice(0, BODY_LINES_SHOWN).join("\n");
  const rest = lines.slice(BODY_LINES_SHOWN).join("\n");
  return html`<div class="ap-mail">
    <pre class="body">${head}</pre>
    ${fold(
      folds,
      "body",
      false,
      html`Show all ${String(lines.length)} lines`,
      html`<pre class="body">${rest}</pre>`,
      "ap-fold ap-mail-more",
    )}
  </div>`;
}

const row = (key: string, value: Html | string, className = "ap-row") =>
  html`<div class="${className}"><span class="ap-key">${key}</span><div class="ap-val">${value}</div></div>`;

/**
 * The email as an email: who it goes to, then the subject and body. Empty
 * Cc and Bcc share one line rather than a row each, so nothing is hidden.
 */
function emailView(
  request: ApprovalRequestView,
  email: EmailPreview,
  folds: Folds,
  layout: EmailLayout,
): Html {
  const id = `email-${request.id}`;
  const draft = request.action === "email.draft";
  const home = homeDomain(email.from);
  const empty = [email.cc.length === 0 ? "cc" : "", email.bcc.length === 0 ? "bcc" : ""].filter(
    (f) => f !== "",
  );
  const attachments =
    email.attachments.length === 0
      ? ""
      : html`<ul class="ap-files" aria-label="Attachments, not opened by heel">
          ${email.attachments.map(
            (a) => html`<li class="ap-file">
              <span class="ap-file-icon">${trusted(ICONS.paperclip)}</span>
              <span class="ap-file-name">${a.name}</span>
              <span class="muted">${formatBytes(a.size)}</span>
            </li>`,
          )}
        </ul>`;
  const forwarded =
    email.forwarded === undefined
      ? ""
      : html`<div class="ap-forwarded">
          ${fold(
            folds,
            "forwarded",
            true,
            html`Forwards ${plural(lineCount(email.forwarded.text), "line")}`,
            html`<pre class="body">${email.forwarded.text}</pre>`,
          )}
          ${
            email.forwarded.attachments.length === 0
              ? ""
              : html`<p class="muted">
                  With ${email.forwarded.attachments.join(", ")}, not opened by heel
                </p>`
          }
        </div>`;
  return html`<section class="ap-content ap-email" data-layout="${layout}" aria-labelledby="${id}">
    <h2 id="${id}" class="ap-content-title">${draft ? "Draft, not sent" : "Email"}</h2>
    ${row("To", email.to.length === 0 ? html`<span class="muted">Nobody</span>` : recipients("to", email.to, home, folds))}
    ${email.cc.length === 0 ? "" : row("Cc", recipients("cc", email.cc, home, folds))}
    ${email.bcc.length === 0 ? "" : row("Bcc", recipients("bcc", email.bcc, home, folds))}
    ${row("From", email.from)}
    ${empty.length === 0 ? "" : html`<p class="ap-none">No ${empty.join(" or ")}</p>`}
    ${row("Subject", html`<strong>${email.subject}</strong>`, "ap-row ap-subject")}
    ${email.bodyFormat === "html" ? html`<p class="muted ap-note">HTML source, not rendered</p>` : ""}
    ${mailBody(email.body, folds)}
    ${forwarded} ${attachments}
  </section>`;
}

function mergeView(request: ApprovalRequestView, merge: MergePreview): Html {
  const id = `merge-${request.id}`;
  return html`<section class="ap-content" aria-labelledby="${id}">
    <h2 id="${id}" class="ap-content-title">Merge</h2>
    ${row("Repo", merge.repo)}
    ${row("Pull request", `#${merge.number}`)}
    ${merge.base === null ? "" : row("Into", merge.base)}
    ${merge.method === null ? "" : row("Method", merge.method)}
    ${merge.sha === null ? "" : row("Commit", html`<span class="mono ap-sha">${merge.sha}</span>`)}
  </section>`;
}

/** An HTTP proxy request, with its body decoded: what the API will receive. */
function httpView(request: ApprovalRequestView, http: HttpPreview): Html {
  const id = `http-${request.id}`;
  const query = Object.entries(http.query);
  const body =
    http.body.kind === "none"
      ? html`<span class="muted">None</span>`
      : http.body.kind === "bytes"
        ? html`<span class="muted"
            >${formatBytes(http.body.size)} of ${http.body.contentType}, not text, so not shown</span
          >`
        : html`${
            http.body.kind === "text"
              ? html`<p class="muted ap-note">Sent as ${http.body.contentType}</p>`
              : ""
          }<pre class="body">${http.body.text}</pre>`;
  return html`<section class="ap-content" aria-labelledby="${id}">
    <h2 id="${id}" class="ap-content-title">Request</h2>
    ${row("Call", html`<span class="mono">${http.method} ${http.path}</span>`)}
    ${query.map(([name, value]) =>
      row(
        `?${name}`,
        html`<span class="mono">${Array.isArray(value) ? value.join(", ") : value}</span>`,
      ),
    )}
    ${row("Body", body)}
  </section>`;
}

/**
 * Every top-level argument, for tools without their own view: who or what
 * it reaches first, then its content, then the rest. Empty ones share a line.
 */
function argumentsView(request: ApprovalRequestView): Html {
  const id = `what-${request.id}`;
  const lines = argumentLines(request.args);
  const filled = lines.filter((l) => l.empty !== true);
  const empty = lines.filter((l) => l.empty === true).map((l) => l.name);
  return html`<section class="ap-content ap-args-view" aria-labelledby="${id}">
    <h2 id="${id}" class="ap-content-title">What will run</h2>
    ${filled.map(
      (line) =>
        html`<div class="ap-row">
          <span class="ap-key">${line.name}</span>
          ${line.block ? html`<pre class="body ap-val">${line.value}</pre>` : html`<span class="ap-val">${line.value}</span>`}
        </div>`,
    )}
    ${empty.length === 0 ? "" : html`<p class="ap-none">Left empty: ${empty.join(", ")}</p>`}
  </section>`;
}

/** The exact arguments, as JSON, in the main flow under the content (I-57). */
function rawArguments(request: ApprovalRequestView, folds: Folds): Html {
  return fold(
    folds,
    "args",
    false,
    html`<span id="args-${request.id}">See raw arguments</span>`,
    html`<pre class="args" tabindex="0" aria-labelledby="args-${request.id}">${formatArguments(
      request.args,
    )}</pre>`,
    "ap-fold ap-args",
    true,
  );
}

function countsText(request: ApprovalRequestView): string {
  return [
    `${plural(request.items, "item")} in this call`,
    ...request.counts.map(
      (w) =>
        `${plural(w.total, "item")} this ${w.per}, including this call (the rule asks over ${w.over})`,
    ),
  ].join("; ");
}

/** Earlier steps' decisions, in words. */
const DONE_WORDS: Readonly<Record<string, string>> = {
  allow: "Allowed",
  approved: "You approved",
  standing: "Allowed",
  grant: "Allowed",
  ask: "Asked you",
  deny: "Denied",
  paused: "Stopped",
  error: "Failed",
  unknown: "Unknown",
};

/** One small line near the top, only for a step of a longer task (code mode). */
function taskRow(request: ApprovalRequestView): Html | "" {
  const script = request.script;
  if (script === null) return "";
  return html`<p class="ap-taskrow">
    <span class="ap-taskrow-icon">${trusted(ICONS.steps)}</span>
    <span>Step ${String(script.before.length + 1)} of a longer task</span>
    <a href="#task-${request.id}">See steps</a>
  </p>`;
}

/**
 * The longer task this call is a step of (code mode, C3): the steps already
 * done, in plain words, and the agent's code in a closed fold for audit.
 * Every step is checked by the rules on its own, whatever the code says.
 */
function taskView(request: ApprovalRequestView, background: boolean, folds: Folds): Html | "" {
  const script = request.script;
  if (script === null) return "";
  const id = `task-${request.id}`;
  const step = (tool: string, account: string) =>
    html`${cap(toolPhrase(tool))}${account === request.account ? "" : html` <span class="muted">on ${account}</span>`}`;
  return html`<section class="ap-task" id="${id}" aria-labelledby="${id}-title">
    <h2 id="${id}-title" class="ap-content-title">Part of a longer task</h2>
    <ol class="ap-steps">
      ${script.before.map(
        (c) =>
          html`<li><span>${step(c.tool, c.account)}</span> <span class="ap-step-done">${DONE_WORDS[c.decision] ?? c.decision}</span></li>`,
      )}
      <li class="is-now"><span>${cap(actionPhrase(request.action, request.tool))}</span> <span class="ap-step-done">This step</span></li>
    </ol>
    ${
      background && request.status === "pending"
        ? html`<p class="ap-note">If you approve, the rest runs without asking again. Deny ends it.</p>`
        : ""
    }
    ${fold(
      folds,
      "code",
      false,
      html`See the code the agent wrote`,
      html`<pre class="body mono">${script.code}</pre>
        ${script.truncated ? html`<p class="muted ap-note">Cut here: the code is longer than heel keeps.</p>` : ""}`,
      "ap-fold ap-code",
      true,
    )}
  </section>`;
}

const HINT_TONE: Record<HintTone, Tone> = { warn: "warn", note: "info", ok: "ok" };
const HINT_LABEL: Record<HintTone, string> = { warn: "Check", note: "Note", ok: "OK" };

/** Approval adapters' advice. Shown as advice: the person still decides. */
function hintsView(request: ApprovalRequestView): Html | "" {
  if (request.hints.length === 0) return "";
  const id = `hints-${request.id}`;
  return html`<section class="ap-hints" aria-labelledby="${id}">
    <h3 id="${id}" class="ap-sub">Hints</h3>
    <p class="muted ap-note">Advice from ${request.hints.map((h) => h.adapter).join(", ")}. It can't approve or deny anything: you decide.</p>
    ${request.hints.map(({ adapter, result }) =>
      result.status === "pending"
        ? html`<p class="muted">Hints from ${adapter} are on the way. Reload in a few seconds.</p>`
        : result.status === "unavailable"
          ? html`<p class="muted">Hints from ${adapter} are unavailable for this request.</p>`
          : result.hints.length === 0
            ? html`<p class="muted">${adapter} has nothing to point out.</p>`
            : html`<ul class="hints">
              ${result.hints.map(
                (hint) =>
                  html`<li>${badge(HINT_LABEL[hint.tone], HINT_TONE[hint.tone])} ${hint.text}</li>`,
              )}
            </ul>`,
    )}
  </section>`;
}

/** What did or didn't happen, in one short line, for the decided view. */
function outcomeLine(request: ApprovalRequestView): string | null {
  switch (request.status) {
    case "pending":
      return null;
    case "approved":
      return "It will run once.";
    case "executed":
      return "It ran once.";
    case "expired":
      return "Nobody decided in time, so it can't be approved or denied.";
    case "denied":
      if (request.action === "email.draft") return "No draft was saved.";
      if (request.action === "email.send") return "No email was sent.";
      if (request.action === "github.merge") return "Nothing was merged.";
      return "This call didn't run.";
  }
}

const OUTCOME: Record<
  Exclude<ApprovalStatus, "pending">,
  { word: string; tone: Tone | "muted"; icon: keyof typeof ICONS }
> = {
  approved: { word: "Approved", tone: "ok", icon: "check" },
  executed: { word: "Done", tone: "info", icon: "check" },
  denied: { word: "Denied", tone: "error", icon: "x" },
  expired: { word: "Expired", tone: "muted", icon: "clock" },
};

/** What happens if the same call comes again, for Technical. */
function afterwards(request: ApprovalRequestView): string | null {
  switch (request.status) {
    case "pending":
      return null;
    case "approved":
      return request.script === null
        ? "It runs once, when the agent sends the same call again and your rules still ask about it. Unused, it lapses at the expiry time."
        : "It runs once, when the task goes on from this step and your rules still ask about it. Unused, it lapses at the expiry time.";
    case "denied":
      return "If the agent sends the same call again before the expiry time, heel denies it without asking you.";
    case "expired":
      return "If the agent sends the same call again, you get a new request.";
    case "executed":
      return "If the agent sends the same call again, your rules decide it as a new call.";
  }
}

/** A rule's name in words: `everything-else-asks` reads as ‘everything else asks’. */
function ruleWords(rule: RuleRef): string {
  return rule.name === null ? "An unnamed rule" : `‘${rule.name.replace(/[-_]+/g, " ")}’`;
}

/**
 * Approving for longer, as the options inside the menu on Approve once.
 * The narrowest choice, this exact call, is the default; the broad one says
 * what it covers and is marked. Ends early if the rule changes, at most 30
 * days (the store keeps the hard cap).
 */
function allowAgainOptions(
  request: ApprovalRequestView,
  fieldsetId: string,
  locked: boolean,
  withOnce: boolean,
): Html {
  const scope = (value: string, label: Html | string, broad: boolean, checked: boolean) =>
    html`<label class="choice${broad ? " is-broad" : ""}" for="${fieldsetId}-${value}">
      <input type="radio" id="${fieldsetId}-${value}" name="scope" value="${value}"${flag("checked", checked)} />
      <span>${label}${broad ? html` <span class="ap-broad">Broad</span>` : ""}</span>
    </label>`;
  return html`<fieldset id="${fieldsetId}" class="ap-allow"${flag("disabled", locked)}>
    <legend>${withOnce ? "Approve" : "Allow it again without asking"}</legend>
    ${withOnce ? scope("once", "Just this once", false, true) : ""}
    ${scope("exact_call", withOnce ? "This exact call, and again without asking" : "This exact call", false, !withOnce)}
    ${scope("rule", html`Any call the rule ${ruleWords(request.rule)} covers`, true, false)}
    ${request.runId === null ? "" : scope("run", "Any call that rule covers in this run", true, false)}
    <div class="ap-pills" role="radiogroup" aria-label="For how long">
      ${STANDING_DURATIONS.map(
        (d) => html`<label class="ap-pill" for="${fieldsetId}-for-${d.value}">
          <input type="radio" id="${fieldsetId}-for-${d.value}" name="duration" value="${d.value}"${flag("checked", d.value === "1d")} />
          <span>${d.label}</span>
        </label>`,
      )}
    </div>
    <p class="muted ap-note">Ends sooner if the rule changes; at most ${STANDING_LONGEST_DAYS} days. A run allows at most a day.</p>
  </fieldset>`;
}

/** What an allow button says for a scope and length. */
export function allowLabel(scope: "exact_call" | "rule" | "run", duration: string): string {
  const length = STANDING_DURATIONS.find((d) => d.value === duration)?.label ?? duration;
  if (scope === "exact_call") return `Allow for ${length}`;
  if (scope === "rule") return `Allow all for ${length}`;
  return `Allow run for ${length}`;
}

/**
 * One allow button per choice, each with its own fixed options, so what the
 * passkey signs is what the button says, by construction (I-56). CSS shows
 * only the one matching the radios; the radios themselves sign nothing.
 */
function allowButtons(
  request: ApprovalRequestView,
  onDecide: CeremonyCallback,
  helpId: string,
  locked: boolean,
  tone: "primary" | "secondary",
): Html {
  const scopes =
    request.runId === null
      ? (["exact_call", "rule"] as const)
      : (["exact_call", "rule", "run"] as const);
  const binding = { approvalId: request.id, callHash: request.callHash };
  return html`${scopes.map((scope) =>
    STANDING_DURATIONS.map((d) => {
      const id = `allow-${request.id}-${scope}-${d.value}`;
      return html`<span class="ap-allow-btn" data-scope="${scope}" data-duration="${d.value}">
        ${ceremonyButton({
          callback: onDecide,
          intent: "approve-standing",
          label: allowLabel(scope, d.value),
          tone,
          binding,
          disabled: locked,
          describedBy: helpId,
          optionsFrom: id,
        })}
        <fieldset id="${id}" hidden>
          <input type="hidden" name="scope" value="${scope}" />
          <input type="hidden" name="duration" value="${d.value}" />
        </fieldset>
      </span>`;
    }),
  )}`;
}

/**
 * The single biggest risk in the call, as one plain line above the content.
 * Built only from the stored call heel will run (never the agent's words),
 * and null when nothing stands out. A draft sends nothing, so it has none.
 */
export function biggestRisk(request: ApprovalRequestView): string | null {
  if (request.email !== null) {
    if (request.action === "email.draft") return null;
    const email = request.email;
    const home = homeDomain(email.from);
    const all = [...email.to, ...email.cc, ...email.bcc];
    const outside = groupByDomain(all, home).filter((g) => g.outside);
    if (outside.length > 0) {
      const people = outside.reduce((n, g) => n + g.addresses.length, 0);
      const domains = outside.map((g) => g.domain || "an address with no domain").join(", ");
      return `Goes to ${people === 1 ? "1 person" : `${people} people`} outside your domain (${domains}).`;
    }
    if (email.bcc.length > 0) {
      return `Also goes to ${email.bcc.length === 1 ? "1 hidden recipient" : `${email.bcc.length} hidden recipients`} (Bcc).`;
    }
    return null;
  }
  if (request.merge !== null) {
    const base = request.merge.base;
    if (base !== null && /^(main|master|production|prod|release)$/i.test(base)) {
      return `Merges into ${base} in ${request.merge.repo}.`;
    }
    return null;
  }
  if (request.http) {
    if (request.http.method.toUpperCase() === "DELETE") {
      return `Deletes ${request.http.path} on ${request.account}.`;
    }
  }
  return null;
}

/** heel's risk line and the adapters' "check" hints: the page's one short note. */
function riskView(request: ApprovalRequestView): Html | "" {
  if (request.status !== "pending") return "";
  const risk = biggestRisk(request);
  const checks = request.hints.flatMap(({ result }) =>
    result.status === "ok" ? result.hints.filter((h) => h.tone === "warn") : [],
  );
  if (risk === null && checks.length === 0) return "";
  return html`${
    risk === null
      ? ""
      : html`<p class="ap-risk" role="note"><span class="ap-risk-icon">${trusted(ICONS.alert)}</span><span><span class="ap-risk-word">Check:</span> ${risk}</span></p>`
  }${
    checks.length === 0
      ? ""
      : html`<ul class="ap-check-hints" aria-label="Hints to check">
          ${checks.map((h) => html`<li>${badge(HINT_LABEL[h.tone], HINT_TONE[h.tone])} ${h.text}</li>`)}
        </ul>`
  }`;
}

/**
 * The decision: Deny and Approve once side by side, pinned to the bottom of
 * a phone screen while the request waits. Approving for longer is a menu on
 * Approve once (variant A): one extra step, the narrowest choice first. The
 * passkey sentence is read out with the buttons (aria-describedby).
 */
function decisionControls(
  request: ApprovalRequestView,
  pause: PauseNotice | null,
  onDecide: CeremonyCallback,
  allowAgain: AllowAgain,
): Html | "" {
  if (request.status !== "pending" && request.status !== "expired") return "";
  // An expired request can't be decided at all (I-55). Approving in a paused
  // scope is refused (I-61); denying only tightens, so it stays open.
  const expired = request.status === "expired";
  const approveLocked = expired || pause !== null;
  const fieldsetId = `standing-${request.id}`;
  const helpId = `decide-help-${request.id}`;
  const binding = { approvalId: request.id, callHash: request.callHash };
  const once = ceremonyButton({
    callback: onDecide,
    intent: "approve-once",
    label: "Approve once",
    tone: "primary",
    binding,
    disabled: approveLocked,
    describedBy: helpId,
  });
  // One primary button that always says what it does: Approve once by default;
  // choosing to allow it again swaps in the allow button, labelled with that
  // choice. The menu goes back to "Just this once" when it closes.
  const split =
    request.origin === "org" || allowAgain !== "menu"
      ? ""
      : html`<span class="ap-split">
          ${once}
          ${allowButtons(request, onDecide, helpId, approveLocked, "primary")}
          <details class="ap-split-menu" name="${ONE_OPEN}" data-heel-reset>
            <summary class="ap-split-toggle" aria-label="Approve for longer">${trusted(ICONS.chevron)}</summary>
            <div class="ap-menu">${allowAgainOptions(request, fieldsetId, approveLocked, true)}</div>
          </details>
        </span>`;
  return html`<section class="ap-decide" aria-labelledby="decide-${request.id}">
    <h2 id="decide-${request.id}" class="visually-hidden">Decide</h2>
    ${actionBar({
      yes: split === "" ? once : split,
      no: ceremonyButton({
        callback: onDecide,
        intent: "deny",
        label: "Deny",
        tone: "danger",
        binding,
        disabled: expired,
        describedBy: helpId,
      }),
      helpId,
      help: "Your passkey confirms every decision. Nothing runs until you approve.",
      dock: !expired,
    })}
    ${
      request.origin === "org"
        ? html`<p class="muted ap-note">An org rule asked: only an org admin can approve it, once. Org asks never stand.</p>`
        : ""
    }
  </section>`;
}

/**
 * Variant B (preview only): after approving once, one offer to ask less next
 * time. The decide route refuses a second decision on an approved request
 * today, so this needs a backend change before it can ship.
 */
function allowAfter(request: ApprovalRequestView, onDecide: CeremonyCallback): Html {
  const fieldsetId = `standing-${request.id}`;
  const helpId = `decide-help-${request.id}`;
  return html`<section class="ap-after" aria-label="Ask less next time">
    <p class="ap-after-ask">Ask less next time?</p>
    ${allowAgainOptions(request, fieldsetId, false, false)}
    ${allowButtons(request, onDecide, helpId, false, "secondary")}
    <p id="${helpId}" class="visually-hidden">Your passkey confirms it.</p>
  </section>`;
}

const PROVIDERS: Readonly<Record<string, string>> = {
  gmail: "Gmail",
  outlook: "Outlook",
  github: "GitHub",
  "google-calendar": "Google Calendar",
  linear: "Linear",
  notion: "Notion",
  slack: "Slack",
  stripe: "Stripe",
  http: "HTTP API",
};

/**
 * Details: four plain rows, then Technical for everything an auditor needs
 * (ids, tool names, counts, absolute times, the rule's file). The agent's
 * name isn't repeated here.
 */
function detailsView(request: ApprovalRequestView, folds: Folds, now: Date): Html {
  const after = afterwards(request);
  const last =
    request.status === "pending" || request.status === "approved"
      ? row("Expires", cap(formatRelative(request.expiresAt, now)))
      : request.decision !== null
        ? row("Decided", `By ${request.decision.by}, ${formatRelative(request.decision.at, now)}`)
        : row("Expired", cap(formatRelative(request.expiresAt, now)));
  return fold(
    folds,
    "details",
    false,
    html`Details`,
    html`<div class="ap-fold-body">
      ${row("Account", `${request.account}, ${PROVIDERS[request.provider] ?? request.provider}`)}
      ${row("What it does", cap(actionPhrase(request.action, request.tool)))}
      ${row("Rule", `${ruleWords(request.rule)} asked you`)}
      ${last}
      ${hintsView(request)}
      <details class="ap-technical">
        <summary><span class="fold-label">Technical</span>${CHEV}</summary>
        <dl class="facts">
          <dt>Client</dt>
          <dd>${viaText(request)}</dd>
          <dt>Tool</dt>
          <dd><span class="mono">${request.tool}</span> via ${request.surface}</dd>
          <dt>Action</dt>
          <dd class="mono">${request.action ?? "None"}</dd>
          <dt>Rule</dt>
          <dd>
            ${formatRule(request.rule)}
            (${request.origin === "org" ? "org rules" : "owner's rules"})
          </dd>
          <dt>Counts</dt>
          <dd>${countsText(request)}</dd>
          <dt>Run</dt>
          <dd class="mono">${request.runId ?? "None"}</dd>
          <dt>Requested</dt>
          <dd>${time(request.createdAt)}</dd>
          ${
            request.decision === null
              ? ""
              : html`<dt>Decided</dt>
                <dd>${time(request.decision.at)}</dd>`
          }
          ${
            request.executedAt === null
              ? ""
              : html`<dt>Ran</dt>
                <dd>${time(request.executedAt)}</dd>`
          }
          <dt>${request.status === "denied" ? "Denied until" : request.status === "expired" ? "Expired" : "Expires"}</dt>
          <dd>${time(request.expiresAt)}</dd>
          ${after === null ? "" : html`<dt>Next</dt><dd>${after}</dd>`}
          <dt>Request</dt>
          <dd class="mono">${request.id}</dd>
        </dl>
      </details>
    </div>`,
    "ap-fold ap-details",
    true,
  );
}

/** A decided request in a word and one short line. */
function outcomeView(request: ApprovalRequestView): Html {
  if (request.status === "pending") return html``;
  const { word, tone, icon } = OUTCOME[request.status];
  const line = outcomeLine(request);
  return html`<section class="ap-outcome" data-tone="${tone}" role="status">
    <span class="ap-outcome-icon">${trusted(ICONS[icon])}</span>
    <div>
      <h1 class="ap-outcome-word">${word}</h1>
      ${line === null ? "" : html`<p class="ap-outcome-line">${line}</p>`}
    </div>
  </section>`;
}

/**
 * The approval page body (spec: The approval page). Top to bottom: who is
 * asking (named once), what will happen in one sentence, the agent's reason
 * set apart, heel's one note, the content as it will land with its raw
 * arguments a tap away, then Deny and Approve once, pinned on a phone. A
 * decided request leads with its outcome in a word and a line. The
 * arguments are on the page, in full, in every state (I-57).
 */
export function approvalRequest(props: ApprovalRequestProps): Html {
  if (!props.load.ok) {
    return html`<h1>Approval request</h1>
      ${notice(
        "error",
        html`<p><strong>This request couldn't be loaded.</strong> ${props.load.message}</p>
          <p>Nothing was decided.</p>`,
      )}`;
  }
  const request = props.load.request;
  const folds: Folds = props.folds ?? new Map();
  const pending = request.status === "pending";
  const allowAgain = props.allowAgain ?? "menu";
  const view =
    request.email !== null
      ? emailView(request, request.email, folds, props.emailLayout ?? "mail")
      : request.merge !== null
        ? mergeView(request, request.merge)
        : request.http
          ? httpView(request, request.http)
          : argumentsView(request);
  const lock =
    props.pause !== null && pending
      ? notice(
          "warn",
          html`<p>
            Approving is unavailable while ${formatPauseScope(props.pause.scope, props.pause.target)}
            is paused. You can still deny.
          </p>`,
        )
      : "";
  // One h1: the ask while it waits, the outcome once it's decided or expired.
  const title = pending
    ? html`<h1 class="ap-title">${askSentence(request)}</h1>`
    : html`<p class="ap-title">${askSentence(request)}</p>`;
  const after =
    request.status === "approved" && allowAgain === "after" && request.origin !== "org"
      ? allowAfter(request, props.onDecide)
      : "";
  return html`<article class="ap${pending ? "" : " is-decided"}" data-kind="call"${pending ? html` data-dock="pinned"` : ""} data-heel-fold-kind="${foldKind(request)}">
    <nav class="ap-crumbs" aria-label="Breadcrumb">
      <a href="/approvals">${trusted(ICONS.back)}Approvals</a>
    </nav>
    ${outcomeView(request)} ${after}
    ${whoView(request, props.now)} ${title} ${lock}
    ${reasonView(request)} ${pending ? taskRow(request) : ""} ${riskView(request)}
    ${view}
    ${rawArguments(request, folds)}
    ${taskView(request, props.background === true, folds)}
    ${decisionControls(request, props.pause, props.onDecide, allowAgain)}
    ${detailsView(request, folds, props.now)}
  </article>`;
}
