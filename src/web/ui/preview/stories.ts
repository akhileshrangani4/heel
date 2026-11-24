import type { ActivityRow, AgentActivity } from "../../../store/activity.ts";
import { activityPage, agentsPage } from "../activity-page.ts";
import { approvalRequest, MENU_RESET_SCRIPT } from "../approval-request.ts";
import type { CeremonyCallback } from "../ceremony.ts";
import { connectPage } from "../connect.ts";
import { type ConnectionRow, connectionsPage } from "../connections.ts";
import { addDeviceControl } from "../devices.ts";
import { enrollPage } from "../enroll.ts";
import { type GrantView, grantsPage } from "../grants-page.ts";
import { type DayCount, type HomeProps, homePage } from "../home.ts";
import { type Html, html } from "../html.ts";
import {
  type FormTarget,
  type NavId,
  type PauseNotice,
  page,
  type Theme,
  type Viewer,
} from "../layout.ts";
import { type ModeRow, modesPage } from "../modes-page.ts";
import { pauseControl } from "../pause-control.ts";
import { pendingList } from "../pending-list.ts";
import { peoplePage } from "../people.ts";
import { pushControl } from "../push-control.ts";
import { ruleHistoryPage } from "../rule-history.ts";
import { rulesEditorPage } from "../rules-editor.ts";
import { oidcSignIn, passkeySignIn } from "../sign-in.ts";
import { standingApprovalList } from "../standing-approval-list.ts";
import { welcomePage } from "../welcome.ts";
import {
  ACTIVE_PAUSES,
  ACTIVE_STANDING,
  AGENT_PAUSE,
  APPROVED_REQUEST,
  APPROVED_ROWS,
  DENIED_DRAFT_REQUEST,
  DENIED_REQUEST,
  DENIED_ROWS,
  DRAFT_REQUEST,
  EXECUTED_REQUEST,
  EXPIRED_REQUEST,
  EXPIRED_ROWS,
  EXPIRED_STANDING,
  GENERIC_REQUEST,
  HINTED_REQUEST,
  HINTS_UNAVAILABLE_REQUEST,
  HTTP_REQUEST,
  LONG_EMAIL_REQUEST,
  LONG_REASON_REQUEST,
  MERGE_REQUEST,
  NOW,
  ORG_REQUEST,
  PAUSE_ACCOUNTS,
  PAUSE_AGENTS,
  PAUSED_ROWS,
  PAUSED_STANDING,
  PENDING_REQUEST,
  PENDING_ROWS,
  REVOKED_STANDING,
  SPARSE_REQUEST,
  TASK_REQUEST,
} from "./fixtures.ts";
import {
  BROKEN_RULES_TEXT,
  decisionPreview,
  EMPTY_RULES_TEXT,
  RULES_TEXT,
  rulesFile,
} from "./rules-fixtures.ts";

/**
 * The preview harness's stories: every component in every state the
 * acceptance criteria name, plus a few extra edge states. A story is pure
 * data plus a render function over fixture props.
 */

/** The six states every component must render in (D4a acceptance criteria). */
export const REQUIRED_STATES = [
  "pending",
  "approved",
  "denied",
  "expired",
  "paused",
  "error",
] as const;
export type RequiredState = (typeof REQUIRED_STATES)[number];

export const COMPONENTS = [
  { id: "approval-request", name: "ApprovalRequest" },
  { id: "pending-list", name: "PendingList" },
  { id: "pause-control", name: "PauseControl" },
  { id: "standing-approvals", name: "StandingApprovalList" },
  { id: "sign-in-oidc", name: "Sign-in (OIDC)" },
  { id: "sign-in-passkey", name: "Sign-in (passkey)" },
] as const;
/**
 * Whole pages beyond the six-state components: each in the states it really
 * has (fresh, busy, needs you, empty), not the approval lifecycle.
 */
export const PAGES = [
  { id: "home", name: "Home" },
  { id: "activity", name: "Activity" },
  { id: "agents", name: "Agents" },
  { id: "connections", name: "Connections" },
  { id: "devices", name: "Devices" },
  { id: "grants", name: "Grants" },
  { id: "people", name: "People" },
  { id: "modes", name: "Modes" },
  { id: "rules", name: "Rules" },
  { id: "rule-history", name: "Rule history" },
  { id: "welcome", name: "Welcome" },
  { id: "enroll", name: "Enroll" },
  { id: "connect", name: "Connect an app (OAuth)" },
] as const;
export type ComponentId = (typeof COMPONENTS)[number]["id"] | (typeof PAGES)[number]["id"];

