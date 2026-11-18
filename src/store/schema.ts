import { sql } from "drizzle-orm";
import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { AUDIT_KINDS } from "../core/audit.ts";
import {
  type Call,
  PAUSE_SCOPES,
  type PauseScope,
  type RuleRef,
  type Surface,
} from "../core/call.ts";
import { MODES, type Mode } from "../core/modes.ts";

/**
 * heel's SQLite schema (spec: Architecture; Teams, "Data model"). Every row
 * carries `org_id`, and every agent and account carries `owner_id`: v1 has one
 * org per install, but the schema never assumes it.
 *
 * Times are integer milliseconds since the epoch. Ids are prefixed random
 * strings (see ids.ts) so they are safe to show and never guessable.
 */

const createdAt = () => integer("created_at", { mode: "timestamp_ms" }).notNull();

// ── identity ────────────────────────────────────────────────────────────────

export const orgs = sqliteTable("orgs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const USER_ROLES = ["admin", "member"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    name: text("name").notNull(),
    /** The IdP subject when OIDC is configured (D13); null on single-user installs. */
    oidcSubject: text("oidc_subject"),
    role: text("role", { enum: USER_ROLES }).notNull(),
    /** Where email and Slack notifications reach this person; null until set. */
    email: text("email"),
    /** IdP groups as of the person's last OIDC sign-in (D13b); empty on single-user installs. */
    groups: text("groups", { mode: "json" }).$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    disabledAt: integer("disabled_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("users_org_name").on(t.orgId, t.name),
    uniqueIndex("users_oidc_subject").on(t.oidcSubject),
  ],
);

export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    /** Set for an agent created by connecting an OAuth client (A2); reused when it connects again. */
    oauthClientId: text("oauth_client_id"),
    /**
     * Absolute directories `heel run` may use as its working directory (D8b;
     * spec: CLI runner, "Same host"). Empty: the agent can't run commands.
     */
    workRoots: text("work_roots", { mode: "json" }).$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    /** A revoked agent's tokens stop working on the next call. */
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (t) => [uniqueIndex("agents_org_name").on(t.orgId, t.name)],
);

/**
 * How an agent token was issued. A static token (`heel agent add`) never
 * expires. OAuth access tokens are short-lived; refresh tokens only ever buy
 * a new pair at the token endpoint and never authenticate a call.
 */
export const AGENT_TOKEN_KINDS = ["static", "oauth_access", "oauth_refresh"] as const;
export type AgentTokenKind = (typeof AGENT_TOKEN_KINDS)[number];

/** Agent bearer tokens. Only the SHA-256 of the token is ever stored (I-03). */
export const agentTokens = sqliteTable(
  "agent_tokens",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    /** Lower-case hex SHA-256 of the full token string. */
    tokenHash: text("token_hash").notNull(),
    kind: text("kind", { enum: AGENT_TOKEN_KINDS }).notNull().default("static"),
    /** Null for a static token. */
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("agent_tokens_hash").on(t.tokenHash),
    index("agent_tokens_agent").on(t.agentId),
  ],
);

export const ACCOUNT_STATUSES = ["active", "reconnect_required"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    /** The name agents and rules use, e.g. "gmail-work". */
    alias: text("alias").notNull(),
    provider: text("provider").notNull(),
    /** Non-secret settings (base URL, upstream command, …). Secrets live in `credentials`. */
    settings: text("settings", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    status: text("status", { enum: ACCOUNT_STATUSES }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("accounts_org_alias").on(t.orgId, t.alias)],
);

/**
 * Encrypted credentials (I-02). Envelope encryption: `ciphertext` is sealed
 * with a per-row data key, and `wrapped_key` is that data key sealed with the
 * master key version `key_version`. Both seals bind the row's identity as
 * associated data, so rows cannot be swapped between accounts.
 */
export const credentials = sqliteTable(
  "credentials",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    keyVersion: integer("key_version").notNull(),
    wrappedKey: blob("wrapped_key", { mode: "buffer" }).notNull(),
    ciphertext: blob("ciphertext", { mode: "buffer" }).notNull(),
    /** Plaintext so refresh can be scheduled without decrypting; null when it never expires. */
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("credentials_account").on(t.accountId)],
);

