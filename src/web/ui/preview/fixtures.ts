import type { ApprovalRequestView } from "../approval-request.ts";
import type { PauseNotice } from "../layout.ts";
import type { ActivePause } from "../pause-control.ts";
import type { PendingRow } from "../pending-list.ts";
import type { StandingRow } from "../standing-approval-list.ts";
import { emailPreviewFrom, headline, mailPreviewFrom } from "../summary.ts";

/**
 * Fixture props for the preview harness and the render tests. Every value is
 * invented for previews; nothing here is read from a real install.
 */

export const NOW = new Date("2026-11-13T14:00:00.000Z");

const minutes = (n: number): Date => new Date(NOW.getTime() + n * 60_000);
const hours = (n: number): Date => minutes(n * 60);

/**
 * A body longer than any sensible truncation limit, ending in a marker the
 * render tests look for: if it shows, nothing was cut (I-57).
 */
export const LONG_BODY = [
  "Hi Bob,",
  "",
  ...Array.from(
    { length: 40 },
    (_, i) =>
      `Line ${i + 1}: the Q4 renewal schedule, pricing tiers and onboarding dates as discussed on the call.`,
  ),
  "",
  "END-OF-BODY-MARKER",
].join("\n");

/** Forty recipients, so a list that truncated would visibly drop some. */
export const MANY_CC = Array.from({ length: 40 }, (_, i) => `person${i + 1}@vendor.com`);

export const PENDING_REQUEST: ApprovalRequestView = {
  id: "apr_7QxK2mN4pR8s",
  callHash: "b3f1c0a9d84e27f6a1c5e9d0b7f2a3c4d5e6f708192a3b4c5d6e7f8091a2b3c4",
  status: "pending",
  origin: "owner",
  agent: "inbox-bot",
  runId: "run-2026-11-13.r42",
  account: "gmail-work",
  provider: "gmail",
  surface: "code",
  tool: "send",
  action: "email.send",
  rule: { name: "client-sends-ask", file: "rules/alice.yaml", line: 14 },
  reason: "Sending Bob the Q4 renewal schedule and pricing he asked for in yesterday's thread.",
  script: null,
  client: "claude-code",
  args: {
    from: "alice@company.com",
    to: ["bob@vendor.com"],
    cc: MANY_CC,
    bcc: [],
    subject: "Q4 renewal: schedule and pricing",
    body: LONG_BODY,
    attachments: [{ name: "q4-pricing.pdf", type: "application/pdf", size: 482_133 }],
  },
  merge: null,
  email: {
    from: "alice@company.com",
    to: ["bob@vendor.com"],
    cc: MANY_CC,
    bcc: [],
    subject: "Q4 renewal: schedule and pricing",
    body: LONG_BODY,
    bodyFormat: "text",
    attachments: [{ name: "q4-pricing.pdf", type: "application/pdf", size: 482_133 }],
  },
  items: 1,
  counts: [
    { per: "run", total: 3, over: 5 },
    { per: "hour", total: 7, over: 20 },
  ],
  createdAt: minutes(-12),
  expiresAt: hours(24 - 0.2),
  decision: null,
  executedAt: null,
  hints: [],
};

export const APPROVED_REQUEST: ApprovalRequestView = {
  ...PENDING_REQUEST,
  status: "approved",
  decision: { by: "alice", at: minutes(-2) },
  expiresAt: minutes(58),
};

export const DENIED_REQUEST: ApprovalRequestView = {
  ...PENDING_REQUEST,
  status: "denied",
  decision: { by: "alice", at: minutes(-5) },
};

export const EXPIRED_REQUEST: ApprovalRequestView = {
  ...PENDING_REQUEST,
  status: "expired",
  createdAt: hours(-25),
  expiresAt: hours(-1),
};

export const EXECUTED_REQUEST: ApprovalRequestView = {
  ...APPROVED_REQUEST,
  status: "executed",
  executedAt: minutes(-1),
};

