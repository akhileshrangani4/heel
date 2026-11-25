import { lineDiff } from "../../../drafting/draft.ts";
import { applyEdit, rulesCheck, textHash, viewRules } from "../../../proposals/edit.ts";
import type { AgentActivity } from "../../../store/activity.ts";
import { agentsPage } from "../activity-page.ts";
import type { CeremonyCallback } from "../ceremony.ts";
import { addDeviceControl } from "../devices.ts";
import { type GrantView, grantsPage } from "../grants-page.ts";
import { type Html, html } from "../html.ts";
import type { FormTarget, NavId, Viewer } from "../layout.ts";
import { type ModeRow, modesPage } from "../modes-page.ts";
import { type ActivePause, pauseControl } from "../pause-control.ts";
import { peoplePage } from "../people.ts";
import { pushControl } from "../push-control.ts";
import { ruleHistoryPage } from "../rule-history.ts";
import { type RulesPreview, rulesEditorPage } from "../rules-editor.ts";
import { type StandingRow, standingApprovalList } from "../standing-approval-list.ts";
import { NOW } from "./fixtures.ts";
import { RULES_DISPLAY, RULES_TEXT, rulesFile } from "./rules-fixtures.ts";
import type { ComponentId, Story } from "./stories.ts";

/**
 * Edge states for the settings pages (Rules, Agents, Pause, Devices, People,
 * Modes, Grants, Standing approvals): the longest names heel accepts, many
 * rows, a big rules file, and the outcomes the main stories skip. Layout bugs
 * hide in these, so the browser tests check each one at phone widths.
 */

const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const ADMIN: Viewer = { name: "dana", role: "admin", csrfToken: "preview" };
const form = (action: string): FormTarget => ({ action, csrfToken: "preview-csrf-token" });
const RESUME: CeremonyCallback = { handler: "resume" };

/** 64 characters: the longest agent or person name heel accepts. */
export const LONG_AGENT = "support-inbox-triage-agent-for-the-customer-success-team-eu-west";
export const LONG_ACCOUNT = "gmail-customer-success-shared-inbox-europe-west-1-production-acct";
const LONG_PERSON = "alexandria-catherine-montgomery-worthington-the-third-of-london";
const LONG_EMAIL =
  "alexandria.catherine.montgomery-worthington@customer-success.subsidiary.example.co.uk";
const LONG_PATH =
  "/home/alexandria/projects/customer-success/inbox-triage/workspaces/eu-west-1/production";

const story = (
  component: ComponentId,
  state: string,
  label: string,
  title: string,
  current: NavId,
  body: () => Html,
  viewer: Viewer = ADMIN,
): Story => ({ component, state, label, title, viewer, current, body });

const agent = (agentId: string, name: string, over: Partial<AgentActivity> = {}) => ({
  agentId,
  name,
  owner: "dana",
  ownerId: "usr_dana",
  revoked: false,
  lastCallAt: ago(12 * 60_000),
  calls: 1_204,
  allowed: 1_100,
  denied: 64,
  asked: 40,
  wouldHaveStopped: 0,
  accounts: [LONG_ACCOUNT, "github", "calendar"],
  ...over,
});

const pauses = (
  active: readonly ActivePause[],
  agents: readonly string[],
  accounts: readonly string[],
) =>
  pauseControl({
    outcome: { kind: "none" },
    load: { ok: true, active, agents, accounts, canPauseAll: true },
    pauseForm: form("/pause"),
    onResume: RESUME,
  });

const standingRow = (id: string, over: Partial<StandingRow> = {}): StandingRow => ({
  id,
  agent: LONG_AGENT,
  account: LONG_ACCOUNT,
  scope: "exact_call",
  rule: {
    name: "customer-success-sends-to-vendors-ask-first",
    file: "rules/alexandria-catherine-montgomery.yaml",
    line: 140,
  },
  covers: "email.send_with_attachments_to_external_recipients",
  createdBy: LONG_PERSON,
  createdAt: ago(3_600_000),
  expiresAt: new Date(NOW.getTime() + 5 * DAY),
  state: "active",
  revoked: null,
  paused: false,
  ...over,
});

const grantRow = (id: string, state: GrantView["state"], match: string): GrantView => ({
  id,
  agent: LONG_AGENT,
  task: "Send the Q3 numbers, the signed contract and the onboarding checklist to every vendor contact on the shared procurement list before Friday's review",
  match,
  createdBy: "dana",
  createdAt: ago(2 * 3_600_000),
  expiresAt: new Date(NOW.getTime() + 20 * 3_600_000),
  state,
});

/** A rule with a long match, a long name, and enough of them to need scrolling. */
const LONG_RULES_TEXT = `rules:
  - name: customer-success-sends-to-every-approved-vendor-domain-ask-first
    match:
      action: email.send
      recipients:
        all_domain_in: [vendor.com, supplier.example.co.uk, procurement.partner-network.example.org, logistics.example.net]
        max: 25
    then: ask
${Array.from(
  { length: 24 },
  (_, i) => `  - name: label-rule-${String(i + 1)}
    match: { action: email.label }
    then: ${i % 3 === 0 ? "allow" : i % 3 === 1 ? "ask" : "deny"}