/**
 * One row per master key version: a known value sealed with that key. Boot
 * opens it to prove the configured key is the one the credentials were
 * written with; a mismatch keeps the agent plane down.
 */
export const vaultKeys = sqliteTable("vault_keys", {
  version: integer("version").primaryKey(),
  check: blob("check", { mode: "buffer" }).notNull(),
  createdAt: createdAt(),
});

// ── counts ──────────────────────────────────────────────────────────────────

/**
 * One row per call heel let run, written in the decision transaction (spec:
 * Counts and state checks). Kept 7 days; never refunded.
 */
export const countEvents = sqliteTable(
  "count_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    /** Agent-supplied run id; scoped to `agent_id`. */
    runId: text("run_id"),
    /** The call's plain rule fields (account, action, repo, …) that count conditions match on. */
    fields: text("fields", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    items: integer("items").notNull(),
    at: integer("at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("count_events_agent_at").on(t.agentId, t.at),
    index("count_events_agent_run").on(t.agentId, t.runId),
  ],
);

// ── approvals ───────────────────────────────────────────────────────────────

export const APPROVAL_STATUSES = ["pending", "approved", "denied", "expired", "executed"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** Which rule layer asked: org asks go to admins and never stand (Q-A7). */
export const APPROVAL_ORIGINS = ["org", "owner"] as const;
export type ApprovalOrigin = (typeof APPROVAL_ORIGINS)[number];

export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    runId: text("run_id"),
    /** sha256(JCS({agentId, account, tool, args})): what makes two calls "the same call". */
    callHash: text("call_hash").notNull(),
    account: text("account").notNull(),
    tool: text("tool").notNull(),
    /** The normalized call, exactly as it will run if approved. */
    call: text("call", { mode: "json" }).$type<Call>().notNull(),
    origin: text("origin", { enum: APPROVAL_ORIGINS }).notNull(),
    rule: text("rule", { mode: "json" }).$type<RuleRef>().notNull(),
    /** Content hash of the rule that asked; a re-run is satisfied only by an ask from it. */
    ruleHash: text("rule_hash").notNull(),
    status: text("status", { enum: APPROVAL_STATUSES }).notNull(),
    createdAt: createdAt(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
    decidedBy: text("decided_by").references(() => users.id),
    executedAt: integer("executed_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    index("approvals_call_hash").on(t.callHash),
    // Re-sending a pending call joins it (I-51), so at most one is pending.
    uniqueIndex("approvals_one_pending_per_call").on(t.callHash).where(sql`status = 'pending'`),
    index("approvals_status_expires").on(t.status, t.expiresAt),
  ],
);

export const STANDING_SCOPES = ["exact_call", "rule", "run"] as const;
export type StandingScope = (typeof STANDING_SCOPES)[number];

/**
 * Standing approvals live here, never in YAML (spec: Standing approvals).
 * Each is bound to its parent rule's content hash and lapses when it changes.
 */
export const standingApprovals = sqliteTable(
  "standing_approvals",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    /** The approval it was granted from. */
    approvalId: text("approval_id")
      .notNull()
      .references(() => approvals.id),
    scope: text("scope", { enum: STANDING_SCOPES }).notNull(),
    /** Set for `exact_call`: the account, tool and arguments it covers. */
    callHash: text("call_hash"),
    /** Set for `run` (A4): the agent's run id it covers. */
    runId: text("run_id"),
    rule: text("rule", { mode: "json" }).$type<RuleRef>().notNull(),
    ruleHash: text("rule_hash").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    revokedBy: text("revoked_by").references(() => users.id),
  },
  (t) => [index("standing_approvals_agent_rule").on(t.agentId, t.ruleHash)],
);

/**
 * Intent grants (A4b): narrow allows a person signed with a passkey for one
 * agent and one stated task, enforced like a rule above the owner's own.
 */
export const grants = sqliteTable(
  "grants",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    /** The task, in the owner's words. */
    task: text("task").notNull(),
    /** One `match` in the rules language, as signed. */
    match: text("match").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    revokedBy: text("revoked_by").references(() => users.id),
  },
  (t) => [index("grants_agent").on(t.agentId)],
);