/** An org ask: approved once by an admin, never standing (Q-A7). */
/** A GitHub merge, pinned to its head commit, with the agent's reason. */
export const MERGE_REQUEST: ApprovalRequestView = {
  ...PENDING_REQUEST,
  id: "apr_Mrg4hT8wQe1",
  agent: "release-bot",
  runId: null,
  account: "github",
  provider: "github",
  surface: "mcp",
  tool: "merge_pull_request",
  action: "github.merge",
  rule: { name: "prod-merges-ask", file: "rules/alice.yaml", line: 21 },
  reason: "CI passed and Sam approved the review, so merging the billing fix before the release.",
  args: { repo: "acme/web", number: 1234, method: "squash", sha: "9f2c4e1a7b", base: "main" },
  email: null,
  merge: { repo: "acme/web", number: 1234, base: "main", method: "squash", sha: "9f2c4e1a7b" },
  counts: [],
  items: 1,
};

/** A tool with no dedicated view: its arguments read as rows. */
export const GENERIC_REQUEST: ApprovalRequestView = {
  ...PENDING_REQUEST,
  id: "apr_Gen2kP9xVb3",
  agent: "billing-bot",
  runId: null,
  account: "stripe",
  provider: "stripe",
  surface: "mcp",
  tool: "create_refund",
  action: "stripe.refund",
  rule: { name: "refunds-ask", file: "rules/alice.yaml", line: 40 },
  reason: null,
  args: { payment_intent: "pi_3Q8k2L", amount: 4500, reason: "requested_by_customer" },
  email: null,
  merge: null,
  counts: [],
  items: 1,
};

/** An HTTP proxy write: the body reads as JSON, not as the base64 the call carries. */
export const HTTP_REQUEST: ApprovalRequestView = {
  ...GENERIC_REQUEST,
  id: "apr_Htp7mQ2wLs4",
  agent: "ops-bot",
  account: "api",
  provider: "http",
  surface: "http",
  tool: "PUT /items/{id}",
  action: "item.write",
  rule: { name: "writes-ask", file: "rules/alice.yaml", line: 9 },
  args: {
    method: "PUT",
    path: "/items/5",
    query: {},
    contentType: "application/json",
    body: "eyJ0cmFuc2Zlcl90byI6ImF0dGFja2VyQGV2aWwuZXhhbXBsZSIsImFtb3VudCI6OTk5OTl9",
  },
  http: {
    method: "PUT",
    path: "/items/5",
    query: {},
    body: {
      kind: "json",
      text: JSON.stringify({ transfer_to: "attacker@evil.example", amount: 99999 }, null, 2),
    },
  },
};

export const ORG_REQUEST: ApprovalRequestView = {
  ...PENDING_REQUEST,
  id: "apr_Org9fT3kLw2",
  origin: "org",
  agent: "ci-bot",
  account: "github",
  provider: "github",
  surface: "cli",
  tool: "pr merge",
  action: "github.merge",
  rule: { name: "prod-merges-ask-admin", file: "org-rules.yaml", line: 8 },
  reason: null,
  args: {
    argv: ["gh", "pr", "merge", "1234", "--squash", "--match-head-commit", "9f2c4e1"],
    cwd: "/srv/agents/ci-bot/acme-web",
  },
  email: null,
  counts: [],
};

export const AGENT_PAUSE: PauseNotice = {
  scope: "agent",
  target: "inbox-bot",
  since: minutes(-30),
};

function row(
  id: string,
  over: Partial<Omit<PendingRow, "headline">> & Pick<PendingRow, "status">,
): PendingRow {
  const base: Omit<PendingRow, "headline"> = {
    id,
    href: `/approvals/${id}`,
    origin: "owner",
    agent: "inbox-bot",
    account: "gmail-work",
    action: "email.send",
    tool: "send",
    rule: { name: "client-sends-ask", file: "rules/alice.yaml", line: 14 },
    createdAt: minutes(-12),
    expiresAt: hours(23.8),
    pausedBy: null,
    client: "claude-code",
    reason: null,
    ...over,
  };
  const email =
    base.action === "email.send"
      ? emailPreviewFrom(base.action, {
          from: "alice@company.com",
          to: ["bob@vendor.com"],
          subject: "Q4 renewal",
          body: "Hi Bob,",
        })
      : null;
  return {
    ...base,
    headline: headline({
      agent: base.agent,
      action: base.action,
      tool: base.tool,
      account: base.account,
      email,
      merge: null,
    }),
  };
}