export interface Story {
  component: ComponentId;
  /** A required state, or an extra edge state such as `org-ask`. */
  state: RequiredState | string;
  /**
   * What this state means for the component. For components without an
   * approval lifecycle (pause, standing, rules, sign-in) a required state maps
   * to its nearest meaning there, and the label says which.
   */
  label: string;
  title: string;
  viewer: Viewer | null;
  current?: NavId;
  pause?: PauseNotice | null;
  /** A focus page (the agent consent screen): no header or tabs. */
  focus?: boolean;
  body: () => Html;
}

/** Preview handlers only announce what would start; none of them decides anything. */
export const PREVIEW_CEREMONY = {
  decide: { handler: "decide" },
  resume: { handler: "resume" },
  signIn: { handler: "signIn" },
} as const satisfies Record<string, CeremonyCallback>;

export const PREVIEW_CEREMONY_SCRIPT = `
(() => {
  const announce = ({ intent, binding, options, status }) => {
    if (status) status.textContent = "Preview: the " + intent + " passkey ceremony would start here, bound to " + JSON.stringify(binding) + (Object.keys(options).length ? " with " + JSON.stringify(options) : "") + ". Nothing was decided.";
  };
  const names = ["decide", "resume", "signIn", "addDevice", "applyRules", "approveConnection", "connect", "enroll", "grant", "manageAccount", "manageAgent", "managePeople", "mode", "saveRules"];
  window.heelCeremony = Object.fromEntries(names.map((name) => [name, announce]));
  ${MENU_RESET_SCRIPT}
})();
`;

const ALICE: Viewer = { name: "alice", role: "member", csrfToken: "preview" };
const ADMIN: Viewer = { name: "dana", role: "admin", csrfToken: "preview" };

const form = (action: string): FormTarget => ({ action, csrfToken: "preview-csrf-token" });
const PAUSE_FORM = form("/pause");
const REVOKE_FORM = form("/standing/revoke");
const LOAD_ERROR = "The store didn't answer within 5 seconds (SQLITE_BUSY).";

const approval = (
  state: string,
  label: string,
  request: Parameters<typeof approvalRequest>[0]["load"],
  pause: PauseNotice | null = null,
  viewer: Viewer = ALICE,
  extra: Partial<Parameters<typeof approvalRequest>[0]> = {},
): Story => ({
  component: "approval-request",
  state,
  label,
  title: "Approval request",
  viewer,
  current: "approvals",
  pause,
  body: () =>
    approvalRequest({
      now: NOW,
      load: request,
      pause,
      onDecide: PREVIEW_CEREMONY.decide,
      ...extra,
    }),
});
const pending = (
  state: RequiredState,
  label: string,
  load: Parameters<typeof pendingList>[0]["load"],
  pause: PauseNotice | null = null,
): Story => ({
  component: "pending-list",
  state,
  label,
  title: "Approvals",
  viewer: ALICE,
  current: "approvals",
  pause,
  body: () => pendingList({ now: NOW, load }),
});

const pauseStory = (
  state: RequiredState,
  label: string,
  props: Omit<Parameters<typeof pauseControl>[0], "pauseForm" | "onResume">,
): Story => ({
  component: "pause-control",
  state,
  label,
  title: "Pause",
  viewer: ADMIN,
  current: "pause",
  pause: null,
  body: () => pauseControl({ ...props, pauseForm: PAUSE_FORM, onResume: PREVIEW_CEREMONY.resume }),
});

const pauseLoad = (active: typeof ACTIVE_PAUSES) =>
  ({
    ok: true,
    active,
    agents: PAUSE_AGENTS,
    accounts: PAUSE_ACCOUNTS,
    canPauseAll: true,
  }) as const;

const standingStory = (
  state: RequiredState,
  label: string,
  load: Parameters<typeof standingApprovalList>[0]["load"],
  pause: PauseNotice | null = null,
): Story => ({
  component: "standing-approvals",
  state,
  label,
  title: "Standing approvals",
  viewer: ALICE,
  current: "standing",
  pause,
  body: () => standingApprovalList({ now: NOW, load, revokeForm: REVOKE_FORM }),
});

const oidc = (
  state: RequiredState,
  label: string,
  notice: Parameters<typeof oidcSignIn>[0]["notice"],
): Story => ({
  component: "sign-in-oidc",
  state,
  label,
  title: "Sign in",
  viewer: null,
  // Set on purpose for the `paused` story: the page must not show it.
  pause: state === "paused" ? AGENT_PAUSE : null,
  body: () => oidcSignIn({ providerName: "Acme SSO", startHref: "/auth/oidc/start", notice }),
});

const passkey = (
  state: string,
  label: string,
  notice: Parameters<typeof passkeySignIn>[0]["notice"],
  enrolled = true,
): Story => ({
  component: "sign-in-passkey",
  state,
  label,
  title: "Sign in",
  viewer: null,
  pause: state === "paused" ? AGENT_PAUSE : null,
  body: () =>
    passkeySignIn({
      onSignIn: PREVIEW_CEREMONY.signIn,
      challengeId: "chl_preview01",
      enrolled,
      notice,
    }),
});