// ── pause ───────────────────────────────────────────────────────────────────

/**
 * Active pauses. A row means "paused" and resume deletes it. `target` is the
 * agent id, account alias or provider, and "" for the global scope.
 */
export const pauses = sqliteTable(
  "pauses",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    scope: text("scope").$type<PauseScope>().notNull(),
    target: text("target").notNull(),
    pausedBy: text("paused_by").notNull(),
    pausedAt: integer("paused_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.scope, t.target] }),
    check("pauses_scope", sql`"scope" IN (${sqlList(PAUSE_SCOPES)})`),
    // The global pause has no target; every other scope names one.
    check("pauses_target", sql`("scope" = 'global') = ("target" = '')`),
  ],
);

// ── rollout modes ───────────────────────────────────────────────────────────

/**
 * Rollout modes set on the human plane (A3): one row for the org's default
 * (`owner_id` empty) and one per owner who has their own. With no row the
 * mode is `enforce`, or `shadow` under `heel serve --watch`. The strictest
 * row that applies wins.
 */
export const modes = sqliteTable(
  "modes",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    /** Empty for the org-wide default. */
    ownerId: text("owner_id").notNull(),
    mode: text("mode").$type<Mode>().notNull(),
    setBy: text("set_by").notNull(),
    setAt: integer("set_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.ownerId] }),
    check("modes_mode", sql`"mode" IN (${sqlList(MODES)})`),
  ],
);

