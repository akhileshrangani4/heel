import { approvalRequest } from "../approval-request.ts";
import type { CeremonyCallback } from "../ceremony.ts";
import type { Html } from "../html.ts";
import {
  type FormTarget,
  type NavId,
  type PauseNotice,
  page,
  type Theme,
  type Viewer,
} from "../layout.ts";
import { pauseControl } from "../pause-control.ts";
import { pendingList } from "../pending-list.ts";
import { rulesPage } from "../rules-page.ts";
import { oidcSignIn, passkeySignIn } from "../sign-in.ts";
import { standingApprovalList } from "../standing-approval-list.ts";
import {
  ACTIVE_PAUSES,
  ACTIVE_STANDING,
  AGENT_PAUSE,
  APPROVED_REQUEST,
  APPROVED_ROWS,
  DENIED_REQUEST,
  DENIED_ROWS,
  DRAFT_DIFF,
  DRAFT_PROMPT,
  EXECUTED_REQUEST,
  EXPIRED_REQUEST,
  EXPIRED_ROWS,
  EXPIRED_STANDING,
  FAILING_TESTS,
  NOW,
  ORG_REQUEST,
  PASSING_TESTS,
  PAUSE_ACCOUNTS,
  PAUSE_AGENTS,
  PAUSED_ROWS,
  PAUSED_STANDING,
  PENDING_REQUEST,
  PENDING_ROWS,
  REVOKED_STANDING,
  WATCH_ENTRIES,
} from "./fixtures.ts";

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
  { id: "rules-page", name: "RulesPage" },
  { id: "sign-in-oidc", name: "Sign-in (OIDC)" },
  { id: "sign-in-passkey", name: "Sign-in (passkey)" },
] as const;
export type ComponentId = (typeof COMPONENTS)[number]["id"];

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
  window.heelCeremony = { decide: announce, resume: announce, signIn: announce };
})();
`;

const ALICE: Viewer = { name: "alice", role: "member" };
const ADMIN: Viewer = { name: "dana", role: "admin" };

const form = (action: string): FormTarget => ({ action, csrfToken: "preview-csrf-token" });
const PAUSE_FORM = form("/pause");
const REVOKE_FORM = form("/standing/revoke");
const DRAFT_FORM = form("/rules/draft");
const SAVE_FORM = form("/rules/save");
const LOAD_ERROR = "The store didn't answer within 5 seconds (SQLITE_BUSY).";

const approval = (
  state: string,
  label: string,
  request: Parameters<typeof approvalRequest>[0]["load"],
  pause: PauseNotice | null = null,
  viewer: Viewer = ALICE,
): Story => ({
  component: "approval-request",
  state,
  label,
  title: "Approval request",
  viewer,
  current: "approvals",
  pause,
  body: () =>
    approvalRequest({ now: NOW, load: request, pause, onDecide: PREVIEW_CEREMONY.decide }),
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

const rulesStory = (
  state: string,
  label: string,
  load: Parameters<typeof rulesPage>[0]["load"],
  pause: PauseNotice | null = null,
): Story => ({
  component: "rules-page",
  state,
  label,
  title: "Rules",
  viewer: ALICE,
  current: "rules",
  pause,
  body: () =>
    rulesPage({ file: "rules/alice.yaml", load, draftForm: DRAFT_FORM, saveForm: SAVE_FORM }),
});

const VALID = { state: "valid", loadedAt: new Date(NOW.getTime() - 3_600_000) } as const;
const RELOAD_ERRORS = [
  {
    file: "rules/alice.yaml",
    line: 18,
    column: 7,
    message: "unknown key `recipient` in match (did you mean `recipients`?)",
  },
  {
    file: "rules/alice.yaml",
    line: 25,
    column: 11,
    message: "`then` must be one of allow, deny, ask",
  },
] as const;

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
  approval("error", "The request couldn't be loaded", { ok: false, message: LOAD_ERROR }),
  approval("executed", "Ran once", { ok: true, request: EXECUTED_REQUEST }),
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
  rulesStory("pending", "Valid rules, drafting box ready", {
    ok: true,
    validity: VALID,
    watch: WATCH_ENTRIES,
    drafting: { state: "idle" },
  }),
  rulesStory("approved", "Draft with every test passing", {
    ok: true,
    validity: VALID,
    watch: WATCH_ENTRIES,
    drafting: { state: "ready", prompt: DRAFT_PROMPT, diff: DRAFT_DIFF, tests: PASSING_TESTS },
  }),
  rulesStory("denied", "Draft with a failing test", {
    ok: true,
    validity: VALID,
    watch: WATCH_ENTRIES,
    drafting: { state: "ready", prompt: DRAFT_PROMPT, diff: DRAFT_DIFF, tests: FAILING_TESTS },
  }),
  rulesStory("expired", "Invalid edit: last good rules still deciding", {
    ok: true,
    validity: { state: "invalid-reload", errors: RELOAD_ERRORS, lastGoodAt: VALID.loadedAt },
    watch: [],
    drafting: { state: "idle" },
  }),
  rulesStory(
    "paused",
    "Rules page under a pause",
    { ok: true, validity: VALID, watch: WATCH_ENTRIES, drafting: { state: "off" } },
    AGENT_PAUSE,
  ),
  rulesStory("error", "No valid rules at boot; drafting model unreachable", {
    ok: true,
    validity: { state: "invalid-boot", errors: RELOAD_ERRORS },
    watch: [],
    drafting: {
      state: "error",
      prompt: DRAFT_PROMPT,
      message: "POST https://llm.internal/v1/chat/completions timed out after 30 s.",
    },
  }),
  rulesStory("load-error", "Rules state couldn't be loaded", { ok: false, message: LOAD_ERROR }),

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

export function findStory(component: string, state: string): Story | undefined {
  return STORIES.find((s) => s.component === component && s.state === state);
}

/** A story as the full page the human plane would send. */
export function renderStory(story: Story, theme: Theme): Html {
  return page({
    title: story.title,
    viewer: story.viewer,
    ...(story.current ? { current: story.current } : {}),
    pause: story.pause ?? null,
    theme,
    body: story.body(),
    script: PREVIEW_CEREMONY_SCRIPT,
  });
}