export const STORIES: readonly Story[] = [
  // ApprovalRequest
  approval("pending", "Waiting for a decision", { ok: true, request: PENDING_REQUEST }),
  approval("approved", "Approved, waiting for the agent to re-send", {
    ok: true,
    request: APPROVED_REQUEST,
  }),
  approval("denied", "Denied", { ok: true, request: DENIED_REQUEST }),
  approval("expired", "Expired before a decision", { ok: true, request: EXPIRED_REQUEST }),
  approval(
    "paused",
    "Pending while its agent is paused",
    { ok: true, request: PENDING_REQUEST },
    AGENT_PAUSE,
  ),
  approval("hints", "With hints from an approval adapter", { ok: true, request: HINTED_REQUEST }),
  approval("hints-unavailable", "Hints unavailable", {
    ok: true,
    request: HINTS_UNAVAILABLE_REQUEST,
  }),
  approval("merge", "A GitHub merge, with the agent's reason", {
    ok: true,
    request: MERGE_REQUEST,
  }),
  approval("generic", "A tool with no dedicated view", { ok: true, request: GENERIC_REQUEST }),
  approval("http", "An HTTP proxy write, body decoded", { ok: true, request: HTTP_REQUEST }),
  approval("error", "The request couldn't be loaded", { ok: false, message: LOAD_ERROR }),
  approval("executed", "Ran once", { ok: true, request: EXECUTED_REQUEST }),
  approval("draft", "An email draft, as in the owner's report", {
    ok: true,
    request: DRAFT_REQUEST,
  }),
  approval("draft-denied", "The same draft, denied", { ok: true, request: DENIED_DRAFT_REQUEST }),
  approval("task", "Step 3 of a longer task (run_code), waiting", {
    ok: true,
    request: TASK_REQUEST,
  }),
  approval(
    "task-background",
    "Step 3 of a background task, waiting",
    { ok: true, request: TASK_REQUEST },
    null,
    ALICE,
    { background: true },
  ),
  approval("long-email", "Forty-one recipients, a long subject and body", {
    ok: true,
    request: LONG_EMAIL_REQUEST,
  }),
  // Design variant B: the email header as one labelled row per field.
  approval(
    "draft-rows",
    "Variant B: the draft with one labelled row per field",
    { ok: true, request: DRAFT_REQUEST },
    null,
    ALICE,
    { emailLayout: "rows" },
  ),
  approval(
    "pending-rows",
    "Variant B: the send with one labelled row per field",
    { ok: true, request: PENDING_REQUEST },
    null,
    ALICE,
    { emailLayout: "rows" },
  ),
  approval("sparse", "A tool call with many empty fields", { ok: true, request: SPARSE_REQUEST }),
  approval("long-reason", "A 50-word reason and a long agent name", {
    ok: true,
    request: LONG_REASON_REQUEST,
  }),
  approval(
    "details-open",
    "Details open, Technical closed",
    { ok: true, request: DRAFT_REQUEST },
    null,
    ALICE,
    { folds: new Map([["details", true]]) },
  ),
  approval(
    "approved-after",
    "Variant B: approved, then one offer to ask less next time (needs a backend change)",
    { ok: true, request: APPROVED_REQUEST },
    null,
    ALICE,
    { allowAgain: "after" },
  ),
  approval(
    "pending-after",
    "Variant B: pending, Approve once only",
    { ok: true, request: PENDING_REQUEST },
    null,
    ALICE,
    { allowAgain: "after" },
  ),
  approval(
    "org-ask",
    "Org ask: approve once only",
    { ok: true, request: ORG_REQUEST },
    null,
    ADMIN,
  ),

  // PendingList
  pending("pending", "Requests waiting", { ok: true, rows: PENDING_ROWS }),
  pending("approved", "Approved and executed requests", { ok: true, rows: APPROVED_ROWS }),
  pending("denied", "A denied request", { ok: true, rows: DENIED_ROWS }),
  pending("expired", "An expired request", { ok: true, rows: EXPIRED_ROWS }),
  pending("paused", "Requests under a pause", { ok: true, rows: PAUSED_ROWS }, AGENT_PAUSE),
  pending("error", "The list couldn't be loaded", { ok: false, message: LOAD_ERROR }),
  { ...pending("pending", "", { ok: true, rows: [] }), state: "empty", label: "Nothing waiting" },

  // PauseControl
  pauseStory("pending", "Nothing paused: pause is one tap", {
    outcome: { kind: "none" },
    load: pauseLoad([]),
  }),
  pauseStory("approved", "Resume approved with a passkey", {
    outcome: { kind: "resumed", scope: "account", target: "gmail-work" },
    load: pauseLoad(ACTIVE_PAUSES),
  }),
  pauseStory("denied", "Resume refused: passkey check failed", {
    outcome: {
      kind: "resume-refused",
      scope: "agent",
      target: "inbox-bot",
      reason: "the passkey wasn't recognised.",
    },
    load: pauseLoad(ACTIVE_PAUSES),
  }),
  pauseStory("expired", "Resume challenge expired", {
    outcome: { kind: "challenge-expired", scope: "agent", target: "inbox-bot" },
    load: pauseLoad(ACTIVE_PAUSES),
  }),
  pauseStory("paused", "Paused: resume needs a passkey", {
    outcome: { kind: "paused", scope: "agent", target: "inbox-bot" },
    load: pauseLoad(ACTIVE_PAUSES),
  }),
  pauseStory("error", "Pause state couldn't be loaded", {
    outcome: { kind: "none" },
    load: { ok: false, message: LOAD_ERROR },
  }),

  // StandingApprovalList
  standingStory("pending", "None granted yet", { ok: true, rows: [] }),
  standingStory("approved", "Active standing approvals", { ok: true, rows: ACTIVE_STANDING }),
  standingStory("denied", "Revoked", { ok: true, rows: REVOKED_STANDING }),
  standingStory("expired", "Expired and lapsed", { ok: true, rows: EXPIRED_STANDING }),
  standingStory(
    "paused",
    "Active, under a pause",
    { ok: true, rows: PAUSED_STANDING },
    AGENT_PAUSE,
  ),
  standingStory("error", "Couldn't be loaded", { ok: false, message: LOAD_ERROR }),

  // RulesPage

  // Sign-in (OIDC)
  oidc("pending", "Waiting to sign in", { kind: "none" }),
  oidc("approved", "Signed out after a session", { kind: "signed-out" }),
  oidc("denied", "IdP refused the sign-in", {
    kind: "error",
    message: "Your account isn't in a group heel accepts. Ask an admin.",
  }),
  oidc("expired", "Session expired (12 h cap)", { kind: "session-expired" }),
  oidc("paused", "Signed out while an agent is paused: no pause shown", { kind: "none" }),
  oidc("error", "IdP unreachable", {
    kind: "error",
    message: "Acme SSO didn't respond. Try again in a minute.",
  }),

  // Sign-in (passkey)
  passkey("pending", "Waiting to sign in", { kind: "none" }),
  passkey("approved", "Signed out after a session", { kind: "signed-out" }),
  passkey("denied", "Passkey not recognised", {
    kind: "error",
    message: "That passkey isn't enrolled on this install.",
  }),
  passkey("expired", "Session expired", { kind: "session-expired" }),
  passkey("paused", "Signed out while an agent is paused: no pause shown", { kind: "none" }),
  passkey("error", "Ceremony failed", {
    kind: "error",
    message: "The browser cancelled the passkey check.",
  }),
  passkey("not-enrolled", "First run: no passkey enrolled", { kind: "none" }, false),
];

