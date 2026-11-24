import { compileRulesText } from "../../../config/rules.ts";
import { serviceActions } from "../../../requests/actions.ts";
import { coverage } from "../../../requests/coverage.ts";
import type { ConnectionRequestDetails } from "../../../store/schema.ts";
import type { ApprovalRequestView } from "../approval-request.ts";
import type { FormTarget } from "../layout.ts";
import type { ProposalCard, ProposalPageProps } from "../proposals.ts";
import type { RequestCard, RequestPageProps } from "../requests.ts";
import { NOW, PENDING_REQUEST } from "./fixtures.ts";

/**
 * Fixtures for connection requests, rule changes and multi-step tasks.
 * Coverage is computed by heel's own `coverage()` from a real rules file and
 * the service's real tool list, so the preview shows what the page would.
 */

const minutes = (n: number): Date => new Date(NOW.getTime() + n * 60_000);
const days = (n: number): Date => minutes(n * 24 * 60);
const form = (action: string): FormTarget => ({ action, csrfToken: "preview-csrf-token" });

/** The rules `heel init` writes. */
const STARTER = `rules:
  - name: reads
    match: { kind: read }
    then: allow

  - name: everything-else-asks
    match: {}
    then: ask
`;

/** A longer rules file, with a rule name long enough to wrap. */
const BUSY = `rules:
  - name: reads
    match: { kind: read }
    then: allow
  - name: never-merge-into-production-branches-without-a-human-looking-at-the-diff-first
    match: { tool: merge_pull_request }
    then: deny
  - name: everything-else-asks
    match: {}
    then: ask
`;

function rules(text: string) {
  const owner = compileRulesText(text, "owner.yaml", "rules/owner.yaml", "owner").file;
  return { org: null, owners: new Map([["michael", owner]]) };
}

function covered(text: string, agent: string, details: ConnectionRequestDetails) {
  return coverage(rules(text), "michael", agent, details, {
    grants: [],
    mode: "enforce",
    actions: serviceActions(details.provider),
  });
}

const GITHUB_HINT =
  "A fine-grained token with only the repositories and permissions the agent needs. (gh auth token works too, but gives everything your gh login can do.)";

export const GITHUB_REQUEST: RequestPageProps = {
  id: "req_01JD8Q4W9ZK3M2N5P7R8S0T1V2",
  agent: "claude-code-heel",
  status: "pending",
  service: "GitHub",
  provider: "github",
  alias: "github",
  url: null,
  oauth: false,
  why: "To read the open PRs in tambo-ai/charming and comment on the failing one.",
  createdAt: minutes(-3),
  expiresAt: days(7),
  decision: null,
  now: NOW,
  coverage: covered(STARTER, "claude-code-heel", { provider: "github", alias: "github" }),
  problem: null,
  setup: null,
  hash: "b3f1c0a9d84e27f6a1c5e9d0b7f2a3c4",
  reject: form("/requests/req_01JD8Q4W9ZK3M2N5P7R8S0T1V2/reject"),
  signIn: null,
  outcome: null,
  key: { hint: GITHUB_HINT },
};

const MCP_URL = "https://mcp.example.com/mcp";
export const MCP_REQUEST: RequestPageProps = {
  ...GITHUB_REQUEST,
  id: "req_01JD8Q5MCP0000000000000001",
  service: "the MCP server at mcp.example.com",
  provider: "mcp",
  alias: "tracker",
  url: MCP_URL,
  oauth: true,
  why: "To file the bugs we found today in your tracker.",
  coverage: covered(STARTER, "claude-code-heel", {
    provider: "mcp",
    alias: "tracker",
    url: MCP_URL,
  }),
  key: null,
};

const LONG_ALIAS = "a234567890-b234567890-c234567890-d234567890-e234567890-f23456789";
const LONG_AGENT = "claude-code-on-michaels-work-laptop-in-the-tambo-monorepo";
const LONG_URL =
  "https://mcp.internal-tools.example-company-with-a-long-name.com/v2/servers/issue-tracker/mcp?workspace=engineering-platform-team&region=eu-west-1";

/** The longest realistic strings: a 64-character alias, a long agent name, URL and rule name. */
export const STRESS_REQUEST: RequestPageProps = {
  ...GITHUB_REQUEST,
  id: "req_01JD8Q5STRESS00000000000001",
  agent: LONG_AGENT,
  alias: LONG_ALIAS,
  why: "I need to read and comment on pull requests across every repository in the organization so I can triage the review queue every morning before standup.",
  coverage: covered(BUSY, LONG_AGENT, { provider: "github", alias: LONG_ALIAS }),
};

export const STRESS_MCP_REQUEST: RequestPageProps = {
  ...MCP_REQUEST,
  id: "req_01JD8Q5STRESSMCP000000000001",
  agent: LONG_AGENT,
  alias: LONG_ALIAS,
  service: "the MCP server at mcp.internal-tools.example-company-with-a-long-name.com",
  url: LONG_URL,
  coverage: covered(BUSY, LONG_AGENT, { provider: "mcp", alias: LONG_ALIAS, url: LONG_URL }),
};

export const CONNECTED_REQUEST: RequestPageProps = {
  ...GITHUB_REQUEST,
  status: "approved",
  decision: { by: "michael", at: minutes(-1) },
  outcome: "approved",
};

export const SIGN_IN_REQUEST: RequestPageProps = {
  ...GITHUB_REQUEST,
  id: "req_01JD8Q5GMAIL0000000000001",
  service: "Gmail",
  provider: "gmail",
  alias: "personal",
  status: "approved",
  decision: { by: "michael", at: minutes(-1) },
  coverage: covered(STARTER, "claude-code-heel", { provider: "gmail", alias: "personal" }),
  signIn: form("/connections/sign-in"),
  outcome: "approved",
  key: null,
};

