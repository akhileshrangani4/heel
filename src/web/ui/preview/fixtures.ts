import type { ApprovalRequestView } from "../approval-request.ts";
import type { PauseNotice } from "../layout.ts";
import type { ActivePause } from "../pause-control.ts";
import type { PendingRow } from "../pending-list.ts";
import type { DiffLine, RuleTestResult, WatchEntry } from "../rules-page.ts";
import type { StandingRow } from "../standing-approval-list.ts";

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
  args: {
    from: "alice@company.com",
    to: ["bob@vendor.com"],
    cc: MANY_CC,
    bcc: [],
    subject: "Q4 renewal: schedule and pricing",
    body: LONG_BODY,
    attachments: [{ name: "q4-pricing.pdf", type: "application/pdf", size: 482_133 }],
  },
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

function row(id: string, over: Partial<PendingRow> & Pick<PendingRow, "status">): PendingRow {
  return {
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
    ...over,
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

export const WATCH_ENTRIES: readonly WatchEntry[] = [
  {
    at: minutes(-3),
    agent: "inbox-bot",
    account: "gmail-work",
    what: "email.remove",
    rule: { name: "bulk-removal-ask", file: "rules/alice.yaml", line: 22 },
    would: "ask",
    source: "rule",
  },
  {
    at: minutes(-9),
    agent: "ci-bot",
    account: "github",
    what: "github.merge",
    rule: null,
    would: "deny",
    source: "global",
  },
  {
    at: minutes(-20),
    agent: "inbox-bot",
    account: "gmail-work",
    what: "email.label",
    rule: { name: "label-allow", file: "rules/alice.yaml", line: 34 },
    would: "allow",
    source: "rule",
  },
];

export const DRAFT_PROMPT = "Ask before deleting more than 20 emails in one run on my work account";

export const DRAFT_DIFF: readonly DiffLine[] = [
  { op: "same", text: "rules:" },
  { op: "add", text: "  - name: bulk-removal-ask" },
  { op: "add", text: "    match:" },
  { op: "add", text: "      action: email.remove" },
  { op: "add", text: "      account: gmail-work" },
  { op: "add", text: "      items: { over: 20, per: run }" },
  { op: "add", text: "    then: ask" },
  { op: "same", text: "  - name: client-sends-ask" },
];

export const PASSING_TESTS: readonly RuleTestResult[] = [
  {
    name: "21st removal this run asks",
    pass: true,
    expected: "ask",
    actual: "ask (bulk-removal-ask)",
  },
  {
    name: "personal account never emails a client",
    pass: true,
    expected: "deny (rule 2)",
    actual: "deny (rule 2)",
  },
];

export const FAILING_TESTS: readonly RuleTestResult[] = [
  ...PASSING_TESTS.slice(0, 1),
  {
    name: "merge with red checks falls through to deny",
    pass: false,
    expected: "deny (default)",
    actual: "allow (merge-any)",
  },
];