// ── Pages ───────────────────────────────────────────────────────────────────

const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const midnight = (daysBack: number) => {
  const d = new Date(NOW.getTime() - daysBack * DAY);
  d.setUTCHours(0, 0, 0, 0);
  return d;
};
const week = (calls: readonly number[]): DayCount[] =>
  calls.map((n, i) => ({
    day: midnight(calls.length - 1 - i),
    calls: n,
    allowed: Math.round(n * 0.7),
    denied: Math.round(n * 0.1),
    asked: n - Math.round(n * 0.7) - Math.round(n * 0.1),
  }));

const HOME_BASE: HomeProps = {
  now: NOW,
  approvals: { waiting: 0, decided: 4 },
  agents: { total: 3, active: 2, expiring: 0 },
  connections: { total: 4, needsSignIn: 0 },
  rules: { loaded: true, count: 12, stopped: 2 },
  setup: { passkey: true, notifications: true, account: true, agent: true },
  days: week([4, 9, 3, 12, 7, 15, 6]),
  recent: [
    {
      at: ago(4 * 60_000),
      agent: "inbox-bot",
      kind: "allow",
      action: "email.label",
      tool: "gmail_label",
      account: "gmail-work",
    },
    {
      at: ago(12 * 60_000),
      agent: "inbox-bot",
      kind: "ask",
      action: "email.send",
      tool: "gmail_send",
      account: "gmail-work",
    },
    {
      at: ago(40 * 60_000),
      agent: "ci-bot",
      kind: "deny",
      action: "github.merge",
      tool: "merge_pull_request",
      account: "github",
    },
    {
      at: ago(2 * 3_600_000),
      agent: "inbox-bot",
      kind: "approved",
      action: "email.send",
      tool: "gmail_send",
      account: "gmail-work",
    },
    {
      at: ago(5 * 3_600_000),
      agent: "cal-bot",
      kind: "would_deny",
      action: "calendar.delete",
      tool: "delete_event",
      account: "calendar",
    },
  ],
};