`,
).join("")}`;

/** A preview of a change that would leave the file broken. */
function brokenPreview(): RulesPreview {
  const edit = { kind: "replace", text: RULES_TEXT.replace("then: deny", "then: maybe") } as const;
  const after = edit.text;
  return {
    edit,
    text: after,
    before: textHash(RULES_TEXT),
    after: textHash(after),
    diff: lineDiff(RULES_TEXT, after),
    ...rulesCheck(after, RULES_DISPLAY),
    trusted: true,
    unchanged: false,
    view: viewRules(after, RULES_DISPLAY),
  };
}

/** A change opened from a link, not the person's own Rules page: no Save. */
function untrustedPreview(): RulesPreview {
  const edit = { kind: "remove-rule", index: 0 } as const;
  const after = applyEdit(RULES_TEXT, edit);
  if (!after.ok) throw new Error(after.problem);
  return {
    edit,
    text: after.text,
    before: textHash(RULES_TEXT),
    after: textHash(after.text),
    diff: lineDiff(RULES_TEXT, after.text),
    ...rulesCheck(after.text, RULES_DISPLAY),
    trusted: false,
    unchanged: false,
    view: viewRules(after.text, RULES_DISPLAY),
  };
}

const LONG_DIFF = `--- rules/alexandria-catherine-montgomery-worthington.yaml\n+++ rules/alexandria-catherine-montgomery-worthington.yaml\n@@\n+ - name: customer-success-sends-to-every-approved-vendor-domain-ask-first\n+   match: { action: email.send, recipients: { all_domain_in: [vendor.com, supplier.example.co.uk, procurement.partner-network.example.org], max: 25 } }\n+   then: ask\n`;

