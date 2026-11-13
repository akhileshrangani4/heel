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
import { PAUSE_SCOPES, type PauseScope, type RuleRef, type Surface } from "../core/call.ts";

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
    createdAt: createdAt(),
    /** A revoked agent's tokens stop working on the next call. */
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (t) => [uniqueIndex("agents_org_name").on(t.orgId, t.name)],
);

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
    call: text("call", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
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

export const STANDING_SCOPES = ["exact_call", "rule"] as const;
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
  (t) => [primaryKey({ columns: [t.orgId, t.scope, t.target] })],
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
        ELSE 0
      END`,
    ),
  ],
);