const pageStory = (
  component: ComponentId,
  state: string,
  label: string,
  title: string,
  current: NavId | undefined,
  body: () => Html,
  viewer: Viewer | null = ADMIN,
): Story => ({
  component,
  state,
  label,
  title,
  viewer,
  ...(current ? { current } : {}),
  body,
});

/** A focus page story: signed in, with no header or tabs. */
const focusStory = (...args: Parameters<typeof pageStory>): Story => ({
  ...pageStory(...args),
  focus: true,
});

let auditId = 100;
const audit = (
  at: Date,
  kind: ActivityRow["kind"],
  agentId: string,
  account: string,
  action: string | null,
  tool: string,
  extra: Partial<ActivityRow> = {},
): ActivityRow => ({
  id: auditId--,
  orgId: "org_1",
  at,
  kind,
  agentId,
  ownerId: "usr_dana",
  runId: null,
  scriptId: null,
  surface: "mcp",
  account,
  provider: account.startsWith("github") ? "github" : "gmail",
  tool,
  action,
  args: {},
  callHash: "h",
  rule: { name: "client-sends-ask", file: "rules/dana.yaml", line: 14 },
  approvalId: null,
  standingApprovalId: null,
  approverId: null,
  pauseScope: null,
  reason: null,
  mode: null,
  adapter: null,
  ...extra,
});

const AGENT_NAMES = [
  { id: "agt_inbox", name: "inbox-bot" },
  { id: "agt_ci", name: "ci-bot" },
  { id: "agt_cal", name: "cal-bot" },
];

const ACTIVITY_ROWS: ActivityRow[] = [
  audit(ago(3 * 60_000), "allow", "agt_inbox", "gmail-work", "email.label", "gmail_label", {
    rule: { name: "label-allow", file: "rules/dana.yaml", line: 34 },
  }),
  audit(ago(12 * 60_000), "ask", "agt_inbox", "gmail-work", "email.send", "gmail_send", {
    approvalId: "apr_7QxK2mN4pR8s",
  }),
  audit(ago(40 * 60_000), "deny", "agt_ci", "github", "github.merge", "merge_pull_request", {
    rule: null,
    reason: "No rule matched, so heel denied it.",
  }),
  audit(ago(26 * 3_600_000), "approved", "agt_inbox", "gmail-work", "email.send", "gmail_send", {
    approverId: "usr_dana",
  }),
  audit(
    ago(27 * 3_600_000),
    "would_deny",
    "agt_cal",
    "calendar",
    "calendar.delete",
    "delete_event",
    { mode: "shadow", rule: { name: "no-deletes", file: "rules/dana.yaml", line: 40 } },
  ),
  audit(ago(3 * DAY), "paused", "agt_inbox", "gmail-work", "email.send", "gmail_send", {
    pauseScope: "agent",
    rule: null,
  }),
  audit(ago(4 * DAY), "expired", "agt_ci", "github", "github.merge", "merge_pull_request"),
];

const activity = (
  state: string,
  label: string,
  rows: readonly ActivityRow[],
  filter: Parameters<typeof activityPage>[0]["filter"] = {},
) =>
  pageStory("activity", state, label, "Activity", "activity", () =>
    activityPage({
      rows,
      agents: AGENT_NAMES,
      accounts: ["gmail-work", "github", "calendar"],
      now: NOW,
      filter,
      nextBefore: rows.length > 5 ? 90 : null,
      hidden: null,
      suggestions: [],
      canExport: true,
    }),
  );

const agentActivity = (
  agentId: string,
  name: string,
  over: Partial<AgentActivity> = {},
): AgentActivity => ({
  agentId,
  name,
  owner: "dana",
  ownerId: "usr_dana",
  revoked: false,
  lastCallAt: ago(12 * 60_000),
  calls: 42,
  allowed: 33,
  denied: 4,
  asked: 5,
  wouldHaveStopped: 0,
  accounts: ["gmail-work"],
  ...over,
});

const AGENTS: AgentActivity[] = [
  agentActivity("agt_inbox", "inbox-bot"),
  agentActivity("agt_ci", "ci-bot", {
    calls: 7,
    allowed: 5,
    denied: 2,
    asked: 0,
    accounts: ["github"],
  }),
  agentActivity("agt_cal", "cal-bot", {
    calls: 3,
    allowed: 1,
    denied: 0,
    asked: 0,
    wouldHaveStopped: 2,
    accounts: ["calendar"],
  }),
  agentActivity("agt_old", "old-scraper", {
    revoked: true,
    lastCallAt: ago(30 * DAY),
    calls: 0,
    allowed: 0,
    denied: 0,
    asked: 0,
    accounts: [],
  }),
];