export const SETTINGS_EDGE_STORIES: readonly Story[] = [
  // Agents
  story(
    "agents",
    "long-names",
    "A 64-character agent name and a long account alias",
    "Agents",
    "agents",
    () =>
      agentsPage({
        agents: [
          agent("agt_long", LONG_AGENT),
          agent("agt_rev", `${LONG_AGENT.slice(0, 60)}-old`, { revoked: true, lastCallAt: null }),
        ],
        sinceHours: 24,
        now: NOW,
        manage: {
          csrfToken: "preview",
          viewerId: "usr_dana",
          admin: true,
          workRoots: new Map([["agt_long", [LONG_PATH, "/srv/inbox"]]]),
          done: `Revoked ${LONG_AGENT}. Its tokens stopped working.`,
        },
        tokens: new Map<string, Date | "never" | null>([
          ["agt_long", new Date(NOW.getTime() + 3 * DAY)],
          ["agt_rev", null],
        ]),
      }),
  ),

  // Pause
  story(
    "pause-control",
    "long-names",
    "Long names, many accounts, one pause someone else owns",
    "Pause",
    "pause",
    () =>
      pauses(
        [
          { scope: "agent", target: LONG_AGENT, pausedBy: LONG_PERSON, pausedAt: ago(30 * 60_000) },
          {
            scope: "account",
            target: LONG_ACCOUNT,
            pausedBy: "alice",
            pausedAt: ago(3 * 3_600_000),
            canResume: false,
          },
          { scope: "provider", target: "google-workspace", pausedBy: "dana", pausedAt: ago(DAY) },
        ],
        [LONG_AGENT, "ci-bot", "cal-bot"],
        [LONG_ACCOUNT, ...Array.from({ length: 8 }, (_, i) => `account-${String(i + 1)}`)],
      ),
  ),
  story(
    "pause-control",
    "everything",
    "Everything paused: each row says so",
    "Pause",
    "pause",
    () =>
      pauses(
        [{ scope: "global", target: null, pausedBy: "dana", pausedAt: ago(10 * 60_000) }],
        ["inbox-bot", "ci-bot"],
        ["gmail-work", "github"],
      ),
  ),
  story("pause-control", "empty", "No agents or accounts yet", "Pause", "pause", () =>
    pauses([], [], []),
  ),

  // Standing approvals
  story(
    "standing-approvals",
    "long-names",
    "Long agent, account, rule and person names",
    "Standing approvals",
    "standing",
    () =>
      standingApprovalList({
        now: NOW,
        load: {
          ok: true,
          rows: [
            standingRow("sta_8Hn2Qp4Lr1"),
            standingRow("sta_Run9x2Lq7", {
              scope: "run",
              covers: "run_01JDX4K7M9Q2W8E5R3T6Y1U0IP",
              paused: true,
            }),
            standingRow("sta_Rv0k3d1Qa2", {
              state: "revoked",
              revoked: { by: LONG_PERSON, at: ago(15 * 60_000) },
            }),
          ],
        },
        revokeForm: form("/standing/revoke"),
      }),
  ),

  // Grants
  story(
    "grants",
    "long-names",
    "A long task, a long agent name and a match with no spaces",
    "Grants",
    "grants",
    () =>
      grantsPage({
        grants: [
          grantRow(
            "grt_1",
            "live",
            "{action:email.send,recipients:{all_domain_in:[vendor.com,supplier.example.co.uk,procurement.partner-network.example.org],max:25}}",
          ),
          grantRow("grt_2", "revoked", "{ action: email.send }"),
        ],
        agents: [{ id: "agt_long", name: LONG_AGENT }],
        outcome: { kind: "revoked" },
        revoke: form("/grants/revoke"),
        now: NOW,
      }),
  ),

  // People
  story(
    "people",
    "long-names",
    "A long name and email, with team sign-in",
    "People",
    "people",
    () =>
      peoplePage({
        people: [
          {
            id: "usr_dana",
            name: "dana",
            role: "admin",
            email: LONG_EMAIL,
            disabled: false,
            passkeys: 12,
          },
          {
            id: "usr_long",
            name: LONG_PERSON,
            role: "member",
            email: LONG_EMAIL,
            disabled: false,
            passkeys: 0,
          },
        ],
        viewerId: "usr_dana",
        admin: true,
        teamSignIn: true,
        saved: false,
      }),
  ),

  // Modes
  story(
    "modes",
    "watch-fallback",
    "Started with --watch, long names, a stricter org default",
    "Modes",
    "modes",
    () =>
      modesPage({
        rows: [
          { ownerId: "", label: "Everyone (org default)", mode: null, effective: "shadow" },
          { ownerId: "usr_long", label: LONG_PERSON, mode: "shadow", effective: "shadow" },
          { ownerId: "usr_bo", label: "bo", mode: "enforce", effective: "enforce" },
        ] satisfies ModeRow[],
        outcome: { kind: "switched", ownerId: "usr_long", label: LONG_PERSON, mode: "shadow" },
        tighten: form("/modes/tighten"),
        watchFallback: true,
      }),
  ),

  // Devices
  story(
    "devices",
    "one",
    "One device gets notifications",
    "Devices",
    "devices",
    () =>
      html`<h1>Devices</h1>
      ${pushControl({
        vapidPublicKey: "BPreviewVapidKey",
        devices: { count: 1, turnOff: form("/push/unsubscribe-all"), turnedOff: 1 },
      })}
      ${addDeviceControl()}`,
  ),

  // Rules
  story(
    "rules",
    "long",
    "A long rule, 25 rules, a long file name and a problem from the last try",
    "Rules",
    "rules",
    () =>
      rulesEditorPage({
        file: {
          display: "rules/alexandria-catherine-montgomery-worthington-the-third-of-london.yaml",
          text: LONG_RULES_TEXT,
          view: viewRules(LONG_RULES_TEXT, RULES_DISPLAY),
        },
        preview: null,
        problem:
          "That link is out of date: your rules file changed since it was made (rules/alexandria-catherine-montgomery-worthington-the-third-of-london.yaml).",
        saved: null,
        csrfToken: "csrf_preview",
      }),
  ),
  story(
    "rules",
    "preview-broken",
    "Before you save: the change wouldn't load",
    "Rules",
    "rules",
    () =>
      rulesEditorPage({
        file: rulesFile(RULES_TEXT),
        preview: brokenPreview(),
        problem: null,
        saved: null,
        csrfToken: "csrf_preview",
      }),
  ),
  story("rules", "preview-link", "A change opened from a link: no Save", "Rules", "rules", () =>
    rulesEditorPage({
      file: rulesFile(RULES_TEXT),
      preview: untrustedPreview(),
      problem: null,
      saved: null,
      csrfToken: "csrf_preview",
    }),
  ),
  story("rules", "preview-unchanged", "A change that changes nothing", "Rules", "rules", () =>
    rulesEditorPage({
      file: rulesFile(RULES_TEXT),
      preview: { ...untrustedPreview(), unchanged: true, trusted: true },
      problem: null,
      saved: null,
      csrfToken: "csrf_preview",
    }),
  ),

  // Rule history
  story(
    "rule-history",
    "long",
    "A long file name and long changed lines",
    "Rule history",
    "rule-history",
    () =>
      ruleHistoryPage({
        changes: [
          {
            id: "rc_1",
            file: "rules/alexandria-catherine-montgomery-worthington-the-third-of-london.yaml",
            at: ago(2 * 3_600_000),
            source: "proposal",
            agent: LONG_AGENT,
            origin: "heel",
            proposalId: "prp_1",
            decidedBy: LONG_PERSON,
            diff: lineDiff("rules: []\n", LONG_DIFF),
          },
        ],
        now: NOW,
        everyone: true,
      }),
  ),
];