/** Every mode switch, in order: who changed what, from what, and when. */
export const modeChanges = sqliteTable(
  "mode_changes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    ownerId: text("owner_id").notNull(),
    from: text("from_mode").$type<Mode>().notNull(),
    to: text("to_mode").$type<Mode>().notNull(),
    changedBy: text("changed_by").notNull(),
    changedAt: integer("changed_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("mode_changes_org_at").on(t.orgId, t.changedAt)],
);

// ── passkeys and sessions ───────────────────────────────────────────────────

/**
 * Enrolled WebAuthn credentials (spec: The approval page). Enrollment runs
 * only from a one-time link printed over the admin socket (Q-N2).
 */
export const passkeys = sqliteTable(
  "passkeys",
  {
    /** The credential id, base64url, as the authenticator reports it. */
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    /** COSE public key. */
    publicKey: blob("public_key", { mode: "buffer" }).notNull(),
    /** Signature counter; an assertion that doesn't advance a nonzero counter is refused. */
    counter: integer("counter").notNull(),
    transports: text("transports", { mode: "json" }).$type<string[]>().notNull(),
    createdAt: createdAt(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("passkeys_user").on(t.userId)],
);

export const CHALLENGE_PURPOSES = [
  "enroll",
  "sign_in",
  "decide",
  "resume",
  "connect",
  "mode",
  "grant",
] as const;
export type ChallengePurpose = (typeof CHALLENGE_PURPOSES)[number];

/**
 * One-time WebAuthn challenges. The challenge bytes are a hash over a random
 * nonce and the canonical `binding`, so an assertion proves the person saw
 * and confirmed exactly that decision (I-56). Each is used at most once.
 */
export const webauthnChallenges = sqliteTable(
  "webauthn_challenges",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    /** Who must answer; null for sign-in, where the passkey names the person. */
    userId: text("user_id").references(() => users.id),
    purpose: text("purpose", { enum: CHALLENGE_PURPOSES }).notNull(),
    /** base64url challenge the authenticator signs. */
    challenge: text("challenge").notNull(),
    /** What the assertion authorizes, e.g. `{ intent, approvalId, callHash }`. */
    binding: text("binding", { mode: "json" }).$type<Record<string, string>>().notNull(),
    createdAt: createdAt(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    usedAt: integer("used_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("webauthn_challenges_challenge").on(t.challenge),
    index("webauthn_challenges_expires").on(t.expiresAt),
  ],
);

/** One-time enrollment links from `heel user enroll` (Q-N2); valid 15 minutes. */
export const enrollments = sqliteTable(
  "enrollments",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    /** SHA-256 of the link token; the token itself is shown once and never stored. */
    tokenHash: text("token_hash").notNull(),
    createdAt: createdAt(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    usedAt: integer("used_at", { mode: "timestamp_ms" }),
  },
  (t) => [uniqueIndex("enrollments_token_hash").on(t.tokenHash)],
);

export const SESSION_METHODS = ["passkey", "oidc"] as const;
export type SessionMethod = (typeof SESSION_METHODS)[number];

/**
 * Human-plane sessions, at most 12 h (spec: Teams). A session lets a person
 * see requests, pause and revoke; it never decides anything on its own.
 */
export const sessions = sqliteTable(
  "sessions",
  {
    /** SHA-256 of the cookie value; the cookie itself is never stored. */
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    method: text("method", { enum: SESSION_METHODS }).notNull(),
    /** Echoed by every plain form post (pause, revoke). */
    csrfToken: text("csrf_token").notNull(),
    createdAt: createdAt(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("sessions_user").on(t.userId)],
);

/**
 * OIDC sign-ins in progress (D13b): what heel must check when the person
 * comes back from the IdP. Keyed by the hash of a random cookie set on the
 * browser that started the sign-in, so a callback only completes in that
 * browser (no login CSRF), and used once.
 */
export const oidcSignIns = sqliteTable("oidc_sign_ins", {
  /** SHA-256 of the binding cookie's value. */
  id: text("id").primaryKey(),
  state: text("state").notNull(),
  nonce: text("nonce").notNull(),
  codeVerifier: text("code_verifier").notNull(),
  /** Where to go after signing in: a path on this site. */
  next: text("next").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
});

// ── OAuth for cloud connectors (A2) ─────────────────────────────────────────

/**
 * Clients registered through dynamic client registration (RFC 7591): Claude,
 * ChatGPT, Grok and other MCP hosts adding heel as a custom connector. They
 * are public clients (no secret), so every code exchange needs PKCE.
 */
export const oauthClients = sqliteTable("oauth_clients", {
  id: text("id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => orgs.id),
  /** What the client calls itself, e.g. "Claude"; shown on the consent page, never trusted. */
  name: text("name").notNull(),
  redirectUris: text("redirect_uris", { mode: "json" }).$type<string[]>().notNull(),
  createdAt: createdAt(),
});

/** One-time authorization codes, kept only as hashes, valid for a minute. */
export const oauthCodes = sqliteTable("oauth_codes", {
  codeHash: text("code_hash").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => orgs.id),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClients.id),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id),
  redirectUri: text("redirect_uri").notNull(),
  /** The PKCE S256 challenge the token request's verifier must match. */
  codeChallenge: text("code_challenge").notNull(),
  createdAt: createdAt(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  usedAt: integer("used_at", { mode: "timestamp_ms" }),
});

// ── notifications ───────────────────────────────────────────────────────────

/** Web push subscriptions from the installable approval page (spec: Notifications). */
export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    endpoint: text("endpoint").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("push_subscriptions_user").on(t.userId)],
);

export const NOTIFY_CHANNELS = ["web_push", "email", "slack"] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

export const DELIVERY_STATUSES = ["pending", "sent", "failed", "dropped"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/**
 * The notification outbox (spec: Fail-closed, "The notification channel
 * fails"). A new approval request gets one row per approver and channel;
 * the notifier sends due rows and retries with backoff. A failed delivery
 * never changes the request: it stays pending and listed on the page.
 *
 * - `sent`: delivered to the channel.
 * - `failed`: gave up after the last retry.
 * - `dropped`: no longer worth sending (the request was decided or expired,
 *   or the push subscription is gone).
 */
export const notificationDeliveries = sqliteTable(
  "notification_deliveries",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    approvalId: text("approval_id")
      .notNull()
      .references(() => approvals.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    channel: text("channel", { enum: NOTIFY_CHANNELS }).notNull(),
    /** The push endpoint or email address. */
    target: text("target").notNull(),
    status: text("status", { enum: DELIVERY_STATUSES }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }).notNull(),
    /** Why the last attempt failed: a short code or status, never message content. */
    lastError: text("last_error"),
    createdAt: createdAt(),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("notification_deliveries_once").on(t.approvalId, t.userId, t.channel, t.target),
    index("notification_deliveries_due").on(t.status, t.nextAttemptAt),
    check("notification_deliveries_channel", sql`"channel" IN (${sqlList(NOTIFY_CHANNELS)})`),
    check("notification_deliveries_status", sql`"status" IN (${sqlList(DELIVERY_STATUSES)})`),
  ],
);

// ── audit ───────────────────────────────────────────────────────────────────

/** SQL list literal for an `IN (…)` check, from a const list of plain identifiers. */
function sqlList(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value}'`).join(", "));
}