const agents = (
  state: string,
  label: string,
  list: readonly AgentActivity[],
  extra: Partial<Parameters<typeof agentsPage>[0]> = {},
) =>
  pageStory("agents", state, label, "Agents", "agents", () =>
    agentsPage({
      agents: list,
      sinceHours: 24,
      now: NOW,
      manage: {
        csrfToken: "preview",
        viewerId: "usr_dana",
        admin: true,
        workRoots: new Map([["agt_inbox", ["/home/dana/projects/inbox"]]]),
        done: null,
      },
      tokens: new Map<string, Date | "never" | null>([
        ["agt_inbox", new Date(NOW.getTime() + 60 * DAY)],
        ["agt_ci", new Date(NOW.getTime() + 5 * DAY)],
        ["agt_cal", "never"],
        ["agt_old", null],
      ]),
      ...extra,
    }),
  );

const conn = (
  alias: string,
  provider: string,
  over: Partial<ConnectionRow> = {},
): ConnectionRow => ({
  alias,
  provider,
  status: "active",
  signsIn: false,
  setup: null,
  lastUsedAt: ago(3 * 3_600_000),
  ...over,
});

const CONNECTIONS: ConnectionRow[] = [
  conn("gmail-work", "gmail", { signsIn: true }),
  conn("calendar", "google-calendar", { signsIn: true, status: "reconnect_required" }),
  conn("outlook", "outlook-mail", {
    signsIn: true,
    status: "reconnect_required",
    lastUsedAt: null,
    setup: {
      label: "Microsoft",
      configKey: "providers.microsoft",
      docsUrl: "https://useheel.dev/docs/configuration",
    },
  }),
  conn("github", "github"),
  conn("stripe", "http", { holdsKey: true, status: "reconnect_required" }),
];

const connections = (
  state: string,
  label: string,
  rows: readonly ConnectionRow[],
  outcome: Parameters<typeof connectionsPage>[0]["outcome"] = { kind: "none" },
) =>
  pageStory("connections", state, label, "Connections", "connections", () =>
    connectionsPage({
      rows,
      outcome,
      signInForm: form("/connections/sign-in"),
      now: NOW,
      manage: { csrfToken: "preview", people: ["alice", "bo"], admin: true },
    }),
  );

const devices = (state: string, label: string, count: number, turnedOff: number | null) =>
  pageStory(
    "devices",
    state,
    label,
    "Devices",
    "devices",
    () =>
      html`<h1>Devices</h1>
      ${pushControl({
        vapidPublicKey: "BPreviewVapidKey",
        devices: { count, turnOff: form("/push/unsubscribe-all"), turnedOff },
      })}
      ${addDeviceControl()}`,
  );

const grant = (
  id: string,
  agent: string,
  task: string,
  state: GrantView["state"],
  hours: number,
): GrantView => ({
  id,
  agent,
  task,
  match: "email.send to vendor.com",
  createdBy: "dana",
  createdAt: ago(2 * 3_600_000),
  expiresAt: new Date(NOW.getTime() + hours * 3_600_000),
  state,
});

const grants = (
  state: string,
  label: string,
  list: readonly GrantView[],
  outcome: Parameters<typeof grantsPage>[0]["outcome"] = { kind: "none" },
) =>
  pageStory("grants", state, label, "Grants", "grants", () =>
    grantsPage({
      grants: list,
      agents: AGENT_NAMES,
      outcome,
      revoke: form("/grants/revoke"),
      now: NOW,
    }),
  );

const PEOPLE = [
  {
    id: "usr_dana",
    name: "dana",
    role: "admin" as const,
    email: "dana@example.com",
    disabled: false,
    passkeys: 2,
  },
  {
    id: "usr_alice",
    name: "alice",
    role: "member" as const,
    email: null,
    disabled: false,
    passkeys: 1,
  },
  {
    id: "usr_bo",
    name: "bo",
    role: "member" as const,
    email: "bo@example.com",
    disabled: true,
    passkeys: 0,
  },
];

const MODES: ModeRow[] = [
  { ownerId: "", label: "Everyone (org default)", mode: "enforce", effective: "enforce" },
  { ownerId: "usr_dana", label: "dana", mode: null, effective: "enforce" },
  { ownerId: "usr_alice", label: "alice", mode: "shadow", effective: "shadow" },
];

const CHANGE_DIFF =
  "--- rules/dana.yaml\n+++ rules/dana.yaml\n@@\n   - name: label-allow\n+  - name: vendor-sends-ask\n+    when: { action: email.send, to_domain: vendor.com }\n+    then: ask\n";

const history = (
  state: string,
  label: string,
  changes: Parameters<typeof ruleHistoryPage>[0]["changes"],
) =>
  pageStory("rule-history", state, label, "Rule history", "rule-history", () =>
    ruleHistoryPage({ changes, now: NOW, everyone: true }),
  );