export const PENDING_ROWS: readonly PendingRow[] = [
  row("apr_7QxK2mN4pR8s", { status: "pending" }),
  row("apr_Rm4kLp0Q2wZx", {
    status: "pending",
    action: "email.remove",
    tool: "batch_modify",
    rule: { name: "bulk-removal-ask", file: "rules/alice.yaml", line: 22 },
    createdAt: minutes(-40),
    expiresAt: hours(23.3),
  }),
  row("apr_Org9fT3kLw2", {
    status: "pending",
    origin: "org",
    agent: "ci-bot",
    account: "github",
    action: "github.merge",
    tool: "pr merge",
    rule: { name: "prod-merges-ask-admin", file: "org-rules.yaml", line: 8 },
  }),
];

export const APPROVED_ROWS: readonly PendingRow[] = [
  row("apr_A1pp7ov3dX9k", { status: "approved", expiresAt: minutes(58) }),
  row("apr_Ex3cut3d0001", { status: "executed", expiresAt: minutes(30) }),
];

export const DENIED_ROWS: readonly PendingRow[] = [
  row("apr_D3n13dQ8r7Lm", { status: "denied", expiresAt: hours(20) }),
];

export const EXPIRED_ROWS: readonly PendingRow[] = [
  row("apr_Exp1r3dK4t2", { status: "expired", createdAt: hours(-26), expiresAt: hours(-2) }),
];

export const PAUSED_ROWS: readonly PendingRow[] = PENDING_ROWS.map((r) =>
  r.agent === "inbox-bot" ? { ...r, pausedBy: AGENT_PAUSE } : r,
);

export const ACTIVE_PAUSES: readonly ActivePause[] = [
  { scope: "agent", target: "inbox-bot", pausedBy: "alice", pausedAt: minutes(-30) },
  { scope: "account", target: "gmail-personal", pausedBy: "alice", pausedAt: hours(-3) },
];

export const PAUSE_AGENTS = ["inbox-bot", "ci-bot"] as const;
export const PAUSE_ACCOUNTS = ["gmail-work", "gmail-personal", "github"] as const;

function standing(
  id: string,
  over: Partial<StandingRow> & Pick<StandingRow, "state">,
): StandingRow {
  return {
    id,
    agent: "inbox-bot",
    account: "gmail-work",
    scope: "rule",
    rule: { name: "client-sends-ask", file: "rules/alice.yaml", line: 14 },
    covers: null,
    createdBy: "alice",
    createdAt: hours(-30),
    expiresAt: hours(24 * 6),
    revoked: null,
    paused: false,
    ...over,
  };
}

export const ACTIVE_STANDING: readonly StandingRow[] = [
  standing("sta_8Hn2Qp4Lr1", { state: "active" }),
  standing("sta_3Kd9Wm7Tz5", {
    state: "active",
    scope: "exact_call",
    covers: "email.label",
    rule: { name: "label-ask", file: "rules/alice.yaml", line: 30 },
    expiresAt: hours(5),
  }),
];

export const REVOKED_STANDING: readonly StandingRow[] = [
  standing("sta_Rv0k3d1Qa2", {
    state: "revoked",
    revoked: { by: "alice", at: minutes(-15) },
  }),
];

export const EXPIRED_STANDING: readonly StandingRow[] = [
  standing("sta_Exp1r3dZ4", { state: "expired", expiresAt: hours(-4) }),
  standing("sta_L4ps3dMn7", {
    state: "lapsed",
    rule: { name: "bulk-removal-ask", file: "rules/alice.yaml", line: 22 },
  }),
];

export const PAUSED_STANDING: readonly StandingRow[] = ACTIVE_STANDING.map((r) => ({
  ...r,
  paused: true,
}));

/** A pending request with the Jev approval adapter's hints. */
export const HINTED_REQUEST: ApprovalRequestView = {
  ...PENDING_REQUEST,
  hints: [
    {
      adapter: "jev",
      result: {
        status: "ok",
        hints: [
          { tone: "warn", text: "Asks someone for money, a payment or account access." },
          { tone: "note", text: "Unlike this agent's recent calls." },
        ],
      },
    },
  ],
};

/** The same request when the adapter couldn't answer. */
export const HINTS_UNAVAILABLE_REQUEST: ApprovalRequestView = {
  ...PENDING_REQUEST,
  hints: [{ adapter: "jev", result: { status: "unavailable", detail: "TypeSafe answered 503" } }],
};