/**
 * The append-only decision log (I-73). The code has no update or delete path,
 * and triggers in the migrations abort any UPDATE or DELETE.
 *
 * The CHECK constraints mirror `AuditEvent` in core/audit.ts: each kind's row
 * must carry the rule, approval or approver that makes it complete.
 */
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    at: integer("at", { mode: "timestamp_ms" }).notNull(),
    kind: text("kind", { enum: AUDIT_KINDS }).notNull(),
    agentId: text("agent_id").notNull(),
    ownerId: text("owner_id").notNull(),
    runId: text("run_id"),
    surface: text("surface").$type<Surface>().notNull(),
    account: text("account").notNull(),
    provider: text("provider").notNull(),
    tool: text("tool").notNull(),
    action: text("action"),
    args: text("args", { mode: "json" }).$type<unknown>().notNull(),
    callHash: text("call_hash").notNull(),
    rule: text("rule", { mode: "json" }).$type<RuleRef>(),
    approvalId: text("approval_id"),
    standingApprovalId: text("standing_approval_id"),
    approverId: text("approver_id"),
    pauseScope: text("pause_scope").$type<PauseScope>(),
    reason: text("reason"),
    /** For a would-* row, the rollout mode that let the call run (A3). Empty means enforce. */
    mode: text("mode").$type<Mode>(),
    adapter: text("adapter"),
  },
  (t) => [
    index("audit_log_org_at").on(t.orgId, t.at),
    index("audit_log_agent_at").on(t.agentId, t.at),
    index("audit_log_approval").on(t.approvalId),
    check("audit_log_kind", sql`"kind" IN (${sqlList(AUDIT_KINDS)})`),
    check(
      "audit_log_pause_scope",
      sql`"pause_scope" IS NULL OR "pause_scope" IN (${sqlList(PAUSE_SCOPES)})`,
    ),
    check("audit_log_args_json", sql`json_valid("args")`),
    check(
      "audit_log_complete",
      sql`CASE "kind"
        WHEN 'allow' THEN "rule" IS NOT NULL
        WHEN 'deny' THEN "reason" IS NOT NULL
        WHEN 'ask' THEN "rule" IS NOT NULL AND "approval_id" IS NOT NULL
        WHEN 'paused' THEN "pause_scope" IS NOT NULL
        WHEN 'expired' THEN "approval_id" IS NOT NULL
        WHEN 'approved' THEN "approval_id" IS NOT NULL AND "approver_id" IS NOT NULL
        WHEN 'approval_denied' THEN "approval_id" IS NOT NULL AND "approver_id" IS NOT NULL
        WHEN 'executed' THEN "approval_id" IS NOT NULL
        WHEN 'would_allow' THEN "rule" IS NOT NULL
        WHEN 'would_deny' THEN "reason" IS NOT NULL
        WHEN 'would_ask' THEN "rule" IS NOT NULL
        ELSE 0
      END`,
    ),
  ],
);

// ── audit delivery ──────────────────────────────────────────────────────────

/**
 * How far the SIEM sink has delivered (spec: Teams, "Audit"). One row per
 * org and sink URL; it advances only after the sink acknowledged a batch,
 * so a crash or outage re-sends rather than drops. Pointing heel at a new
 * URL starts a new cursor at the beginning of the log.
 */
export const siemCursors = sqliteTable(
  "siem_cursors",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    sink: text("sink").notNull(),
    /** The highest audit_log.id the sink acknowledged; 0 before the first batch. */
    deliveredThroughId: integer("delivered_through_id").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.sink] })],
);