export const REJECTED_REQUEST: RequestPageProps = {
  ...GITHUB_REQUEST,
  status: "rejected",
  decision: { by: "michael", at: minutes(-1) },
  outcome: "rejected",
};

export const TAKEN_REQUEST: RequestPageProps = {
  ...GITHUB_REQUEST,
  problem:
    "This heel already has an account named github. Reject this and ask the agent for another name.",
};

export const REQUEST_CARDS: readonly RequestCard[] = [
  {
    id: GITHUB_REQUEST.id,
    agent: "claude-code-heel",
    service: "GitHub",
    provider: "github",
    alias: "github",
    why: GITHUB_REQUEST.why,
    createdAt: minutes(-3),
    expiresAt: days(7),
  },
  {
    id: STRESS_MCP_REQUEST.id,
    agent: LONG_AGENT,
    service: STRESS_MCP_REQUEST.service,
    provider: "mcp",
    alias: LONG_ALIAS,
    why: null,
    createdAt: minutes(-40),
    expiresAt: days(6),
  },
];

const DIFF =
  "  rules:\n+   - name: vendor-mail\n+     match: { action: email.send, recipients: { all_domain_in: [vendor.com] } }\n+     then: allow\n    - name: reads\n      match: { kind: read }\n      then: allow\n";

export const PROPOSAL: ProposalPageProps = {
  id: "prp_01JD8Q6VENDOR0000000000001",
  agent: "inbox-bot",
  status: "pending",
  reason: "So I can answer the vendor thread without asking you each time.",
  origin: "agent",
  file: "rules/michael.yaml",
  rules: [
    {
      yaml: "name: vendor-mail\nmatch: { action: email.send, recipients: { all_domain_in: [vendor.com] } }\nthen: allow",
      words:
        "inbox-bot may send email on any of your accounts without asking you, when every recipient is at vendor.com.",
      why: "Bob and the vendor team are the only people on that thread.",
    },
  ],
  hide: [],
  workdirs: [],
  createdAt: minutes(-8),
  expiresAt: days(7),
  decision: null,
  now: NOW,
  effect: {
    ok: true,
    sha: "9c1e7a",
    existing: 2,
    existingNames: ["reads", "everything-else-asks"],
    diff: DIFF,
  },
  reject: form("/proposals/prp_01JD8Q6VENDOR0000000000001/reject"),
  outcome: null,
};

const LONG_RULE =
  "never-merge-into-production-branches-without-a-human-looking-at-the-diff-first-and-signing-off";

export const STRESS_PROPOSAL: ProposalPageProps = {
  ...PROPOSAL,
  id: "prp_01JD8Q6STRESS00000000000001",
  agent: LONG_AGENT,
  file: "rules/michael-on-the-work-laptop-with-a-long-file-name.yaml",
  rules: [
    {
      yaml: `name: ${LONG_RULE}\nmatch: { tool: merge_pull_request, repo: tambo-ai/charming-with-an-unreasonably-long-repository-name }\nthen: ask`,
      words: `${LONG_AGENT} must ask you before merging a pull request in tambo-ai/charming-with-an-unreasonably-long-repository-name.`,
      why: null,
    },
  ],
  effect: {
    ok: true,
    sha: "9c1e7b",
    existing: 3,
    existingNames: ["reads", LONG_RULE, "everything-else-asks"],
    placedBefore: { rule: LONG_RULE, above: 1 },
    diff: DIFF,
  },
};

export const APPLIED_PROPOSAL: ProposalPageProps = {
  ...PROPOSAL,
  status: "applied",
  decision: { by: "michael", at: minutes(-1) },
  outcome: "applied",
};

export const PROPOSAL_CARDS: readonly ProposalCard[] = [
  {
    id: PROPOSAL.id,
    agent: "inbox-bot",
    rules: 1,
    hide: 0,
    workdirs: 0,
    reason: PROPOSAL.reason,
    origin: "agent",
    createdAt: minutes(-8),
    expiresAt: days(7),
  },
  {
    id: "prp_01JD8Q6HEEL00000000000001",
    agent: LONG_AGENT,
    rules: 2,
    hide: 0,
    workdirs: 0,
    reason: null,
    origin: "heel",
    createdAt: minutes(-90),
    expiresAt: days(6),
  },
];

/** A run_code task at step 3, after two steps that ran. */
export const TASK_REQUEST: ApprovalRequestView = {
  ...PENDING_REQUEST,
  id: "apr_Task3kP9xVb3",
  agent: "claude-code-heel",
  account: "personal",
  reason: "Approval-flow test: save a draft addressed to the owner's own address. Nothing is sent.",
  tool: "create_draft",
  action: "email.draft",
  email: {
    ...(PENDING_REQUEST.email as NonNullable<ApprovalRequestView["email"]>),
    to: ["michael@example.com"],
    cc: [],
    subject: "Approval-flow test",
    body: "Testing heel's approval flow. Nothing is sent.",
    attachments: [],
  },
  args: {
    from: "michael@example.com",
    to: ["michael@example.com"],
    subject: "Approval-flow test",
    body: "Testing heel's approval flow. Nothing is sent.",
  },
  script: {
    code: 'import personal\nme = personal.list_send_as()[0]\nhits = personal.search(query="from:me newer_than:1d")\npersonal.create_draft(from_=me, to=[me], subject="Approval-flow test", body="Testing heel\'s approval flow. Nothing is sent.")',
    truncated: false,
    before: [
      { account: "personal", tool: "list_send_as", decision: "allow" },
      { account: "personal", tool: "search", decision: "allow" },
    ],
  },
};