const DRAFT_ARGS = {
  from: "michael.magan92@gmail.com",
  to: ["michael.magan92@gmail.com"],
  cc: [],
  bcc: [],
  subject: "Approval-flow test",
  body: "Deny test. This draft should never be created.",
};

/** Gmail's create_draft from a code-mode task, as in the owner's report: a draft, nothing sent. */
export const DRAFT_REQUEST: ApprovalRequestView = {
  ...PENDING_REQUEST,
  id: "apr_Drf5tQ1zKp7",
  agent: "claude-code-heel",
  runId: null,
  account: "personal",
  provider: "gmail",
  surface: "mcp",
  tool: "create_draft",
  action: "email.draft",
  rule: { name: "drafts-ask", file: "rules/michael.yaml", line: 6 },
  reason:
    "Deny-path test: save a draft to the owner's own address. The owner will deny it; nothing is sent.",
  args: DRAFT_ARGS,
  email: mailPreviewFrom("email.draft", DRAFT_ARGS),
  counts: [],
  createdAt: minutes(-1),
};

export const DENIED_DRAFT_REQUEST: ApprovalRequestView = {
  ...DRAFT_REQUEST,
  status: "denied",
  decision: { by: "michael", at: minutes(-1) },
  expiresAt: hours(24),
};

/** Step 3 of a code-mode task: two calls already made, the code kept for audit. */
export const TASK_REQUEST: ApprovalRequestView = {
  ...DRAFT_REQUEST,
  id: "apr_Tsk3sTp9Lm2",
  reason: "Drafting the reply Dana asked for, after checking which address you send from.",
  script: {
    code: [
      "import personal",
      "",
      "addresses = personal.list_send_as()",
      'thread = personal.search(query="from:dana@studio.example newer_than:2d")',
      "sender = addresses[0]",
      "personal.create_draft(",
      "    from_=sender,",
      '    to=["dana@studio.example"],',
      '    subject="Re: " + thread[0].subject,',
      '    body="Thanks Dana, Thursday works.",',
      ")",
      "personal.send_draft(draft_id=draft.id)",
    ].join("\n"),
    truncated: false,
    before: [
      { account: "personal", tool: "list_send_as", decision: "allow" },
      { account: "personal", tool: "search", decision: "allow" },
    ],
  },
};

/** Forty addresses on To, and a body long enough to fold. */
export const LONG_EMAIL_REQUEST: ApprovalRequestView = {
  ...PENDING_REQUEST,
  id: "apr_Lng8mW3qZt5",
  reason: null,
  email: {
    ...(PENDING_REQUEST.email as NonNullable<ApprovalRequestView["email"]>),
    to: [...MANY_CC, "eve.long-surname-for-wrapping@a-very-long-partner-domain.example"],
    cc: [],
    subject:
      "Q4 renewal: the full schedule, pricing tiers, onboarding dates and the open questions from Thursday's call",
  },
  args: {
    ...(PENDING_REQUEST.args as Record<string, unknown>),
    to: [...MANY_CC, "eve.long-surname-for-wrapping@a-very-long-partner-domain.example"],
    cc: [],
    subject:
      "Q4 renewal: the full schedule, pricing tiers, onboarding dates and the open questions from Thursday's call",
  },
};

/** A Linear issue with most fields left empty: the empty ones shouldn't take the screen. */
export const SPARSE_REQUEST: ApprovalRequestView = {
  ...GENERIC_REQUEST,
  id: "apr_Sps4nL7kQw1",
  agent: "triage-bot",
  account: "linear",
  provider: "linear",
  tool: "create_issue",
  action: "linear.issue.create",
  rule: { name: "issues-ask", file: "rules/alice.yaml", line: 52 },
  reason: "Filing the crash Sam reported in #support so it lands in this week's triage.",
  args: {
    assignee_id: null,
    cycle_id: null,
    description:
      "Sam reports the export button crashes the desktop app on Windows 11.\n\nSteps: open a project, Export, pick PDF.",
    estimate: null,
    labels: [],
    parent_id: null,
    priority: 2,
    project_id: "",
    team: "APP",
    title: "Export to PDF crashes on Windows 11",
  },
};