const CONNECT_REQUEST = {
  clientId: "cli_preview",
  redirectUri: "https://claude.ai/api/mcp/auth_callback",
  codeChallenge: "challenge",
  state: "state",
  resource: "https://heel.example.com/mcp",
};

const rulesEditor = (
  state: string,
  label: string,
  props: Partial<Parameters<typeof rulesEditorPage>[0]>,
): Story =>
  pageStory("rules", state, label, "Rules", "rules", () =>
    rulesEditorPage({
      file: rulesFile(RULES_TEXT),
      preview: null,
      problem: null,
      saved: null,
      csrfToken: "csrf_preview",
      ...props,
    }),
  );

export const PAGE_STORIES: readonly Story[] = [
  // Home
  pageStory("home", "fresh", "Fresh install: 1 of 4 set up, no calls yet", "Home", "home", () =>
    homePage({
      ...HOME_BASE,
      approvals: { waiting: 0, decided: 0 },
      agents: { total: 0, active: 0, expiring: 0 },
      connections: { total: 0, needsSignIn: 0 },
      rules: { loaded: true, count: 0, stopped: 0 },
      setup: { passkey: true, notifications: false, account: false, agent: false },
      days: week([0, 0, 0, 0, 0, 0, 0]),
      recent: [],
    }),
  ),
  pageStory("home", "busy", "All set up, a week of calls", "Home", "home", () =>
    homePage(HOME_BASE),
  ),
  pageStory(
    "home",
    "needs-you",
    "Waiting requests, an expiring token, a sign-in, rules didn't load",
    "Home",
    "home",
    () =>
      homePage({
        ...HOME_BASE,
        approvals: { waiting: 3, decided: 4 },
        agents: { total: 3, active: 2, expiring: 1 },
        connections: { total: 4, needsSignIn: 1 },
        rules: { loaded: false, count: 12, stopped: 0 },
      }),
  ),

  // Activity
  activity("busy", "Today, yesterday and older, every kind of decision", ACTIVITY_ROWS),
  activity("filtered-empty", "A filter with no matches", [], {
    agent: "agt_ci",
    kind: "would_ask",
  }),
  activity("empty", "No calls yet", []),

  // Agents
  agents("busy", "Agents incl. a revoked one and an expiring token", AGENTS),
  agents("scripts", "Background scripts running and waiting", AGENTS, {
    scripts: [
      {
        id: "scr_1",
        agentName: "inbox-bot",
        status: "running",
        approvalId: null,
        calls: 14,
        startedAt: ago(6 * 60_000),
        stop: form("/agents/scripts/scr_1/stop"),
      },
      {
        id: "scr_2",
        agentName: "ci-bot",
        status: "parked",
        approvalId: "apr_Org9fT3kLw2",
        calls: 3,
        startedAt: ago(20 * 60_000),
        stop: form("/agents/scripts/scr_2/stop"),
      },
    ],
  }),
  agents("empty", "No agents yet", []),

  // Connections
  connections("mixed", "Ready, needs sign-in, set up first, needs a new key", CONNECTIONS),
  connections("connected", "Just signed in", CONNECTIONS.slice(0, 1), {
    kind: "connected",
    alias: "gmail-work",
  }),
  connections("empty", "Nothing connected yet", []),

  // Devices
  devices("none", "No device gets notifications", 0, null),
  devices("several", "Three devices get notifications", 3, null),
  devices("turned-off", "Just turned off on every device", 0, 3),

  // Grants
  grants("busy", "Live, expired and revoked grants", [
    grant("grt_1", "inbox-bot", "Send the Q3 numbers to the vendor", "live", 20),
    grant("grt_2", "ci-bot", "Merge the release PR", "expired", -2),
    grant("grt_3", "inbox-bot", "Archive old newsletters", "revoked", 5),
  ]),
  grants(
    "granted",
    "Just granted",
    [grant("grt_1", "inbox-bot", "Send the Q3 numbers to the vendor", "live", 20)],
    { kind: "granted" },
  ),
  grants("empty", "No grants", []),

  // People
  pageStory("people", "admin", "An admin sees everyone", "People", "people", () =>
    peoplePage({
      people: PEOPLE,
      viewerId: "usr_dana",
      admin: true,
      teamSignIn: false,
      saved: false,
    }),
  ),
  pageStory(
    "people",
    "member",
    "A member sees only themselves",
    "People",
    "people",
    () =>
      peoplePage({
        people: PEOPLE.slice(1, 2),
        viewerId: "usr_alice",
        admin: false,
        teamSignIn: false,
        saved: false,
      }),
    ALICE,
  ),
  pageStory("people", "saved", "Just saved", "People", "people", () =>
    peoplePage({
      people: PEOPLE,
      viewerId: "usr_dana",
      admin: true,
      teamSignIn: false,
      saved: true,
    }),
  ),

  // Modes
  pageStory("modes", "mixed", "Org enforces, one person watches", "Modes", "modes", () =>
    modesPage({
      rows: MODES,
      outcome: { kind: "none" },
      tighten: form("/modes/tighten"),
      watchFallback: false,
    }),
  ),
  pageStory("modes", "switched", "Just switched someone to Enforce", "Modes", "modes", () =>
    modesPage({
      rows: MODES,
      outcome: { kind: "switched", ownerId: "usr_alice", label: "alice", mode: "enforce" },
      tighten: form("/modes/tighten"),
      watchFallback: false,
    }),
  ),

  // Rules
  rulesEditor("loaded", "Rules load: three rules and a hide entry", {}),
  rulesEditor("problems", "The file has problems: last good rules still decide", {
    file: rulesFile(BROKEN_RULES_TEXT),
  }),
  rulesEditor("empty", "No rules yet: every call is refused", {
    file: rulesFile(EMPTY_RULES_TEXT),
  }),
  rulesEditor("preview", "Before you save: a decision changed, with the diff", {
    preview: decisionPreview(),
  }),
  rulesEditor("saved", "Saved and in use", { saved: "live" }),
  rulesEditor("saved-pending", "Saved, but another rules file keeps it from loading", {
    saved: "pending",
  }),
  rulesEditor("unavailable", "heel can't edit rules files from here", { file: null }),
  // Rule history
  history("busy", "Changes from a proposal, the web and outside heel", [
    {
      id: "rc_1",
      file: "rules/dana.yaml",
      at: ago(2 * 3_600_000),
      source: "proposal",
      agent: "inbox-bot",
      origin: "agent",
      proposalId: "prp_1",
      decidedBy: "dana",
      diff: CHANGE_DIFF,
    },
    {
      id: "rc_2",
      file: "rules/dana.yaml",
      at: ago(DAY),
      source: "web",
      agent: null,
      origin: null,
      proposalId: null,
      decidedBy: "dana",
      diff: CHANGE_DIFF,
    },
    {
      id: "rc_3",
      file: "rules/org.yaml",
      at: ago(3 * DAY),
      source: "outside",
      agent: null,
      origin: null,
      proposalId: null,
      decidedBy: null,
      diff: CHANGE_DIFF,
    },
  ]),
  history("empty", "No changes yet", []),

  // Welcome
  pageStory("welcome", "new", "Right after enrolling a passkey", "Welcome", "home", () =>
    welcomePage({ vapidPublicKey: "BPreviewVapidKey", devices: 0 }),
  ),

  // Enroll (signed out: the brand shell)
  pageStory(
    "enroll",
    "open",
    "A live one-time link",
    "Enroll a passkey",
    undefined,
    () => enrollPage({ kind: "open", token: "enr_preview", userName: "alice" }),
    null,
  ),
  pageStory(
    "enroll",
    "waiting",
    "A recovery link that works later",
    "Enroll a passkey",
    undefined,
    () =>
      enrollPage({
        kind: "waiting",
        userName: "alice",
        until: new Date(NOW.getTime() + 20 * 3_600_000),
      }),
    null,
  ),
  pageStory(
    "enroll",
    "invalid",
    "Used, unknown or expired link",
    "Enroll a passkey",
    undefined,
    () => enrollPage({ kind: "invalid" }),
    null,
  ),

  // Connect an app (OAuth consent)
  focusStory(
    "connect",
    "ask",
    "An AI app asks to connect as an agent",
    "Connect an app",
    undefined,
    () =>
      connectPage({
        kind: "ask",
        clientName: "Claude",
        redirectHost: "claude.ai",
        agentName: "claude-connector",
        newAgent: true,
        request: CONNECT_REQUEST,
        declineHref: "https://claude.ai/api/mcp/auth_callback?error=access_denied",
      }),
  ),
  focusStory("connect", "invalid", "A broken connect link", "Connect an app", undefined, () =>
    connectPage({
      kind: "invalid",
      message: "The redirect address isn't registered for this app.",
    }),
  ),
];

/** Every story the harness serves: components, then pages. */
export const ALL_STORIES: readonly Story[] = [...STORIES, ...PAGE_STORIES];

export function findStory(component: string, state: string): Story | undefined {
  return ALL_STORIES.find((s) => s.component === component && s.state === state);
}

/** A story as the full page the human plane would send. */
export function renderStory(story: Story, theme: Theme): Html {
  return page({
    title: story.title,
    viewer: story.viewer,
    ...(story.current ? { current: story.current } : {}),
    ...(story.focus ? { focus: true } : {}),
    pause: story.pause ?? null,
    theme,
    body: story.body(),
    script: PREVIEW_CEREMONY_SCRIPT,
  });
}
